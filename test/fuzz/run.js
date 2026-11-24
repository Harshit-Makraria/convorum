// Convorum property-based / differential fuzz suite.
// Every case is generated from a seeded PRNG, so any failure is reproducible with: SEED=<seed> node test/fuzz/run.js
// Each suite checks the real implementation against an independent reference model ("oracle") or invariants.
import assert from 'node:assert/strict';
import { overlaps, findOverlaps, Store } from '../../src/hub/store.js';
import { parseUnifiedDiff } from '../../src/radar/git.js';
import { redact } from '../../src/redact.js';
import { shouldWake } from '../../src/agent/runner.js';
import { lineDiff, summarize } from '../../src/hub/extras.js';
import { createHub } from '../../src/hub/server.js';
import { Hub } from '../../src/client.js';

const SEED = Number(process.env.SEED ?? 20261124);
const SCALE = Number(process.env.SCALE ?? 1);
function rng(seed) { // mulberry32
  let a = seed >>> 0;
  const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (arr) => arr[Math.floor(next() * arr.length)];
  const str = (n, alpha = 'abcdefghijklmnopqrstuvwxyz') => Array.from({ length: n }, () => pick(alpha)).join('');
  return { next, int, pick, str, bool: (p = 0.5) => next() < p };
}

const results = [];
async function suite(name, cases, fn) {
  const n = Math.max(1, Math.round(cases * SCALE));
  const r = rng(SEED ^ hashStr(name));
  const t0 = Date.now();
  let i = 0;
  try {
    for (; i < n; i++) await fn(r, i);
  } catch (e) {
    console.error(`\n✖ ${name}: case ${i} failed (SEED=${SEED})\n`, e);
    process.exit(1);
  }
  results.push({ name, n, ms: Date.now() - t0 });
  console.log(`✔ ${name.padEnd(52)} ${String(n).padStart(7)} cases  ${String(Date.now() - t0).padStart(6)} ms`);
}
function hashStr(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

// ------------------------------------------------------------------ 1. path overlap vs segment oracle
const SEGS = ['src', 'lib', 'auth', 'api', 'a', 'ab', 'b', 'index.js', 'x.ts', 'test', 'login.ts'];
const genPath = (r) => {
  const segs = Array.from({ length: r.int(1, 4) }, () => r.pick(SEGS));
  let p = segs.join('/');
  if (r.bool(0.15)) p = './' + p;
  if (r.bool(0.15)) p += '/';
  return { p, segs };
};
await suite('path overlap (claims) vs segment-prefix oracle', 100_000, (r) => {
  const A = genPath(r), B = genPath(r);
  const prefix = (x, y) => x.length <= y.length && x.every((s, i) => s === y[i]);
  const expected = prefix(A.segs, B.segs) || prefix(B.segs, A.segs);
  assert.equal(overlaps(A.p, B.p), expected, `${A.p} vs ${B.p}`);
  assert.equal(overlaps(A.p, B.p), overlaps(B.p, A.p), 'symmetric');
});

// ------------------------------------------------------------------ 2. edit-collision detection vs brute force oracle
await suite('edit radar collisions vs brute-force oracle', 100_000, (r) => {
  const members = ['al', 'bo', 'cy', 'di'].slice(0, r.int(1, 4));
  const paths = ['a.js', 'b.js', 'c/d.ts'].slice(0, r.int(1, 3));
  const edits = [];
  for (const m of members) for (const p of paths) {
    if (r.bool(0.5)) continue;
    const ranges = r.bool(0.2) ? [] : Array.from({ length: r.int(1, 3) }, () => { const s = r.int(1, 120); return [s, s + r.int(0, 15)]; });
    edits.push({ member: m, path: p, ranges });
  }
  const oracle = [];
  for (let i = 0; i < edits.length; i++) for (let j = i + 1; j < edits.length; j++) {
    const a = edits[i], b = edits[j];
    if (a.path !== b.path || a.member === b.member) continue;
    let level = 'file';
    if (a.ranges.length && b.ranges.length) {
      for (const [s1, e1] of a.ranges) for (const [s2, e2] of b.ranges) if (s1 <= e2 + 3 && s2 <= e1 + 3) level = 'lines';
    }
    oracle.push(`${a.path}|${[a.member, b.member].sort().join(',')}|${level}`);
  }
  const got = findOverlaps(edits).map((o) => `${o.path}|${o.members.join(',')}|${o.level}`);
  assert.deepEqual(got.sort(), oracle.sort());
  for (const o of findOverlaps(edits)) {
    assert.deepEqual(o.members, [...o.members].sort(), 'members sorted (stable dedupe key)');
    if (o.level === 'lines') assert.ok(o.lines.length > 0 && o.lines.every(([s, e]) => s >= 1 && e >= s));
  }
});

// ------------------------------------------------------------------ 3. unified diff parser vs generator
await suite('git diff parser vs generated diffs', 100_000, (r) => {
  const files = [];
  let text = '';
  for (let f = 0, n = r.int(0, 4); f < n; f++) {
    const path = `${r.pick(['src', 'lib', 'app'])}/${r.str(r.int(1, 8))}.${r.pick(['js', 'ts', 'py'])}`;
    const kind = r.pick(['modified', 'modified', 'added', 'deleted', 'renamed']);
    const finalPath = kind === 'renamed' ? path.replace(/\.(\w+)$/, '_new.$1') : path;
    text += `diff --git a/${path} b/${finalPath}\n`;
    if (kind === 'added') text += 'new file mode 100644\n';
    if (kind === 'deleted') text += 'deleted file mode 100644\n';
    if (kind === 'renamed') text += `similarity index 90%\nrename from ${path}\nrename to ${finalPath}\n`;
    text += `index 1234567..89abcde 100644\n--- a/${path}\n+++ b/${finalPath}\n`;
    const ranges = [];
    let line = 1;
    for (let h = 0, hn = r.int(0, 5); h < hn; h++) {
      line += r.int(0, 40);
      const count = r.int(0, 12);
      const oldCount = r.int(0, 12);
      const hdr = `@@ -${line}${oldCount === 1 && r.bool() ? '' : ',' + oldCount} +${line}${count === 1 && r.bool() ? '' : ',' + count} @@ ${r.bool() ? 'function x()' : ''}\n`;
      text += hdr;
      for (let k = 0; k < oldCount; k++) text += `-old ${r.str(5)}\n`;
      for (let k = 0; k < count; k++) text += `+new ${r.str(5)}\n`;
      ranges.push(count === 0 ? [line, line] : [line, line + count - 1]);
      line += count + 1;
    }
    files.push({ path: finalPath, status: kind, ranges });
  }
  assert.deepEqual(parseUnifiedDiff(text), files);
});

// ------------------------------------------------------------------ 4. secret redaction: no secret survives, benign text untouched
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SECRET_GENS = [
  (r) => 'AKIA' + r.str(16, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'),
  (r) => 'ghp_' + r.str(36, B62),
  (r) => 'github_pat_' + r.str(50, B62 + '_'),
  (r) => 'sk-ant-api03-' + r.str(40, B62 + '-_'),
  (r) => 'sk-proj-' + r.str(48, B62 + '-_'),
  (r) => 'xoxb-' + r.str(12, '0123456789') + '-' + r.str(24, B62),
  (r) => 'sk_live_' + r.str(24, B62),
  (r) => 'AIza' + r.str(35, B62 + '-_'),
  (r) => 'eyJ' + r.str(20, B62) + '.eyJ' + r.str(30, B62) + '.' + r.str(30, B62 + '-_'),
  (r) => 'cvk_' + r.str(24, B62 + '-_'),
  (r) => '-----BEGIN RSA PRIVATE KEY-----\n' + r.str(64, B62 + '+/') + '\n-----END RSA PRIVATE KEY-----',
];
const ASSIGN = (r) => { const v = r.str(r.int(8, 20), B62 + '!#$%^&*'); return { full: `${r.pick(['password', 'api_key', 'API-KEY', 'secret', 'client_secret', 'auth_token'])}${r.pick(['=', ': ', ' = '])}${v}`, secret: v }; };
const URLCRED = (r) => { const v = r.str(r.int(6, 16), B62); return { full: `postgres://admin:${v}@db.example.com:5432/app`, secret: v }; };
const BENIGN_WORDS = ['the', 'login', 'route', 'returns', 'user', 'id', 'we', 'should', 'use', 'zod', 'for', 'validation', 'fix', 'bug', 'in', 'src/auth.ts', 'line', '42', 'PR', '#12', 'skip', 'key', 'token', 'refresh', 'eyJ', 'sk', 'AKIA', 'ghp', 'test', 'merge', '`const x = 1`', 'http://localhost:3000/api', 'v2.1.0', '@bob', 'P3', '🚀'];
await suite('secret redaction: secrets never survive', 70_000, (r) => {
  const words = Array.from({ length: r.int(0, 12) }, () => r.pick(BENIGN_WORDS));
  let secret, inserted;
  const roll = r.int(0, SECRET_GENS.length + 1);
  if (roll < SECRET_GENS.length) { secret = SECRET_GENS[roll](r); inserted = secret; }
  else if (roll === SECRET_GENS.length) { const a = ASSIGN(r); secret = a.secret; inserted = a.full; }
  else { const u = URLCRED(r); secret = u.secret; inserted = u.full; }
  words.splice(r.int(0, words.length), 0, r.bool(0.2) ? `"${inserted}"` : inserted);
  const text = words.join(r.pick([' ', '\n', ', ']));
  const out = redact(text);
  assert.ok(!out.text.includes(secret), `secret survived: ${secret}\nin: ${out.text}`);
  assert.ok(out.found.length >= 1 && /\[REDACTED:/.test(out.text));
});
await suite('secret redaction: benign text is never changed', 30_000, (r) => {
  const text = Array.from({ length: r.int(0, 25) }, () => r.pick(BENIGN_WORDS)).join(r.pick([' ', '\n']));
  const out = redact(text);
  assert.equal(out.text, text); assert.equal(out.found.length, 0);
});

// ------------------------------------------------------------------ 5. on-call wake rules: invariants
const ACKS = ['ok', 'okay', 'thanks', 'thank you', 'thx', 'sounds good', 'got it', 'cool', 'nice', 'great', '👍', 'ack', 'noted', 'OK!', 'Thanks.'];
await suite('on-call wake rules (anti echo-loop invariants)', 50_000, (r) => {
  const me = 'me';
  const sender = r.pick(['me', 'bob', 'convorum', 'alice']);
  const kind = sender === 'convorum' ? 'system' : r.pick(['agent', 'human']);
  const type = r.pick(['chat', 'question', 'status', 'decision', 'alert', 'handoff', 'answer', 'request', 'approval']);
  const mentions = [...new Set(Array.from({ length: r.int(0, 3) }, () => r.pick(['me', 'bob', 'all', 'everyone', 'zed'])))];
  const ack = r.bool(0.25);
  const body = ack ? r.pick(ACKS) : `${mentions.map((m) => '@' + m).join(' ')} ${r.str(r.int(3, 30), 'abc def?')}`;
  const m = { sender, sender_kind: kind, type, mentions, body, meta: r.bool(0.1) ? { proposal: 1 } : {} };
  const w = shouldWake(m, me);
  if (sender === me) assert.equal(w, false, 'never wakes for own message');
  if (kind === 'system' && !(type === 'alert' && mentions.includes(me))) assert.equal(w, false, 'system noise never wakes');
  if (type === 'status' && kind !== 'system') assert.equal(w, false, 'status updates never wake');
  if (ack && kind !== 'system') assert.equal(w, false, 'acknowledgements never wake');
  if (sender !== me && kind !== 'system' && type !== 'status' && !ack && mentions.includes(me)) assert.equal(w, true, 'direct mention always wakes');
  if (kind === 'system' && type === 'alert' && mentions.includes(me)) assert.equal(w, true, 'collision alerts wake');
});

// ------------------------------------------------------------------ 6. contract line diff: multiset invariants
await suite('contract line diff (multiset invariants)', 30_000, (r) => {
  const pool = ['id: string', 'name: string', 'email: string', 'age?: number', '}', '{', 'token', ''];
  const A = Array.from({ length: r.int(0, 15) }, () => r.pick(pool));
  const B = Array.from({ length: r.int(0, 15) }, () => r.pick(pool));
  const { added, removed } = lineDiff(A.join('\n'), B.join('\n'));
  const count = (arr) => arr.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const ca = count(A.join('\n').split('\n')), cb = count(B.join('\n').split('\n'));
  const keys = new Set([...ca.keys(), ...cb.keys()]);
  for (const k of keys) {
    const a = ca.get(k) ?? 0, b = cb.get(k) ?? 0;
    assert.equal(removed.filter((x) => x === k).length, Math.max(0, a - b), `removed ${k}`);
    assert.equal(added.filter((x) => x === k).length, Math.max(0, b - a), `added ${k}`);
  }
});

// ------------------------------------------------------------------ 7. digest summary invariants
await suite('catch-up digest classification invariants', 20_000, (r) => {
  const msgs = Array.from({ length: r.int(0, 20) }, (_, i) => ({
    id: i + 1, sender: r.pick(['me', 'bob', 'convorum']), sender_kind: r.pick(['agent', 'human', 'system']),
    type: r.pick(['chat', 'decision', 'alert', 'question', 'handoff', 'approval', 'status']),
    mentions: r.bool(0.3) ? ['me'] : [], body: r.bool(0.1) ? '✅ finished task #3: x' : r.str(r.int(1, 300), 'ab \n'),
  }));
  const d = summarize(msgs, 'me');
  assert.equal(d.total, msgs.length);
  assert.ok(d.for_you.every((x) => x.sender !== 'me'));
  assert.ok(d.questions.every((x) => x.sender !== 'me'));
  for (const x of [...d.for_you, ...d.decisions, ...d.alerts]) assert.ok(x.text.length <= 240 && !x.text.includes('\n'));
  const sum = Object.values(d.activity).reduce((a, b) => a + b, 0);
  assert.equal(sum, msgs.filter((m) => m.sender_kind !== 'system').length);
});

// ------------------------------------------------------------------ 8. store model checking: claims, tasks, memory, proposals
await suite('store model check: claims vs reference model', 15_000, (r, i) => {
  if (i % 300 === 0) globalThis.__store = new Store(':memory:'), globalThis.__model = [];
  const store = globalThis.__store, model = globalThis.__model;
  const owner = r.pick(['al', 'bo', 'cy']);
  const p = genPath(r).segs.join('/');
  const op = r.int(0, 2);
  if (op === 0) {
    const res = store.claim('room', owner, [p], null);
    const clash = model.find((c) => c.owner !== owner && overlaps(c.path, p));
    if (clash) assert.equal(res.conflicts.length, 1);
    else { assert.deepEqual(res.claimed, [p]); if (!model.some((c) => c.path === p)) model.push({ path: p, owner }); }
  } else if (op === 1) {
    const n = store.release('room', owner, [p]);
    const idx = model.findIndex((c) => c.path === p && c.owner === owner);
    assert.equal(n, idx >= 0 ? 1 : 0);
    if (idx >= 0) model.splice(idx, 1);
  } else {
    const [res] = store.checkPaths('room', [p], owner);
    const c = model.find((x) => x.owner !== owner && overlaps(x.path, p));
    assert.equal(res.free, !c);
  }
  assert.equal(store.claims('room').length, model.length);
});
await suite('store model check: tasks, memory, goal', 10_000, (r, i) => {
  if (i % 250 === 0) globalThis.__s2 = new Store(':memory:'), globalThis.__tasks = new Map(), globalThis.__mem = new Map();
  const s = globalThis.__s2, tasks = globalThis.__tasks, mem = globalThis.__mem;
  const op = r.int(0, 4);
  if (op === 0) { const t = s.createTask('r', { title: r.str(8), created_by: 'x' }); tasks.set(t.id, 'open'); }
  else if (op === 1 && tasks.size) { const id = r.pick([...tasks.keys()]); const st = r.pick(['open', 'in_progress', 'blocked', 'done']); s.updateTask(id, { status: st }); tasks.set(id, st); }
  else if (op === 2) { const kind = r.pick(['decision', 'convention', 'gotcha', 'fact']); const m = s.remember('r', { kind, text: r.str(10), author: 'x' }); mem.set(m.id, kind); }
  else if (op === 3 && mem.size) { const id = r.pick([...mem.keys()]); assert.equal(s.forget('r', id), 1); mem.delete(id); }
  else { const g = r.str(12); s.setGoal('r', { goal: g, set_by: 'x' }); assert.equal(s.goal('r').goal, g); }
  assert.equal(s.tasks('r').length, tasks.size);
  for (const st of ['open', 'done']) assert.equal(s.tasks('r', st).length, [...tasks.values()].filter((x) => x === st).length);
  assert.equal(s.recall('r', { limit: 10_000 }).length, mem.size);
});

// ------------------------------------------------------------------ 9. live HTTP: isolation, auth and impersonation under random traffic
const { server } = createHub({ dbFile: ':memory:' });
await new Promise((res) => server.listen(0, res));
const url = `http://localhost:${server.address().port}`;
const ROOMS = [];
for (let k = 0; k < 4; k++) { const room = `fuzz-${k}`; const { key } = await Hub.createRoom({ url }, room); ROOMS.push({ room, key, sent: new Set(), tokens: {} }); }
for (const R of ROOMS) {
  const admin = new Hub({ url, room: R.room, name: 'admin', key: R.key });
  for (const n of ['m1', 'm2']) R.tokens[n] = (await admin.invite(n, 'member')).member_token;
  R.tokens.obs = (await admin.invite('obs', 'observer')).member_token;
}
await suite('live hub: room isolation, auth, impersonation, observers', 6_000, async (r) => {
  const R = r.pick(ROOMS), other = r.pick(ROOMS.filter((x) => x !== R));
  const op = r.int(0, 5);
  if (op === 0) { // right key → can post; message lands only in its room
    const body = `msg-${R.room}-${r.str(10)}`;
    await new Hub({ url, room: R.room, name: r.pick(['al', 'bo']), key: R.key }).send(body);
    R.sent.add(body);
  } else if (op === 1) { // wrong key or no key → always 403
    const h = new Hub({ url, room: R.room, name: 'eve', key: r.bool() ? other.key : r.bool() ? 'cvk_' + r.str(24, B62) : null });
    await assert.rejects(h.history(), /private/);
  } else if (op === 2) { // another room's member token → rejected
    await assert.rejects(new Hub({ url, room: R.room, name: 'm1', member_token: other.tokens.m1 }).history(), /private/);
  } else if (op === 3) { // member token can't impersonate
    const victim = r.pick(['admin', 'm2', 'al']);
    await assert.rejects(new Hub({ url, room: R.room, name: victim, member_token: R.tokens.m1 }).send('fake'), /token is for/);
  } else if (op === 4) { // observer read-only
    await assert.rejects(new Hub({ url, room: R.room, name: 'obs', member_token: R.tokens.obs }).send('x'), /read-only/);
  } else { // isolation: a room's history never contains another room's messages
    const { messages } = await new Hub({ url, room: R.room, name: 'admin', key: R.key }).history({ limit: 500 });
    for (const m of messages) assert.ok(!m.body.startsWith('msg-') || m.body.startsWith(`msg-${R.room}-`), `leak: ${m.body} in ${R.room}`);
  }
});
server.close();

const total = results.reduce((a, b) => a + b.n, 0);
console.log(`\n${results.length} suites · ${total.toLocaleString()} generated cases · all passed · seed ${SEED}`);
