// Convorum hub: HTTP REST + WebSocket push + long-polling. One hub serves many rooms (one room per project/team).
import http from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Store, findOverlaps, overlaps } from './store.js';
import { registerExtras } from './extras.js';
import { redact } from '../redact.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const ONLINE_MS = 60_000;
const ROOM_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const NAME_RE = /^[a-zA-Z0-9._@-]{1,48}$/;
const MENTION_RE = /@([a-zA-Z0-9._-]+)/g;

export function createHub({ dbFile = '.convorum/hub.db', token = process.env.CONVORUM_TOKEN || null } = {}) {
  const store = new Store(dbFile);
  const waiters = new Map();   // room -> Set<fn(msg)>
  const sockets = new Map();   // room -> Set<ws>
  const hooks = { onPost: [], identifyMember: null, audit: null };

  const withPresence = (m) => ({ ...m, online: Date.now() - m.last_seen < ONLINE_MS });

  function broadcast(room, event) {
    const data = JSON.stringify(event);
    for (const ws of sockets.get(room) ?? []) if (ws.readyState === 1) ws.send(data);
  }

  function post(room, msg) {
    const mentions = msg.mentions?.length ? msg.mentions : [...new Set([...msg.body.matchAll(MENTION_RE)].map((x) => x[1]))];
    const { text, found } = redact(msg.body);
    const meta = found.length ? { ...(msg.meta ?? {}), redacted: found } : msg.meta;
    const saved = store.addMessage({ ...msg, body: text, meta, room, mentions });
    broadcast(room, { event: 'message', message: saved });
    for (const w of waiters.get(room) ?? []) w(saved);
    for (const h of hooks.onPost) { try { h(room, saved); } catch (e) { console.error(e); } }
    return saved;
  }

  const system = (room, body, meta = {}) => post(room, { sender: 'convorum', sender_kind: 'system', type: 'status', body, meta });
  const roomEvent = (room, event, payload) => broadcast(room, { event, ...payload });

  function touch(room, name, fields) {
    const before = store.member(room, name);
    const wasOnline = before && Date.now() - before.last_seen < ONLINE_MS;
    const { member, isNew } = store.touchMember(room, name, fields);
    if (isNew || !wasOnline) {
      system(room, `${name} joined${member.client ? ` (${member.client}${member.owner ? `, working for ${member.owner}` : ''})` : ''}`, { join: name });
    }
    roomEvent(room, 'members', { members: store.members(room).map(withPresence) });
    return member;
  }

  /** Wait until a message in `room` matches `pred`, or timeout. */
  function waitFor(room, pred, timeoutMs) {
    return new Promise((resolve) => {
      const set = waiters.get(room) ?? new Set();
      waiters.set(room, set);
      const done = (val) => { clearTimeout(t); set.delete(fn); resolve(val); };
      const fn = (m) => { if (pred(m)) done(m); };
      const t = setTimeout(() => done(null), timeoutMs);
      set.add(fn);
    });
  }

  // ------------------------------------------------------------------ routes
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  route('GET', '/api/health', () => ({ ok: true, name: 'convorum', version: 1 }));
  route('GET', '/api/rooms', ({ admin }) => {
    if (!admin) throw httpError(403, 'room listing needs the hub admin token');
    return { rooms: store.rooms() };
  });
  route('POST', '/api/rooms', ({ body }) => {
    need(body, 'room');
    if (!ROOM_RE.test(body.room)) throw httpError(400, 'room names may contain letters, digits, . _ - (max 64)');
    if (store.roomInfo(body.room) || store.maxId(body.room) > 0) throw httpError(409, `room "${body.room}" already exists, pick another name`);
    const key = 'cvk_' + randomBytes(18).toString('base64url');
    store.createRoom(body.room, hashKey(key), body.created_by);
    return { room: body.room, key };
  });

  route('GET', '/api/rooms/:room/state', ({ room, me }) => ({
    room,
    members: store.members(room).map(withPresence),
    claims: store.claims(room),
    tasks: store.tasks(room),
    unread: me ? unreadFor(room, me).length : undefined,
  }));

  route('POST', '/api/rooms/:room/join', ({ room, body }) => {
    need(body, 'name'); validName(body.name);
    const cur = store.member(room, body.name);
    if (body.session && cur?.session && cur.session !== body.session && Date.now() - cur.last_seen < ONLINE_MS && cur.status !== 'offline') {
      throw httpError(409, `name "${body.name}" is in use by another live session`);
    }
    const member = touch(room, body.name, pick(body, ['kind', 'client', 'owner', 'status', 'working_on']));
    if (body.session) store.setSession(room, body.name, body.session);
    return { member, last_id: store.maxId(room) };
  });

  route('POST', '/api/rooms/:room/heartbeat', ({ room, body }) => {
    need(body, 'name');
    const before = store.member(room, body.name);
    const wasOnline = before && Date.now() - before.last_seen < ONLINE_MS;
    if (!wasOnline) return { member: touch(room, body.name, pick(body, ['kind', 'client', 'owner'])) };
    store.touchMember(room, body.name, {});
    return { ok: true };
  });

  route('POST', '/api/rooms/:room/status', ({ room, body }) => {
    need(body, 'name');
    const m = touch(room, body.name, pick(body, ['status', 'working_on']));
    if (body.announce !== false) {
      post(room, { sender: body.name, sender_kind: m.kind, type: 'status',
        body: `status → ${m.status}${m.working_on ? `: ${m.working_on}` : ''}` });
    }
    return { member: m };
  });

  route('POST', '/api/rooms/:room/leave', ({ room, body }) => {
    need(body, 'name');
    const released = store.release(room, body.name);
    store.clearEdits(room, body.name);
    store.touchMember(room, body.name, { status: 'offline' });
    system(room, `${body.name} left${released ? ` (released ${released} file claim${released > 1 ? 's' : ''})` : ''}`);
    roomEvent(room, 'members', { members: store.members(room).map(withPresence) });
    roomEvent(room, 'claims', { claims: store.claims(room) });
    return { ok: true };
  });

  route('GET', '/api/rooms/:room/messages', async ({ room, query }) => {
    const after = Number(query.after ?? 0);
    const limit = Math.min(Number(query.limit ?? 100), 500);
    if (query.q) return { messages: store.search(room, query.q, limit) };
    if (query.before) return { messages: store.messages(room, { before: Number(query.before), limit }) };
    let messages = store.messages(room, { after, limit });
    const wait = Math.min(Number(query.wait ?? 0), 300);
    if (messages.length === 0 && wait > 0 && after > 0) {
      const m = await waitFor(room, (x) => x.id > after, wait * 1000);
      messages = m ? store.messages(room, { after, limit }) : [];
    }
    return { messages };
  });

  route('POST', '/api/rooms/:room/messages', ({ room, body }) => {
    need(body, 'sender', 'body'); validName(body.sender);
    if (body.reply_to && !store.message(body.reply_to)) throw httpError(400, `reply_to ${body.reply_to} not found`);
    const m = store.member(room, body.sender);
    if (!m) touch(room, body.sender, { kind: body.sender_kind ?? 'agent', client: body.client, owner: body.owner });
    else store.touchMember(room, body.sender, {});
    const msg = post(room, {
      sender: body.sender,
      sender_kind: body.sender_kind ?? m?.kind ?? 'agent',
      type: body.type ?? 'chat',
      body: String(body.body).slice(0, 20_000),
      mentions: body.mentions ?? [],
      reply_to: body.reply_to ?? null,
      meta: body.meta ?? {},
    });
    store.setLastRead(room, body.sender, msg.id); // you've "read" your own message
    return { message: msg };
  });

  /** Unread inbox for a member: everything since their read cursor, excluding their own messages. */
  function unreadFor(room, name) {
    const m = store.member(room, name);
    if (!m) return [];
    return store.messages(room, { after: m.last_read, limit: 500 }).filter((x) => x.sender !== name);
  }

  route('GET', '/api/rooms/:room/inbox', async ({ room, query }) => {
    need(query, 'name');
    const name = query.name;
    if (!store.member(room, name)) touch(room, name, { kind: query.kind ?? 'agent', client: query.client });
    store.touchMember(room, name, {});
    let msgs = unreadFor(room, name);
    const wait = Math.min(Number(query.wait ?? 0), 300);
    const mentionsOnly = query.mentions_only === '1' || query.mentions_only === 'true';
    const relevant = (x) => x.sender !== name && x.sender_kind !== 'system' &&
      (!mentionsOnly || x.mentions.includes(name) || x.mentions.includes('all') || x.mentions.includes('everyone'));
    if (!msgs.some(relevant) && wait > 0) {
      await waitFor(room, relevant, wait * 1000);
      msgs = unreadFor(room, name);
    }
    if (query.peek !== '1' && msgs.length) store.setLastRead(room, name, msgs.at(-1).id);
    return { messages: msgs, mentions: msgs.filter((x) => x.mentions.includes(name)).length };
  });

  /** Ask a question and block until someone replies to it (reply_to = question id). */
  route('POST', '/api/rooms/:room/ask', async ({ room, body }) => {
    need(body, 'sender', 'body');
    const to = [].concat(body.to ?? []);
    const text = to.length ? `${to.map((t) => '@' + t).join(' ')} ${body.body}` : body.body;
    const q = post(room, { sender: body.sender, sender_kind: body.sender_kind ?? 'agent', type: body.type === 'request' ? 'request' : 'question', body: text, mentions: to });
    store.setLastRead(room, body.sender, q.id);
    const wait = Math.min(Number(body.wait ?? 120), 600);
    const answer = await waitFor(room, (m) => m.reply_to === q.id && m.sender !== body.sender, wait * 1000);
    return { question: q, answer };
  });

  route('GET', '/api/rooms/:room/thread/:id', ({ room, params }) => {
    const root = store.message(Number(params.id));
    if (!root || root.room !== room) throw httpError(404, 'not found');
    const replies = store.db.prepare('SELECT id FROM messages WHERE reply_to = ? ORDER BY id').all(root.id).map((r) => store.message(r.id));
    return { root, replies };
  });

  // -------- file claims (soft locks so two agents don't edit the same files)
  route('GET', '/api/rooms/:room/claims', ({ room }) => ({ claims: store.claims(room) }));
  route('POST', '/api/rooms/:room/claims', ({ room, body }) => {
    need(body, 'owner', 'paths');
    const res = store.claim(room, body.owner, body.paths, body.note);
    if (res.claimed.length) post(room, { sender: body.owner, type: 'status', body: `🔒 claimed ${res.claimed.join(', ')}${body.note ? ` — ${body.note}` : ''}`, meta: { claim: res.claimed } });
    for (const c of res.conflicts) {
      post(room, { sender: body.owner, type: 'alert', mentions: [c.held_by],
        body: `@${c.held_by} I need ${c.path} but you hold ${c.held_path}${c.note ? ` (${c.note})` : ''}. Can you release it when you're done?` });
    }
    roomEvent(room, 'claims', { claims: store.claims(room) });
    return res;
  });
  route('POST', '/api/rooms/:room/claims/release', ({ room, body }) => {
    need(body, 'owner');
    const n = store.release(room, body.owner, body.paths);
    if (n) post(room, { sender: body.owner, type: 'status', body: `🔓 released ${body.paths?.length ? body.paths.join(', ') : 'all my claims'}` });
    roomEvent(room, 'claims', { claims: store.claims(room) });
    return { released: n };
  });
  route('POST', '/api/rooms/:room/claims/check', ({ room, body }) => {
    need(body, 'paths');
    return { results: store.checkPaths(room, body.paths, body.name) };
  });

  // -------- shared task board
  route('GET', '/api/rooms/:room/tasks', ({ room, query }) => ({ tasks: store.tasks(room, query.status) }));
  route('POST', '/api/rooms/:room/tasks', ({ room, body }) => {
    need(body, 'title', 'created_by');
    const t = store.createTask(room, body);
    post(room, { sender: body.created_by, type: 'status', body: `📋 new task #${t.id}: ${t.title}${t.owner ? ` (→ ${t.owner})` : ''}`, meta: { task: t.id } });
    roomEvent(room, 'tasks', { tasks: store.tasks(room) });
    return { task: t };
  });
  route('PATCH', '/api/rooms/:room/tasks/:id', ({ room, body, params }) => {
    const id = Number(params.id);
    const cur = store.task(id);
    if (!cur || cur.room !== room) throw httpError(404, `task ${id} not found`);
    if (body.claim) {
      if (cur.owner && cur.owner !== body.by && cur.status !== 'done') throw httpError(409, `task #${id} already owned by ${cur.owner}`);
      body.owner = body.by; body.status = 'in_progress';
    }
    const t = store.updateTask(id, pick(body, ['title', 'description', 'status', 'owner']));
    const verb = body.claim ? 'took' : t.status === 'done' ? '✅ finished' : `updated (${t.status})`;
    post(room, { sender: body.by ?? 'someone', type: 'status', body: `${verb} task #${t.id}: ${t.title}${body.note ? ` — ${body.note}` : ''}`, meta: { task: t.id } });
    roomEvent(room, 'tasks', { tasks: store.tasks(room) });
    return { task: t };
  });

  // -------- team goal: the north star every agent steers toward
  route('GET', '/api/rooms/:room/goal', ({ room }) => ({ goal: store.goal(room) }));
  route('PUT', '/api/rooms/:room/goal', ({ room, body }) => {
    need(body, 'by');
    const prev = store.goal(room);
    const g = store.setGoal(room, { goal: body.goal, milestones: body.milestones, set_by: body.by });
    if (body.goal && body.goal !== prev?.goal) {
      post(room, { sender: body.by, type: 'decision', mentions: ['all'], body: `🎯 Team goal: ${g.goal}`, meta: { goal: true } });
    } else if (body.milestones) {
      const newlyDone = g.milestones.filter((m) => m.done && !prev?.milestones.find((p) => p.title === m.title && p.done));
      for (const m of newlyDone) post(room, { sender: body.by, type: 'status', body: `🏁 milestone reached: ${m.title}` });
    }
    roomEvent(room, 'goal', { goal: g });
    return { goal: g };
  });

  // -------- proposals: ideas the team discusses and decides on together
  const online = (room) => store.members(room).filter((m) => Date.now() - m.last_seen < ONLINE_MS && m.status !== 'offline');

  function tally(room, p) {
    const votes = Object.values(p.votes);
    const agree = votes.filter((v) => v.vote === 'agree').length;
    const disagree = votes.filter((v) => v.vote === 'disagree').length;
    const quorum = Math.max(2, Math.ceil(online(room).length / 2));
    if (agree >= quorum && agree > disagree) return 'accepted';
    if (disagree >= quorum && disagree >= agree) return 'rejected';
    return 'open';
  }

  function settle(room, p, decidedBy) {
    const s = decidedBy ? p.status : tally(room, p);
    if (s === 'open') return p;
    const updated = store.updateProposal(p.id, { status: s, decided_by: decidedBy ?? 'consensus' });
    if (s === 'accepted') {
      store.remember(room, { kind: 'decision', text: updated.title + (updated.body ? ` (${updated.body})` : ''), author: updated.author, source_message: updated.message_id, tags: ['proposal'] });
      roomEvent(room, 'memory', { memories: store.recall(room) });
    }
    const reasons = Object.entries(updated.votes).filter(([, v]) => v.reason && v.reason !== 'author').map(([n, v]) => `${n}: ${v.reason}`);
    post(room, { sender: 'convorum', sender_kind: 'system', type: 'decision', reply_to: updated.message_id, mentions: [updated.author],
      body: `${s === 'accepted' ? '✅ Accepted' : '❌ Rejected'} proposal P${updated.id} "${updated.title}" (${decidedBy ? `decided by ${decidedBy}` : 'team consensus'})${reasons.length ? `\n${reasons.join('\n')}` : ''}`,
      meta: { proposal: updated.id } });
    return updated;
  }

  route('GET', '/api/rooms/:room/proposals', ({ room, query }) => ({ proposals: store.proposals(room, query.status) }));
  route('POST', '/api/rooms/:room/proposals', ({ room, body }) => {
    need(body, 'author', 'title');
    let p = store.createProposal(room, body);
    const m = post(room, { sender: body.author, type: 'question', mentions: ['all'],
      body: `💡 Proposal P${p.id}: ${p.title}${p.body ? `\n${p.body}` : ''}\n→ vote agree/disagree with a reason`, meta: { proposal: p.id } });
    store.setLastRead(room, body.author, m.id);
    p = store.updateProposal(p.id, { message_id: m.id });
    roomEvent(room, 'proposals', { proposals: store.proposals(room) });
    return { proposal: p };
  });
  route('POST', '/api/rooms/:room/proposals/:id/vote', ({ room, body, params }) => {
    need(body, 'name', 'vote');
    if (!['agree', 'disagree', 'abstain'].includes(body.vote)) throw httpError(400, 'vote must be agree | disagree | abstain');
    let p = store.proposal(Number(params.id));
    if (!p || p.room !== room) throw httpError(404, 'proposal not found');
    if (p.status !== 'open') throw httpError(409, `proposal P${p.id} is already ${p.status}`);
    p = store.updateProposal(p.id, { votes: { ...p.votes, [body.name]: { vote: body.vote, reason: body.reason ?? null } } });
    post(room, { sender: body.name, type: 'answer', reply_to: p.message_id,
      body: `${{ agree: '👍', disagree: '👎', abstain: '🤷' }[body.vote]} ${body.vote} on P${p.id}${body.reason ? `: ${body.reason}` : ''}` });
    p = settle(room, p);
    roomEvent(room, 'proposals', { proposals: store.proposals(room) });
    return { proposal: p };
  });
  route('POST', '/api/rooms/:room/proposals/:id/decide', ({ room, body, params }) => {
    need(body, 'by', 'status');
    if (!['accepted', 'rejected', 'withdrawn'].includes(body.status)) throw httpError(400, 'bad status');
    let p = store.proposal(Number(params.id));
    if (!p || p.room !== room) throw httpError(404, 'proposal not found');
    const m = store.member(room, body.by);
    if (body.status !== 'withdrawn' && m?.kind !== 'human') throw httpError(403, 'only humans can override a decision; agents should vote');
    if (body.status === 'withdrawn' && body.by !== p.author) throw httpError(403, 'only the author can withdraw');
    p = settle(room, store.updateProposal(p.id, { status: body.status }), body.by);
    roomEvent(room, 'proposals', { proposals: store.proposals(room) });
    return { proposal: p };
  });

  // -------- live edit radar: catch conflicts before anyone commits
  const reported = new Map(); // room -> Map(key -> overlap)
  const keyOf = (o) => `${o.path}|${o.members.join(',')}`;

  function scanRadar(room) {
    const edits = store.edits(room);
    const found = findOverlaps(edits);
    const prev = reported.get(room) ?? new Map();
    const next = new Map(found.map((o) => [keyOf(o), o]));
    for (const [k, o] of next) {
      const old = prev.get(k);
      if (old && !(old.level === 'file' && o.level === 'lines')) continue; // already told them
      const where = o.level === 'lines' ? `lines ${o.lines.map(([a, b]) => (a === b ? a : `${a}-${b}`)).join(', ')}` : 'the same file';
      post(room, { sender: 'convorum', sender_kind: 'system', type: 'alert', mentions: o.members,
        body: `⚠️ Edit collision ahead: ${o.members.map((m) => '@' + m).join(' and ')} are both changing ${o.path} (${where}), uncommitted. Agree who goes first, or split the work, before this becomes a merge conflict.`,
        meta: { radar: o } });
    }
    for (const [k, o] of prev) if (!next.has(k)) {
      post(room, { sender: 'convorum', sender_kind: 'system', type: 'status', body: `✓ collision on ${o.path} between ${o.members.join(' & ')} cleared` });
    }
    // edits that land inside someone else's claim
    const claims = store.claims(room);
    for (const e of edits) {
      const c = claims.find((x) => x.owner !== e.member && overlaps(x.path, e.path));
      const k = `claim|${e.member}|${e.path}`;
      if (c && !prev.has(k)) {
        post(room, { sender: 'convorum', sender_kind: 'system', type: 'alert', mentions: [e.member, c.owner],
          body: `⚠️ @${e.member} is editing ${e.path}, which @${c.owner} has claimed (${c.path}${c.note ? `: ${c.note}` : ''}). Please coordinate.` });
      }
      if (c) next.set(k, { path: e.path, members: [e.member, c.owner], level: 'claim', lines: [] });
    }
    reported.set(room, next);
    roomEvent(room, 'radar', { edits, overlaps: found });
    return found;
  }

  route('PUT', '/api/rooms/:room/edits', ({ room, body }) => {
    need(body, 'member', 'files');
    if (!Array.isArray(body.files)) throw httpError(400, 'files must be an array');
    store.setEdits(room, body.member, body.branch, body.files.slice(0, 500));
    const found = scanRadar(room);
    return { overlaps: found.filter((o) => o.members.includes(body.member)) };
  });
  route('GET', '/api/rooms/:room/radar', ({ room }) => ({ edits: store.edits(room), overlaps: findOverlaps(store.edits(room)) }));

  // -------- team memory
  route('GET', '/api/rooms/:room/memory', ({ room, query }) => ({ memories: store.recall(room, { q: query.q, kind: query.kind, limit: Number(query.limit ?? 50) }) }));
  route('POST', '/api/rooms/:room/memory', ({ room, body }) => {
    need(body, 'author', 'text');
    if (body.kind && !['decision', 'convention', 'gotcha', 'fact'].includes(body.kind)) throw httpError(400, 'kind must be decision | convention | gotcha | fact');
    const m = store.remember(room, body);
    post(room, { sender: body.author, type: 'status', body: `🧠 remembered (${m.kind}): ${m.text}`, meta: { memory: m.id } });
    roomEvent(room, 'memory', { memories: store.recall(room) });
    return { memory: m };
  });
  route('DELETE', '/api/rooms/:room/memory/:id', ({ room, params, query }) => {
    const n = store.forget(room, Number(params.id));
    if (n) post(room, { sender: query.by ?? 'someone', type: 'status', body: `🧠 forgot memory #${params.id}` });
    roomEvent(room, 'memory', { memories: store.recall(room) });
    return { deleted: n };
  });

  /** Everything one member needs to orient themselves: goal, what changed, what's asked of them, what to do next. */
  route('GET', '/api/rooms/:room/brief', ({ room, query }) => {
    need(query, 'name');
    const me = query.name;
    const unread = unreadFor(room, me).filter((m) => m.sender_kind !== 'system');
    const goal = store.goal(room);
    const tasks = store.tasks(room);
    const proposals = store.proposals(room, 'open');
    const recentDecisions = store.db.prepare(`SELECT id FROM messages WHERE room = ? AND type = 'decision' ORDER BY id DESC LIMIT 8`)
      .all(room).map((r) => store.message(r.id)).reverse();
    const openQuestions = store.db.prepare(`SELECT id FROM messages q WHERE room = ? AND type = 'question' AND sender != ?
        AND created_at > ? AND NOT EXISTS (SELECT 1 FROM messages a WHERE a.reply_to = q.id AND a.sender = ?) ORDER BY id`)
      .all(room, me, Date.now() - 6 * 3600_000, me).map((r) => store.message(r.id))
      .filter((q) => q.mentions.includes(me) || q.mentions.includes('all') || q.mentions.length === 0)
      .filter((q) => !q.meta?.proposal);
    return {
      goal,
      unread,
      asked_of_you: {
        questions: openQuestions,
        proposals_to_vote: proposals.filter((p) => !p.votes[me]),
      },
      your_tasks: tasks.filter((t) => t.owner === me && t.status !== 'done'),
      unowned_tasks: tasks.filter((t) => !t.owner && t.status === 'open'),
      your_claims: store.claims(room).filter((c) => c.owner === me),
      recent_decisions: recentDecisions,
      members: store.members(room).map(withPresence),
      memory: store.recall(room, { limit: 25 }),
      collisions: findOverlaps(store.edits(room)).filter((o) => o.members.includes(me)),
    };
  });

  registerExtras({ route, post, store, roomEvent, httpError, need, waitFor, hooks, ONLINE_MS, withPresence });

  // ------------------------------------------------------------------ http plumbing
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
      if (token && !authorized(req, url)) throw httpError(401, 'bad or missing token');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw httpError(404, `no route ${req.method} ${url.pathname}`);
      const params = url.pathname.match(r.re).groups ?? {};
      if (params.room && !ROOM_RE.test(params.room)) throw httpError(400, 'invalid room name');
      const identity = params.room ? identify(params.room, req, url) : null;
      if (params.room && !identity) throw httpError(403, `room "${params.room}" is private: missing or wrong room key / member token`);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : {};
      const query = Object.fromEntries(url.searchParams);
      if (identity?.via === 'member') enforceMember(identity, req.method, url.pathname, body, query);
      const admin = !!token && authorized(req, url);
      const out = await r.handler({ room: params.room, params, body, query, me: query.name, admin, identity });
      if (params.room && req.method !== 'GET' && hooks.audit) { try { hooks.audit(params.room, identity, req.method, url.pathname, body); } catch {} }
      send(res, 200, out);
    } catch (e) {
      send(res, e.status ?? 500, { error: e.message });
      if (!e.status) console.error(e);
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const room = url.searchParams.get('room');
    if (url.pathname !== '/ws' || !room || !ROOM_RE.test(room) || (token && !authorized(req, url)) || !identify(room, req, url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const name = url.searchParams.get('name');
      if (name && NAME_RE.test(name)) touch(room, name, { kind: url.searchParams.get('kind') ?? 'human', client: 'dashboard' });
      const set = sockets.get(room) ?? new Set();
      sockets.set(room, set); set.add(ws);
      ws.send(JSON.stringify({ event: 'hello', room, messages: store.messages(room, { limit: 200 }),
        members: store.members(room).map(withPresence), claims: store.claims(room), tasks: store.tasks(room),
        goal: store.goal(room), proposals: store.proposals(room),
        memories: store.recall(room), edits: store.edits(room), overlaps: findOverlaps(store.edits(room)) }));
      const ping = setInterval(() => { if (name) store.touchMember(room, name, {}); }, 20_000);
      ws.on('close', () => { set.delete(ws); clearInterval(ping); });
    });
  });

  // periodic presence refresh so dashboards see people go offline
  const presence = setInterval(() => {
    for (const room of sockets.keys()) roomEvent(room, 'members', { members: store.members(room).map(withPresence) });
  }, 15_000);
  server.on('close', () => clearInterval(presence));

  /** Who is calling? A member token (named identity + role) or the room key / open room (admin). null = denied. */
  function identify(room, req, url) {
    const mt = req.headers['x-member-token'] || url.searchParams.get('member');
    if (mt) return hooks.identifyMember?.(room, mt) ?? null;
    if (!roomAuthorized(room, req, url)) return null;
    return { via: store.roomInfo(room) ? 'key' : 'open', name: null, role: 'admin' };
  }

  /** Member tokens are bound to one name and a role: no impersonation, observers are read-only. */
  function enforceMember(identity, method, path, body, query) {
    const presence = /\/(join|heartbeat|leave)$/.test(path);
    if (identity.role === 'observer' && method !== 'GET' && !presence) throw httpError(403, 'observers are read-only');
    const fields = ['sender', 'author', 'by', 'member', 'created_by', 'from', 'requester'];
    if (!path.includes('/invites')) fields.push('name'); // on /invites, "name" is the invitee
    if (path.includes('/claims')) fields.push('owner');
    for (const f of fields) if (body[f] !== undefined && body[f] !== identity.name) throw httpError(403, `your token is for "${identity.name}", not "${body[f]}"`);
    if (query.name && query.name !== identity.name && /\/(inbox|brief|digest)$/.test(path)) throw httpError(403, `your token is for "${identity.name}"`);
  }

  function roomAuthorized(room, req, url) {
    const info = store.roomInfo(room);
    if (!info) return true; // open room (protected only by the hub token, if any)
    const given = req.headers['x-room-key'] || url.searchParams.get('key') || '';
    const a = Buffer.from(hashKey(given)), b = Buffer.from(info.key_hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function authorized(req, url) {
    const h = req.headers.authorization ?? '';
    return h === `Bearer ${token}` || url.searchParams.get('token') === token;
  }

  async function serveStatic(path, res) {
    const file = path === '/' || path.startsWith('/r/') ? 'index.html' : path.slice(1);
    if (file.includes('..')) return send(res, 400, { error: 'bad path' });
    try {
      const data = await readFile(join(PUBLIC, file));
      const type = { html: 'text/html', js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml' }[file.split('.').pop()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': `${type}; charset=utf-8` }).end(data);
    } catch { send(res, 404, { error: 'not found' }); }
  }

  return { server, store, wss, post };
}

// ---------------------------------------------------------------- helpers
function hashKey(k) { return createHash('sha256').update(String(k)).digest('hex'); }
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }).end(JSON.stringify(obj));
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function need(obj, ...keys) { for (const k of keys) if (obj?.[k] === undefined || obj[k] === '') throw httpError(400, `missing "${k}"`); }
function validName(n) { if (!NAME_RE.test(n)) throw httpError(400, 'names may contain letters, digits, . _ - @ (max 48)'); }
function pick(obj, keys) { return Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]])); }
function readJson(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 1e6) reject(httpError(413, 'body too large')); });
    req.on('end', () => {
      try {
        if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(s)));
        resolve(s ? JSON.parse(s) : {});
      } catch { reject(httpError(400, 'invalid JSON')); }
    });
  });
}
