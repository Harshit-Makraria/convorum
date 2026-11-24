import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';

let server, url, client;
before(async () => {
  ({ server } = createHub({ dbFile: ':memory:' }));
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ['bin/convorum.js', 'mcp'],
    env: { ...process.env, CONVORUM_URL: url, CONVORUM_ROOM: 'mcp', CONVORUM_NAME: 'claude-1', CONVORUM_CLIENT: 'claude-code' } }));
});
after(async () => { await client.close(); server.close(); });

const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

test('MCP bridge exposes tools and talks to the hub', async () => {
  const { tools } = await client.listTools();
  for (const t of ['chat_send', 'chat_read', 'chat_wait', 'chat_ask', 'team_status', 'claim_files', 'task_create']) assert.ok(tools.some((x) => x.name === t), t);
  assert.match(await call('chat_send', { body: 'hello team' }), /Sent #\d+/);
  const human = new Hub({ url, room: 'mcp', name: 'harshit' });
  await human.send('@claude-1 please also add tests', { sender_kind: 'human' });
  assert.match(await call('team_status'), /📬 1 unread.*1 mention you/s);
  assert.match(await call('chat_read'), /harshit \(human\): @claude-1 please also add tests/);
  assert.match(await call('claim_files', { paths: ['src/'] }), /Claimed: src\//);
});
