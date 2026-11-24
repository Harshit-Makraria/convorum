// Full end-to-end scenario: two real MCP agent processes (each in its own git checkout) + a human,
// in a private room with personal member tokens, exercising every feature through the actual agent tools.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';

const BIN = resolve('bin/convorum.js');
let server, url, key, alice, bob, harshit, dirs = [];

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'convorum-e2e-')); dirs.push(d);
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'auth.js'), Array.from({ length: 40 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');
  g('add', '.'); g('commit', '-qm', 'init');
  return d;
}
async function agent(name, client, token, cwd) {
  const c = new Client({ name, version: '1' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, 'mcp'], cwd,
    env: { ...process.env, CONVORUM_URL: url, CONVORUM_ROOM: 'hackathon', CONVORUM_NAME: name, CONVORUM_CLIENT: client,
      CONVORUM_OWNER: name === 'alice-claude' ? 'harshit' : 'priya', CONVORUM_MEMBER_TOKEN: token, CONVORUM_AUTONOMY: 'converse' } }));
  c.call = async (tool, args = {}) => { const r = await c.callTool({ name: tool, arguments: args }); const t = r.content[0].text; if (r.isError) throw new Error(t); return t; };
  return c;
}

before(async () => {
  ({ server } = createHub({ dbFile: ':memory:' }));
  await new Promise((r) => server.listen(0, r));
  url = `http://localhost:${server.address().port}`;
  ({ key } = await Hub.createRoom({ url }, 'hackathon'));
  const admin = new Hub({ url, room: 'hackathon', name: 'harshit', key });
  const ta = (await admin.invite('alice-claude', 'member')).member_token;
  const tb = (await admin.invite('bob-codex', 'member')).member_token;
  harshit = admin; await harshit.req('POST', '/join', { name: 'harshit', kind: 'human', client: 'dashboard' });
  alice = await agent('alice-claude', 'claude-code', ta, repo());
  bob = await agent('bob-codex', 'codex', tb, repo());
  alice.dir = dirs[0]; bob.dir = dirs[1];
});
after(async () => { await alice?.close(); await bob?.close(); server.close(); dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); });

test('full team scenario through real agent tools', async () => {
  // agents get the teammate protocol as server instructions
  assert.match(alice.getInstructions(), /Your owner \(harshit\) comes first/);
  const tools = (await alice.listTools()).tools.map((t) => t.name);
  for (const t of ['team_brief', 'propose', 'vote', 'edit_radar', 'remember', 'contract_publish', 'peer_request', 'delegate', 'request_approval', 'catch_up', 'standup'])
    assert.ok(tools.includes(t), `tool ${t}`);
  assert.ok(tools.length >= 30, `${tools.length} tools`);

  // 1. human sets the goal; both agents see it in their brief
  await harshit.setGoal({ goal: 'Ship a todo app with login by Sunday', milestones: [{ title: 'auth API' }, { title: 'UI' }] });
  await alice.call('set_status', { status: 'working', working_on: 'auth API' });
  assert.match(await bob.call('team_brief'), /GOAL: Ship a todo app/);

  // 2. idea → vote → accepted decision → team memory
  await alice.call('propose', { title: 'Use JWT in httpOnly cookies', rationale: 'avoids XSS token theft' });
  const brief = await bob.call('team_brief');
  const pid = Number(brief.match(/proposal P(\d+)/)[1]);
  assert.match(await bob.call('vote', { proposal_id: pid, vote: 'agree', reason: 'standard practice' }), /accepted/);
  assert.match(await bob.call('recall', { query: 'JWT' }), /\[decision\] Use JWT in httpOnly cookies/);
  await alice.call('remember', { text: 'Use pnpm, not npm', kind: 'convention' });
  assert.match(await bob.call('team_brief'), /TEAM MEMORY[\s\S]*Use pnpm/);

  // 3. file claims
  assert.match(await alice.call('claim_files', { paths: ['src/auth/'], note: 'login endpoint' }), /Claimed: src\/auth\//);
  assert.match(await bob.call('claim_files', { paths: ['src/auth/session.js'] }), /CONFLICTS[\s\S]*alice-claude/);
  assert.match(await bob.call('check_files', { paths: ['src/ui/'] }), /free/);

  // 4. edit radar: both edit auth.js lines 10-15 / 12-20 in their own checkouts, uncommitted
  const edit = (d, a, b) => writeFileSync(join(d, 'auth.js'), Array.from({ length: 40 }, (_, i) => (i + 1 >= a && i + 1 <= b ? `changed ${i}` : `// line ${i + 1}`)).join('\n') + '\n');
  edit(alice.dir, 10, 15); edit(bob.dir, 12, 20);
  await alice.call('edit_radar');
  const radar = await bob.call('edit_radar');
  assert.match(radar, /YOUR COLLISIONS[\s\S]*auth\.js with alice-claude/);
  assert.match(await alice.call('team_brief'), /EDIT COLLISIONS[\s\S]*auth\.js/);
  assert.ok((await harshit.history({ limit: 200 })).messages.some((m) => m.type === 'alert' && /Edit collision ahead/.test(m.body)));

  // 5. contracts: alice publishes, bob reads (subscribes), alice makes a breaking change → bob alerted
  await alice.call('contract_publish', { name: 'POST /api/login', spec: 'req {email,password} → res {token}', kind: 'api' });
  assert.match(await bob.call('contract_get', { name: 'POST /api/login' }), /now subscribed/);
  await bob.call('chat_read');
  await alice.call('contract_publish', { name: 'POST /api/login', spec: 'req {email,password} → res {accessToken}', breaking: true, note: 'renamed token' });
  assert.match(await bob.call('chat_read'), /BREAKING change contract POST \/api\/login → v2/);

  // 6. peer request answered by the other agent
  const asking = alice.call('peer_request', { to: 'bob-codex', request: 'what port does your UI dev server use?', timeout_seconds: 20 });
  await new Promise((r) => setTimeout(r, 300));
  const inbox = await bob.call('chat_read');
  const rid = Number(inbox.match(/#(\d+) [^\n]*\[request\]/)[1]);
  await bob.call('chat_send', { body: '5173 (vite)', reply_to: rid });
  assert.match(await asking, /bob-codex: 5173/);

  // 7. delegation: alice → bob, bob accepts, finishes with a result
  await alice.call('delegate', { to: 'bob-codex', title: 'build the login form', details: 'use POST /api/login v2' });
  const tid = Number((await bob.call('task_list')).match(/#(\d+) \[proposed\] build the login form/)[1]);
  assert.match(await bob.call('respond_delegation', { task_id: tid, accept: true }), /in_progress/);
  await alice.call('chat_read');
  await bob.call('task_result', { task_id: tid, result: 'form done, PR #7' });
  assert.match(await alice.call('chat_read'), /finished task #\d+: build the login form[\s\S]*PR #7/);

  // 8. approval: alice asks harshit (her owner) and blocks; harshit approves from the dashboard
  const approving = alice.call('request_approval', { action: 'drop the sessions table', details: 'dev data only', timeout_seconds: 20 });
  let a; for (let i = 0; i < 50 && !a; i++) { a = (await harshit.approvals('pending')).approvals[0]; if (!a) await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(a.approver, 'harshit');
  await harshit.decideApproval(a.id, true, 'go');
  assert.match(await approving, /APPROVED by harshit/);

  // 9. secrets typed by an agent never reach the room
  await bob.call('chat_send', { body: 'debug: OPENAI key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' });
  assert.ok(!(await harshit.history({ limit: 5 })).messages.some((m) => m.body.includes('sk-proj-abcdef')));

  // 10. catch-up, stand-up, timeline, audit
  assert.match(await alice.call('catch_up', { hours: 1 }), /DECISIONS[\s\S]*FINISHED/);
  assert.match(await bob.call('standup'), /bob-codex[\s\S]*done: #\d+ build the login form/);
  assert.ok((await harshit.timeline()).messages.length > 20);
  assert.ok((await harshit.audit()).audit.length > 10);

  // 11. member tokens: alice's agent cannot pretend to be bob
  await assert.rejects(new Hub({ url, room: 'hackathon', name: 'bob-codex', member_token: (await harshit.invite('alice2', 'member')).member_token }).send('x'), /token is for/);

  // 12. milestone + clean leave releases claims
  await alice.call('goal_set', { milestones: [{ title: 'auth API', done: true }, { title: 'UI', done: false }] });
  assert.ok((await harshit.history({ limit: 20 })).messages.some((m) => /milestone reached: auth API/.test(m.body)));
  assert.match(await alice.call('release_files', {}), /Released 1/);
});
