import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';
import { overlaps } from '../src/hub/store.js';

let server, url;
const agent = (name, room = 't') => new Hub({ url, room, name, client: 'test', owner: 'tester', token: 'secret' });

before(async () => {
  ({ server } = createHub({ dbFile: ':memory:', token: 'secret' }));
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
});
after(() => server.close());

test('rejects requests without token', async () => {
  const res = await fetch(`${url}/api/rooms/t/state`);
  assert.equal(res.status, 401);
});

test('agents exchange messages and inbox tracks read cursors', async () => {
  const a = agent('alice-claude'), b = agent('bob-codex');
  await a.join(); await b.join();
  await a.send('hey @bob-codex, I changed the User type');
  const inbox = await b.inbox();
  const chats = inbox.messages.filter((m) => m.sender_kind !== 'system');
  assert.equal(chats.length, 1);
  assert.deepEqual(chats[0].mentions, ['bob-codex']);
  assert.equal(inbox.mentions, 1);
  assert.equal((await b.inbox()).messages.length, 0, 'cursor advanced');
});

test('long-poll inbox wakes on new message', async () => {
  const a = agent('a2'), b = agent('b2');
  await a.join(); await b.join(); await b.inbox();
  const pending = b.inbox({ wait: 5 });
  setTimeout(() => a.send('ping'), 100);
  const { messages } = await pending;
  assert.ok(messages.some((m) => m.body === 'ping'));
});

test('ask blocks until a reply arrives', async () => {
  const a = agent('asker'), b = agent('answerer');
  await a.join(); await b.join(); await b.inbox();
  const asking = a.ask(['answerer'], 'which port does the API use?', 5);
  const { messages } = await b.inbox({ wait: 5 });
  const q = messages.find((m) => m.type === 'question');
  await b.send('3000', { reply_to: q.id });
  const { answer } = await asking;
  assert.equal(answer.body, '3000');
});

test('file claims detect conflicts, including directories', async () => {
  const a = agent('c1', 'claims'), b = agent('c2', 'claims');
  await a.join(); await b.join();
  assert.deepEqual((await a.claim(['src/auth/'], 'oauth')).claimed, ['src/auth/']);
  const r = await b.claim(['src/auth/login.ts', 'src/db.ts']);
  assert.deepEqual(r.claimed, ['src/db.ts']);
  assert.equal(r.conflicts[0].held_by, 'c1');
  const chk = await b.check(['src/auth/x.ts']);
  assert.equal(chk.results[0].free, false);
  await a.release();
  assert.equal((await b.check(['src/auth/x.ts'])).results[0].free, true);
});

test('task board: create, claim, conflict, finish', async () => {
  const a = agent('t1', 'tasks'), b = agent('t2', 'tasks');
  const { task } = await a.createTask('write tests');
  await b.updateTask(task.id, { claim: true });
  await assert.rejects(a.updateTask(task.id, { claim: true }), /already owned/);
  const done = await b.updateTask(task.id, { status: 'done' });
  assert.equal(done.task.status, 'done');
});

test('path overlap', () => {
  assert.ok(overlaps('src', 'src/a.js'));
  assert.ok(overlaps('./src/a.js', 'src/a.js'));
  assert.ok(!overlaps('src/a', 'src/ab.js'));
});

test('a message that @mentions someone before they ever joined is still delivered', async () => {
  const h = agent('early-human', 'late');
  await h.send('general chatter nobody needs');
  await h.send('@late-agent can you check the build?');
  const a = agent('late-agent', 'late');
  const { messages } = await a.inbox();
  const chats = messages.filter((m) => m.sender_kind !== 'system');
  assert.equal(chats.length, 1);
  assert.match(chats[0].body, /check the build/);
});
