import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';
import { lineDiff } from '../src/hub/extras.js';

let server, url;
const agent = (name, room, extra = {}) => new Hub({ url, room, name, client: 'test', owner: extra.owner ?? 'boss', ...extra });
const human = async (name, room, extra = {}) => { const h = new Hub({ url, room, name, ...extra }); await h.req('POST', '/join', { name, kind: 'human', client: 'test' }); return h; };
before(async () => { ({ server } = createHub({ dbFile: ':memory:' })); await new Promise((r) => server.listen(0, r)); url = `http://localhost:${server.address().port}`; });
after(() => server.close());

test('roles: invites bind a name, block impersonation, observers are read-only, revoke works', async () => {
  const { key } = await Hub.createRoom({ url }, 'roles');
  const admin = new Hub({ url, room: 'roles', name: 'lead', key });
  const { member_token: mt } = await admin.invite('dev1', 'member');
  const { member_token: ot } = await admin.invite('viewer', 'observer');
  const dev = new Hub({ url, room: 'roles', name: 'dev1', member_token: mt });
  await dev.join(); await dev.send('hello');
  assert.equal((await dev.whoami()).identity.role, 'member');
  await assert.rejects(new Hub({ url, room: 'roles', name: 'lead', member_token: mt }).send('I am lead'), /token is for "dev1"/);
  await assert.rejects(dev.invite('x'), /needs admin/);
  const obs = new Hub({ url, room: 'roles', name: 'viewer', member_token: ot });
  await obs.join();
  assert.ok((await obs.history()).messages.length > 0);
  await assert.rejects(obs.send('hi'), /read-only/);
  await admin.revoke('dev1');
  await assert.rejects(dev.send('still here?'), /private/);
  const inv = (await admin.audit()).audit.find((a) => a.action.includes('/invites'));
  assert.match(inv.actor, /^room-admin/, 'audit names the inviter, not the invitee');
});

test('contracts: publish, subscribe, change alerts dependents with diff, breaking flagged', async () => {
  const be = agent('backend', 'c'), fe = agent('frontend', 'c');
  await be.join(); await fe.join();
  await be.publishContract('POST /api/login', 'req: {email, password}\nres: {token}', { kind: 'api' });
  const got = await fe.contract('POST /api/login'); assert.equal(got.contract.version, 1);
  await fe.subscribeContract('POST /api/login'); await fe.inbox();
  const same = await be.publishContract('POST /api/login', 'req: {email, password}\nres: {token}');
  assert.equal(same.changed, false);
  const r = await be.publishContract('POST /api/login', 'req: {email, password}\nres: {accessToken, refreshToken}', { breaking: true, note: 'split tokens' });
  assert.equal(r.contract.version, 2);
  const { messages } = await fe.inbox();
  const a = messages.find((m) => m.type === 'alert');
  assert.ok(a.mentions.includes('frontend')); assert.match(a.body, /BREAKING/); assert.match(a.body, /- res: \{token\}/); assert.match(a.body, /\+ res: \{accessToken/);
  assert.equal((await fe.contracts()).contracts[0].history.length, 2);
});

test('lineDiff', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nc\nd'), { added: ['d'], removed: ['b'] });
  assert.deepEqual(lineDiff('x\nx', 'x'), { added: [], removed: ['x'] });
});

test('peer request: answered by the other agent', async () => {
  const a = agent('pa', 'peer'), b = agent('pb', 'peer');
  await a.join(); await b.join(); await b.inbox();
  const asking = a.ask(['pb'], 'paste your User type', 5, 'request');
  const { messages } = await b.inbox({ wait: 5 });
  const req = messages.find((m) => m.type === 'request');
  assert.ok(req);
  await b.send('type User = { id: string }', { reply_to: req.id });
  assert.match((await asking).answer.body, /type User/);
});

test('delegation: propose → only delegate/owner respond → accept → result back to delegator', async () => {
  const a = agent('da', 'del'), b = agent('db', 'del', { owner: 'bobby' }), stranger = agent('dx', 'del');
  await a.join(); await b.join(); await stranger.join(); const bobby = await human('bobby', 'del');
  const { task } = await a.delegate('db', 'write login tests', 'cover 401s');
  assert.equal(task.status, 'proposed'); assert.equal(task.delegated_by, 'da');
  await assert.rejects(stranger.respondDelegation(task.id, true), /only the delegate/);
  await assert.rejects(a.delegate('da', 'self'), /yourself/);
  const r = await bobby.respondDelegation(task.id, true, 'go ahead');  // owner may answer for their agent
  assert.equal(r.task.status, 'in_progress');
  await assert.rejects(stranger.taskResult(task.id, 'x'), /belongs to db/);
  await a.inbox();
  await b.taskResult(task.id, 'added 6 tests, PR #12');
  const { messages } = await a.inbox();
  assert.ok(messages.some((m) => m.mentions.includes('da') && /PR #12/.test(m.body)));
  // decline path
  const { task: t2 } = await a.delegate('db', 'rewrite in Rust');
  assert.equal((await b.respondDelegation(t2.id, false, 'out of scope')).task.status, 'open');
});

test('approvals: agent waits; agents cannot approve; only the right human decides', async () => {
  const bot = agent('bot', 'appr', { owner: 'alice' });
  await bot.join(); const alice = await human('alice', 'appr'); const mallory = await human('mallory', 'appr');
  const pending = bot.requestApproval('drop table sessions', 'stale data', 5);
  await new Promise((r) => setTimeout(r, 100));
  const { approvals } = await alice.approvals('pending');
  const id = approvals[0].id;
  assert.equal(approvals[0].approver, 'alice');
  await assert.rejects(bot.decideApproval(id, true), /only humans/);
  await assert.rejects(mallory.decideApproval(id, true), /only alice/);
  await alice.decideApproval(id, true, 'ok, backed up');
  const { approval } = await pending;
  assert.equal(approval.status, 'approved'); assert.equal(approval.decided_by, 'alice');
  await assert.rejects(alice.decideApproval(id, false), /already approved/);
  const timeout = await bot.requestApproval('force push main', null, 1);
  assert.equal(timeout.approval.status, 'pending');
});

test('digest and standup summarise activity', async () => {
  const a = agent('sa', 'st'), b = agent('sb', 'st');
  await a.join(); await b.join(); await b.inbox();
  await a.send('@sb heads up: schema changed', { type: 'alert' });
  await a.send('we use zod everywhere', { type: 'decision' });
  const { task } = await a.createTask('build login'); await a.updateTask(task.id, { claim: true }); await a.updateTask(task.id, { status: 'done' });
  const d = await b.digest();
  assert.equal(d.for_you.length, 1); assert.equal(d.decisions.length, 1); assert.ok(d.finished.length >= 1);
  const s = await b.standup(24);
  assert.deepEqual(s.members.find((m) => m.name === 'sa').done, [`#${task.id} build login`]);
  const tl = await b.timeline(); assert.ok(tl.messages.length >= 4); assert.ok(tl.messages[0].id < tl.messages.at(-1).id);
});

test('integrations: outgoing Slack webhook + incoming slash command, no echo', async () => {
  const got = [];
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
  await new Promise((r) => mock.listen(0, r));
  try {
    const a = agent('ia', 'integ'); await a.join();
    const { incoming_url_path } = await a.addIntegration('slack', `http://localhost:${mock.address().port}/hook`);
    await a.send('use Postgres', { type: 'decision' });
    await a.send('just chatting');                                   // not in default events
    const res = await fetch(url + incoming_url_path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'text=hello+from+slack&user_name=carol' });
    assert.equal(res.status, 200);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.length, 1); assert.match(got[0].text, /use Postgres/);
    const { messages } = await a.history();
    const inc = messages.find((m) => m.body === 'hello from slack');
    assert.equal(inc.sender, 'carol'); assert.equal(inc.sender_kind, 'human');
    assert.equal((await fetch(url + '/api/incoming/nope', { method: 'POST', body: '{"text":"x"}' })).status, 404);
  } finally { mock.close(); }
});

test('secrets are redacted before storage even if a client skips redaction', async () => {
  const raw = new Hub({ url, room: 'sec', name: 'leaky' });
  const { message } = await raw.req('POST', '/messages', { sender: 'leaky', body: 'my key is AKIAABCDEFGHIJKLMNOP and password=hunter22x' });
  assert.ok(!message.body.includes('AKIAABCDEFGHIJKLMNOP')); assert.ok(!message.body.includes('hunter22x'));
  assert.deepEqual(message.meta.redacted.sort(), ['aws-access-key', 'credential-assignment']);
});
