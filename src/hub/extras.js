// Phase 2–4 hub features, registered onto the core router:
// roles & invites · contracts · delegation · approvals · digest/standup · timeline · integrations (Slack/Discord/webhooks) · audit log
import { createHash, randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS member_tokens (
  room TEXT NOT NULL, token_hash TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL,
  created_by TEXT, created_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (room, token_hash)
);
CREATE TABLE IF NOT EXISTS contracts (
  room TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'api', spec TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1, owner TEXT NOT NULL, history TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY (room, name)
);
CREATE TABLE IF NOT EXISTS contract_subs (room TEXT NOT NULL, name TEXT NOT NULL, member TEXT NOT NULL, PRIMARY KEY (room, name, member));
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, requester TEXT NOT NULL, approver TEXT,
  action TEXT NOT NULL, details TEXT, status TEXT NOT NULL DEFAULT 'pending', decided_by TEXT, reason TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, kind TEXT NOT NULL, url TEXT,
  events TEXT NOT NULL, secret TEXT NOT NULL UNIQUE, created_by TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, actor TEXT, via TEXT, action TEXT NOT NULL, detail TEXT, at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_room ON audit(room, id);
`;

export const ROLES = ['admin', 'member', 'observer'];
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const DEFAULT_EVENTS = ['decision', 'alert', 'question', 'handoff', 'approval'];

export function registerExtras(ctx) {
  const { route, post, store, roomEvent, httpError, need, waitFor, hooks, ONLINE_MS } = ctx;
  const db = store.db;
  db.exec(SCHEMA);
  for (const col of ['delegated_by TEXT', 'result TEXT']) { try { db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch {} }

  // ================================================================ roles & invites
  hooks.identifyMember = (room, tokenValue) => {
    const r = db.prepare('SELECT * FROM member_tokens WHERE room = ? AND token_hash = ? AND revoked = 0').get(room, hash(tokenValue));
    return r ? { via: 'member', name: r.name, role: r.role } : null;
  };
  route('POST', '/api/rooms/:room/invites', ({ room, body, identity }) => {
    need(body, 'name');
    requireRole(identity, 'admin');
    const role = body.role ?? 'member';
    if (!ROLES.includes(role)) throw httpError(400, `role must be one of ${ROLES.join(', ')}`);
    const tok = 'cvm_' + randomBytes(18).toString('base64url');
    db.prepare('INSERT INTO member_tokens (room, token_hash, name, role, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(room, hash(tok), body.name, role, identity?.name ?? body.by ?? null, Date.now());
    post(room, { sender: 'convorum', sender_kind: 'system', type: 'status', body: `🎟️ invite created for ${body.name} (${role})` });
    return { name: body.name, role, member_token: tok };
  });
  route('GET', '/api/rooms/:room/invites', ({ room, identity }) => {
    requireRole(identity, 'admin');
    return { invites: db.prepare('SELECT name, role, created_by, created_at, revoked FROM member_tokens WHERE room = ? ORDER BY created_at').all(room) };
  });
  route('POST', '/api/rooms/:room/invites/revoke', ({ room, body, identity }) => {
    need(body, 'name'); requireRole(identity, 'admin');
    const n = db.prepare('UPDATE member_tokens SET revoked = 1 WHERE room = ? AND name = ? AND revoked = 0').run(room, body.name).changes;
    if (n) post(room, { sender: 'convorum', sender_kind: 'system', type: 'status', body: `🚫 access revoked for ${body.name}` });
    return { revoked: n };
  });
  route('GET', '/api/rooms/:room/whoami', ({ identity }) => ({ identity }));

  function requireRole(identity, role) {
    const rank = { observer: 0, member: 1, admin: 2 };
    if ((rank[identity?.role] ?? -1) < rank[role]) throw httpError(403, `needs ${role} role`);
  }

  // ================================================================ contracts
  const parseC = (r) => r && { ...r, history: JSON.parse(r.history), subscribers: subs(r.room, r.name) };
  const subs = (room, name) => db.prepare('SELECT member FROM contract_subs WHERE room = ? AND name = ?').all(room, name).map((x) => x.member);

  route('GET', '/api/rooms/:room/contracts', ({ room }) => ({
    contracts: db.prepare('SELECT * FROM contracts WHERE room = ? ORDER BY name').all(room).map(parseC),
  }));
  route('GET', '/api/rooms/:room/contracts/:name', ({ room, params }) => {
    const c = parseC(db.prepare('SELECT * FROM contracts WHERE room = ? AND name = ?').get(room, decodeURIComponent(params.name)));
    if (!c) throw httpError(404, `no contract "${params.name}"`);
    return { contract: c };
  });
  route('PUT', '/api/rooms/:room/contracts/:name', ({ room, params, body }) => {
    need(body, 'by', 'spec');
    const name = decodeURIComponent(params.name);
    if (!/^[\w.:/@ {}-]{1,120}$/.test(name) || !name.trim()) throw httpError(400, 'invalid contract name');
    const spec = String(body.spec).slice(0, 50_000);
    const cur = db.prepare('SELECT * FROM contracts WHERE room = ? AND name = ?').get(room, name);
    const now = Date.now();
    if (!cur) {
      db.prepare('INSERT INTO contracts (room, name, kind, spec, version, owner, history, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)')
        .run(room, name, body.kind ?? 'api', spec, body.by, JSON.stringify([{ version: 1, by: body.by, at: now, note: body.note ?? 'created' }]), now);
      post(room, { sender: body.by, type: 'status', body: `📄 published contract ${name} v1 (${body.kind ?? 'api'})${body.note ? `: ${body.note}` : ''}`, meta: { contract: name } });
    } else {
      if (cur.spec === spec) return { contract: parseC(cur), changed: false };
      const version = cur.version + 1;
      const d = lineDiff(cur.spec, spec);
      const history = JSON.parse(cur.history);
      history.push({ version, by: body.by, at: now, note: body.note ?? null, breaking: !!body.breaking, added: d.added.length, removed: d.removed.length, previous: cur.spec });
      db.prepare('UPDATE contracts SET spec = ?, version = ?, kind = ?, history = ?, updated_at = ? WHERE room = ? AND name = ?')
        .run(spec, version, body.kind ?? cur.kind, JSON.stringify(history.slice(-20)), now, room, name);
      const dependents = subs(room, name).filter((m) => m !== body.by);
      const preview = [...d.removed.slice(0, 6).map((l) => `- ${l}`), ...d.added.slice(0, 6).map((l) => `+ ${l}`)].join('\n');
      post(room, {
        sender: body.by, type: body.breaking ? 'alert' : 'status', mentions: dependents,
        body: `${body.breaking ? '💥 BREAKING change' : '📄 updated'} contract ${name} → v${version}${body.note ? `: ${body.note}` : ''}${dependents.length ? `\n${dependents.map((m) => '@' + m).join(' ')} you depend on this.` : ''}\n\`\`\`diff\n${preview}\n\`\`\``,
        meta: { contract: name, version },
      });
    }
    roomEvent(room, 'contracts', {});
    return { contract: parseC(db.prepare('SELECT * FROM contracts WHERE room = ? AND name = ?').get(room, name)), changed: true };
  });
  route('POST', '/api/rooms/:room/contracts/:name/subscribe', ({ room, params, body }) => {
    need(body, 'member');
    const name = decodeURIComponent(params.name);
    if (body.unsubscribe) db.prepare('DELETE FROM contract_subs WHERE room = ? AND name = ? AND member = ?').run(room, name, body.member);
    else db.prepare('INSERT OR IGNORE INTO contract_subs (room, name, member) VALUES (?, ?, ?)').run(room, name, body.member);
    return { subscribers: subs(room, name) };
  });

  // ================================================================ delegation (hand work to another member's agent)
  route('POST', '/api/rooms/:room/delegations', ({ room, body }) => {
    need(body, 'from', 'to', 'title');
    if (body.from === body.to) throw httpError(400, 'cannot delegate to yourself');
    const t = store.createTask(room, { title: body.title, description: body.details, created_by: body.from });
    db.prepare("UPDATE tasks SET status = 'proposed', owner = ?, delegated_by = ? WHERE id = ?").run(body.to, body.from, t.id);
    const target = store.member(room, body.to);
    post(room, {
      sender: body.from, type: 'handoff', mentions: [body.to, ...(target?.owner && store.member(room, target.owner) ? [target.owner] : [])],
      body: `🤝 @${body.to} can you take task #${t.id}: ${body.title}?${body.details ? `\n${body.details}` : ''}\n→ accept or decline${target?.owner ? ` (check with ${target.owner} if it's outside what they asked you to do)` : ''}`,
      meta: { task: t.id, delegation: true },
    });
    roomEvent(room, 'tasks', { tasks: store.tasks(room) });
    return { task: store.task(t.id) };
  });
  route('POST', '/api/rooms/:room/delegations/:id/respond', ({ room, params, body }) => {
    need(body, 'by');
    const t = store.task(Number(params.id));
    if (!t || t.room !== room || t.status !== 'proposed') throw httpError(404, 'no pending delegation with that id');
    const m = store.member(room, body.by);
    const allowed = body.by === t.owner || (m?.kind === 'human' && store.member(room, t.owner)?.owner === body.by);
    if (!allowed) throw httpError(403, 'only the delegate or their owner can respond');
    db.prepare('UPDATE tasks SET status = ?, owner = ?, updated_at = ? WHERE id = ?')
      .run(body.accept ? 'in_progress' : 'open', body.accept ? t.owner : null, Date.now(), t.id);
    post(room, { sender: body.by, type: 'answer', mentions: [t.delegated_by],
      body: `${body.accept ? '✅ accepted' : '↩️ declined'} task #${t.id}: ${t.title}${body.reason ? `: ${body.reason}` : ''}`, meta: { task: t.id } });
    roomEvent(room, 'tasks', { tasks: store.tasks(room) });
    return { task: store.task(t.id) };
  });
  route('POST', '/api/rooms/:room/tasks/:id/result', ({ room, params, body }) => {
    need(body, 'by', 'result');
    const t = store.task(Number(params.id));
    if (!t || t.room !== room) throw httpError(404, 'task not found');
    if (t.owner && t.owner !== body.by) throw httpError(403, `task #${t.id} belongs to ${t.owner}`);
    db.prepare("UPDATE tasks SET result = ?, status = 'done', updated_at = ? WHERE id = ?").run(String(body.result).slice(0, 10_000), Date.now(), t.id);
    post(room, { sender: body.by, type: 'handoff', mentions: t.delegated_by ? [t.delegated_by] : [],
      body: `✅ finished task #${t.id}: ${t.title}\nResult: ${body.result}`, meta: { task: t.id, result: true } });
    roomEvent(room, 'tasks', { tasks: store.tasks(room) });
    return { task: store.task(t.id) };
  });

  // ================================================================ approvals (agent asks its human before risky actions)
  const getA = (id) => db.prepare('SELECT * FROM approvals WHERE id = ?').get(id);
  route('GET', '/api/rooms/:room/approvals', ({ room, query }) => ({
    approvals: db.prepare(`SELECT * FROM approvals WHERE room = ? ${query.status ? 'AND status = ?' : ''} ORDER BY id DESC LIMIT 50`)
      .all(...[room, query.status].filter(Boolean)),
  }));
  route('POST', '/api/rooms/:room/approvals', async ({ room, body }) => {
    need(body, 'requester', 'action');
    const approver = body.approver ?? store.member(room, body.requester)?.owner ?? null;
    const a = db.prepare('INSERT INTO approvals (room, requester, approver, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(room, body.requester, approver, String(body.action).slice(0, 500), body.details ?? null, Date.now());
    post(room, { sender: body.requester, type: 'approval', mentions: approver ? [approver] : ['all'],
      body: `🛑 approval needed${approver ? ` from @${approver}` : ''} (A${a.id}): ${a.action}${a.details ? `\n${a.details}` : ''}`, meta: { approval: a.id } });
    roomEvent(room, 'approvals', {});
    const wait = Math.min(Number(body.wait ?? 0), 900);
    if (wait > 0) await waitFor(room, (m) => m.meta?.approval === a.id && m.meta?.decided, wait * 1000);
    return { approval: getA(a.id) };
  });
  route('GET', '/api/rooms/:room/approvals/:id', async ({ room, params, query }) => {
    const a = getA(Number(params.id));
    if (!a || a.room !== room) throw httpError(404, 'approval not found');
    const wait = Math.min(Number(query.wait ?? 0), 900);
    if (a.status === 'pending' && wait > 0) await waitFor(room, (m) => m.meta?.approval === a.id && m.meta?.decided, wait * 1000);
    return { approval: getA(a.id) };
  });
  route('POST', '/api/rooms/:room/approvals/:id/decide', ({ room, params, body }) => {
    need(body, 'by', 'approve');
    const a = getA(Number(params.id));
    if (!a || a.room !== room) throw httpError(404, 'approval not found');
    if (a.status !== 'pending') throw httpError(409, `already ${a.status}`);
    const m = store.member(room, body.by);
    if (m?.kind !== 'human') throw httpError(403, 'only humans can approve; agents must never approve actions');
    if (a.approver && a.approver !== body.by && store.member(room, a.approver)) throw httpError(403, `only ${a.approver} can decide this`);
    const status = body.approve ? 'approved' : 'denied';
    db.prepare('UPDATE approvals SET status = ?, decided_by = ?, reason = ?, decided_at = ? WHERE id = ?').run(status, body.by, body.reason ?? null, Date.now(), a.id);
    post(room, { sender: body.by, sender_kind: 'human', type: 'answer', mentions: [a.requester],
      body: `${body.approve ? '✅ approved' : '⛔ denied'} A${a.id}: ${a.action}${body.reason ? `: ${body.reason}` : ''}`, meta: { approval: a.id, decided: true } });
    roomEvent(room, 'approvals', {});
    return { approval: getA(a.id) };
  });

  // ================================================================ catch-up digest & standup (deterministic, no LLM needed)
  route('GET', '/api/rooms/:room/digest', ({ room, query }) => {
    need(query, 'name');
    const me = store.member(room, query.name);
    const since = query.hours ? Date.now() - Number(query.hours) * 3600_000 : null;
    const msgs = since
      ? db.prepare('SELECT id FROM messages WHERE room = ? AND created_at >= ? ORDER BY id LIMIT 2000').all(room, since).map((r) => store.message(r.id))
      : store.messages(room, { after: me?.last_read ?? 0, limit: 500 });
    return { since: since ?? msgs[0]?.created_at ?? Date.now(), ...summarize(msgs, query.name) };
  });
  route('GET', '/api/rooms/:room/standup', ({ room, query }) => {
    const since = Date.now() - Number(query.hours ?? 24) * 3600_000;
    const tasks = store.tasks(room);
    const msgs = db.prepare('SELECT sender, type, body, meta FROM messages WHERE room = ? AND created_at >= ? AND sender_kind != ?').all(room, since, 'system');
    const members = store.members(room).filter((m) => m.last_seen >= since || tasks.some((t) => t.owner === m.name && t.status !== 'done'));
    return {
      hours: Number(query.hours ?? 24),
      members: members.map((m) => ({
        name: m.name, kind: m.kind, owner: m.owner, status: m.status, working_on: m.working_on,
        done: tasks.filter((t) => t.owner === m.name && t.status === 'done' && t.updated_at >= since).map((t) => `#${t.id} ${t.title}`),
        doing: tasks.filter((t) => t.owner === m.name && t.status === 'in_progress').map((t) => `#${t.id} ${t.title}`),
        blocked: tasks.filter((t) => t.owner === m.name && t.status === 'blocked').map((t) => `#${t.id} ${t.title}`),
        messages: msgs.filter((x) => x.sender === m.name).length,
      })),
      decisions: msgs.filter((x) => x.type === 'decision').map((x) => x.body.split('\n')[0]),
    };
  });

  // ================================================================ timeline (for replay)
  route('GET', '/api/rooms/:room/timeline', ({ room, query }) => ({
    messages: db.prepare('SELECT id FROM messages WHERE room = ? AND id > ? ORDER BY id LIMIT ?')
      .all(room, Number(query.after ?? 0), Math.min(Number(query.limit ?? 2000), 5000)).map((r) => store.message(r.id)),
  }));

  // ================================================================ integrations: Slack / Discord / generic webhooks
  route('POST', '/api/rooms/:room/integrations', ({ room, body, identity }) => {
    need(body, 'kind'); requireRole(identity, 'admin');
    if (!['slack', 'discord', 'webhook'].includes(body.kind)) throw httpError(400, 'kind must be slack | discord | webhook');
    if (body.url && !/^https?:\/\//.test(body.url)) throw httpError(400, 'url must be http(s)');
    const secret = 'cvi_' + randomBytes(18).toString('base64url');
    const it = db.prepare('INSERT INTO integrations (room, kind, url, events, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id, room, kind, url, events')
      .get(room, body.kind, body.url ?? null, JSON.stringify(body.events ?? DEFAULT_EVENTS), secret, identity?.name ?? body.by ?? null, Date.now());
    return { integration: { ...it, events: JSON.parse(it.events) }, incoming_url_path: `/api/incoming/${secret}` };
  });
  route('GET', '/api/rooms/:room/integrations', ({ room, identity }) => {
    requireRole(identity, 'admin');
    return { integrations: db.prepare('SELECT id, kind, url, events, created_at FROM integrations WHERE room = ?').all(room).map((i) => ({ ...i, events: JSON.parse(i.events) })) };
  });
  route('DELETE', '/api/rooms/:room/integrations/:id', ({ room, params, identity }) => {
    requireRole(identity, 'admin');
    return { deleted: db.prepare('DELETE FROM integrations WHERE room = ? AND id = ?').run(room, Number(params.id)).changes };
  });
  // incoming: Slack slash-command / outgoing-webhook (form encoded), Discord bots, or anything that can POST JSON
  route('POST', '/api/incoming/:secret', ({ params, body }) => {
    const it = db.prepare('SELECT * FROM integrations WHERE secret = ?').get(params.secret);
    if (!it) throw httpError(404, 'unknown integration');
    const text = body.text ?? body.content ?? body.message;
    const user = String(body.user_name ?? body.username ?? body.user ?? `${it.kind}-user`).replace(/[^\w.@-]/g, '').slice(0, 40) || 'guest';
    if (!text) throw httpError(400, 'missing text');
    if (!store.member(it.room, user)) store.touchMember(it.room, user, { kind: 'human', client: it.kind });
    const m = post(it.room, { sender: user, sender_kind: 'human', type: 'chat', body: String(text).slice(0, 5000), meta: { via: it.kind } });
    return it.kind === 'slack' ? { response_type: 'in_channel', text: `posted to #${it.room} as #${m.id}` } : { ok: true, id: m.id };
  });
  hooks.onPost.push((room, msg) => {
    if (msg.meta?.via) return; // don't echo messages that came from an integration
    const list = db.prepare('SELECT * FROM integrations WHERE room = ? AND url IS NOT NULL').all(room);
    for (const it of list) {
      const events = JSON.parse(it.events);
      if (!events.includes('all') && !events.includes(msg.type)) continue;
      const text = `*#${room}* · ${msg.sender}${msg.sender_kind === 'human' ? '' : ' 🤖'}${msg.type !== 'chat' ? ` [${msg.type}]` : ''}: ${msg.body}`;
      const payload = it.kind === 'slack' ? { text } : it.kind === 'discord' ? { content: text.slice(0, 1900) } : { room, message: msg };
      fetch(it.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) }).catch(() => {});
    }
  });

  // ================================================================ audit log
  hooks.audit = (room, identity, method, path, body) => {
    const actor = identity?.name ?? (path.includes('/invites') || path.includes('/integrations') ? `room-admin (${identity?.via ?? '?'})` : null) ?? body?.sender ?? body?.by ?? body?.name ?? body?.author ?? body?.owner ?? body?.member ?? body?.from ?? body?.requester ?? null;
    const action = `${method} ${path.replace(`/api/rooms/${room}`, '') || '/'}`;
    const detail = JSON.stringify(body ?? {}, (k, v) => (['spec', 'previous', 'files'].includes(k) ? '[omitted]' : v)).slice(0, 500);
    db.prepare('INSERT INTO audit (room, actor, via, action, detail, at) VALUES (?, ?, ?, ?, ?, ?)').run(room, actor, identity?.via ?? null, action, detail, Date.now());
  };
  route('GET', '/api/rooms/:room/audit', ({ room, query, identity }) => {
    requireRole(identity, 'admin');
    return { audit: db.prepare('SELECT * FROM audit WHERE room = ? AND id > ? ORDER BY id DESC LIMIT ?').all(room, Number(query.after ?? 0), Math.min(Number(query.limit ?? 200), 1000)) };
  });
}

// ---------------------------------------------------------------- helpers
/** Multiset line diff (good enough for contract change previews). */
export function lineDiff(a, b) {
  const A = a.split('\n'), B = b.split('\n');
  const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const ca = count(A), cb = count(B);
  const removed = [], added = [];
  for (const l of A) { if ((cb.get(l) ?? 0) > 0) cb.set(l, cb.get(l) - 1); else removed.push(l); }
  for (const l of B) { if ((ca.get(l) ?? 0) > 0) ca.set(l, ca.get(l) - 1); else added.push(l); }
  return { added, removed };
}

export function summarize(msgs, me) {
  const human = msgs.filter((m) => m.sender_kind !== 'system' || m.type === 'decision' || m.type === 'alert');
  const pick = (f) => human.filter(f).map((m) => ({ id: m.id, sender: m.sender, text: m.body.split('\n')[0].slice(0, 240) }));
  const activity = {};
  for (const m of msgs) if (m.sender_kind !== 'system') activity[m.sender] = (activity[m.sender] ?? 0) + 1;
  return {
    total: msgs.length,
    for_you: pick((m) => m.mentions.includes(me) && m.sender !== me),
    decisions: pick((m) => m.type === 'decision'),
    alerts: pick((m) => m.type === 'alert'),
    questions: pick((m) => m.type === 'question' && m.sender !== me),
    handoffs: pick((m) => m.type === 'handoff'),
    approvals: pick((m) => m.type === 'approval'),
    finished: pick((m) => /✅ finished|milestone reached/.test(m.body)),
    activity,
  };
}
