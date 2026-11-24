import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';

let server, url;
before(async () => { ({ server } = createHub({ dbFile: ':memory:' })); await new Promise((r) => server.listen(0, r)); url = `http://localhost:${server.address().port}`; });
after(() => server.close());

test('private rooms: each team has its own key; other teams are locked out', async () => {
  const { key: keyA } = await Hub.createRoom({ url }, 'team-a');
  const { key: keyB } = await Hub.createRoom({ url }, 'team-b');
  assert.match(keyA, /^cvk_/);
  const alice = new Hub({ url, room: 'team-a', name: 'alice', key: keyA });
  await alice.join(); await alice.send('secret plan A');
  const outsider = new Hub({ url, room: 'team-a', name: 'eve', key: keyB });       // team B's key
  await assert.rejects(outsider.history(), /private/);
  await assert.rejects(new Hub({ url, room: 'team-a', name: 'eve' }).history(), /private/); // no key
  const bob = new Hub({ url, room: 'team-b', name: 'bob', key: keyB });
  await bob.join();
  const { messages } = await bob.history();
  assert.ok(!messages.some((m) => m.body.includes('secret plan A')), 'no leakage between rooms');
});

test('room names cannot be hijacked and listing is admin-only', async () => {
  await assert.rejects(Hub.createRoom({ url }, 'team-a'), /already exists/);
  const res = await fetch(`${url}/api/rooms`);
  assert.equal(res.status, 403);
});

test('websocket rejects wrong room key', async () => {
  const { key } = await Hub.createRoom({ url }, 'ws-room');
  const ok = await new Promise((r) => { const w = new WebSocket(`${url.replace('http', 'ws')}/ws?room=ws-room&key=${key}`); w.onmessage = () => { w.close(); r(true); }; w.onerror = () => r(false); });
  const bad = await new Promise((r) => { const w = new WebSocket(`${url.replace('http', 'ws')}/ws?room=ws-room&key=nope`); w.onmessage = () => r(true); w.onerror = () => r(false); });
  assert.equal(ok, true); assert.equal(bad, false);
});

test('two sessions in the same project with the same name get distinct identities', async () => {
  const cfg = () => ({ url, room: 'multi', name: 'harshit-claude' });
  const s1 = new Hub(cfg()), s2 = new Hub(cfg());
  await s1.join(); await s2.join();
  assert.equal(s1.me, 'harshit-claude'); assert.equal(s2.me, 'harshit-claude-2');
  await s2.send('@harshit-claude hi from my other window');
  assert.equal((await s1.inbox()).mentions, 1);
  // same session rejoining keeps its name
  await s1.join(); assert.equal(s1.me, 'harshit-claude');
});

test('same name in different rooms is independent', async () => {
  const a = new Hub({ url, room: 'proj-1', name: 'me' }), b = new Hub({ url, room: 'proj-2', name: 'me' });
  await a.join(); await b.join();
  await a.remember('proj-1 uses Postgres', 'fact');
  assert.equal((await b.recall('Postgres')).memories.length, 0);
});

test('credentials in REST query strings are ignored (only headers count); responses send no Referer', async () => {
  const { key } = await Hub.createRoom({ url }, 'qs-room');
  const viaQuery = await fetch(`${url}/api/rooms/qs-room/messages?key=${key}`);
  assert.equal(viaQuery.status, 403, 'room key in URL must not authenticate REST calls');
  const viaHeader = await fetch(`${url}/api/rooms/qs-room/messages`, { headers: { 'x-room-key': key } });
  assert.equal(viaHeader.status, 200);
  assert.equal(viaHeader.headers.get('referrer-policy'), 'no-referrer');
});

test('hub token: header works, query string does not, wrong token rejected', async () => {
  const { server: s2 } = createHub({ dbFile: ':memory:', token: 'hub-secret-placeholder' });
  await new Promise((r) => s2.listen(0, r));
  const u = `http://localhost:${s2.address().port}/api/rooms/t/messages`;
  try {
    assert.equal((await fetch(u, { headers: { authorization: 'Bearer hub-secret-placeholder' } })).status, 200);
    assert.equal((await fetch(u, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${u}?token=hub-secret-placeholder`)).status, 401);
  } finally { s2.close(); }
});
