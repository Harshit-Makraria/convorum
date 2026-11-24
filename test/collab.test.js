import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHub } from '../src/hub/server.js';
import { Hub } from '../src/client.js';
import { shouldWake } from '../src/agent/runner.js';
import { teammateProtocol } from '../src/mcp/server.js';

let server, url;
const m = (name, room, kind = 'agent') => new Hub({ url, room, name, client: 'test', owner: 'o' });
before(async () => { ({ server } = createHub({ dbFile: ':memory:' })); await new Promise((r) => server.listen(0, r)); url = `http://localhost:${server.address().port}`; });
after(() => server.close());

test('goal and milestones', async () => {
  const a = m('ga', 'g'); await a.join();
  await a.setGoal({ goal: 'Ship a todo app', milestones: [{ title: 'API', done: false }] });
  await a.setGoal({ milestones: [{ title: 'API', done: true }] });
  const { goal } = await a.goal();
  assert.equal(goal.goal, 'Ship a todo app'); assert.equal(goal.milestones[0].done, true);
  const { messages } = await a.history();
  assert.ok(messages.some((x) => x.body.includes('milestone reached: API')));
});

test('proposals reach consensus by majority of online members', async () => {
  const [a, b, c] = ['pa', 'pb', 'pc'].map((n) => m(n, 'p'));
  for (const x of [a, b, c]) await x.join();
  const { proposal } = await a.propose('Use SQLite', 'simple');
  assert.equal(proposal.status, 'open');
  const r = await b.vote(proposal.id, 'agree', 'fine');
  assert.equal(r.proposal.status, 'accepted');                // 2 of 3 online
  await assert.rejects(c.vote(proposal.id, 'disagree', 'late'), /already accepted/);
});

test('only humans can override a decision', async () => {
  const a = m('oa', 'o'), h = new Hub({ url, room: 'o', name: 'boss' });
  await a.join(); await h.req('POST', '/join', { name: 'boss', kind: 'human' });
  const { proposal } = await a.propose('Rewrite in Rust');
  await assert.rejects(a.decide(proposal.id, 'accepted'), /only humans/);
  assert.equal((await h.decide(proposal.id, 'rejected')).proposal.status, 'rejected');
});

test('brief lists questions and proposals waiting on you', async () => {
  const a = m('ba', 'b'), b = m('bb', 'b'); await a.join(); await b.join();
  await a.send('@bb which port?', { type: 'question' });
  await a.propose('Add CI');
  const brief = await b.brief();
  assert.equal(brief.asked_of_you.questions.length, 1);
  assert.equal(brief.asked_of_you.proposals_to_vote.length, 1);
});

test('wake rules ignore acks, self, status and system', () => {
  const base = { sender: 'x', sender_kind: 'agent', type: 'chat', mentions: [], meta: {} };
  assert.equal(shouldWake({ ...base, body: '@me hi', mentions: ['me'] }, 'me'), true);
  assert.equal(shouldWake({ ...base, body: 'thanks!', mentions: ['me'] }, 'me'), false);
  assert.equal(shouldWake({ ...base, sender: 'me', body: '@me', mentions: ['me'] }, 'me'), false);
  assert.equal(shouldWake({ ...base, body: 'random chatter' }, 'me'), false);
  assert.equal(shouldWake({ ...base, type: 'question', body: 'anyone know?' }, 'me'), true);
});

test('protocol puts owner first and encodes autonomy', () => {
  const p = teammateProtocol({ name: 'n', owner: 'alice', room: 'r', autonomy: 'observe', owner_rules: 'never touch infra/' });
  assert.match(p, /Your owner \(alice\) comes first/); assert.match(p, /never touch infra/); assert.match(p, /AUTONOMY LEVEL: observe/);
});

test('autonomous runner wakes a headless agent that answers by itself', async () => {
  const env = { ...process.env, CONVORUM_URL: url, CONVORUM_ROOM: 'run', CONVORUM_NAME: 'bot', CONVORUM_CLIENT: 'test',
    CONVORUM_AGENT_COMMAND: `"${process.execPath}" test/fixtures/fake-agent.js` };
  const child = spawn(process.execPath, ['bin/convorum.js', 'agent', '--cooldown', '0'], { env });
  try {
    const h = new Hub({ url, room: 'run', name: 'human1' });
    for (let i = 0; i < 50 && !(await h.state()).members.some((x) => x.name === 'bot'); i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const { question, answer } = await h.ask(['bot'], 'are you there?', 10);
    assert.ok(answer, 'bot replied'); assert.equal(answer.sender, 'bot'); assert.equal(answer.reply_to, question.id);
  } finally { child.kill(); }
});
