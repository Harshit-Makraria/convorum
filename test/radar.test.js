import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHub } from '../src/hub/server.js';
import { findOverlaps } from '../src/hub/store.js';
import { parseUnifiedDiff, workingTreeEdits } from '../src/radar/git.js';
import { Hub } from '../src/client.js';

let server, url;
const tmp = [];
const m = (name, room) => new Hub({ url, room, name, client: 'test', owner: 'o' });
before(async () => { ({ server } = createHub({ dbFile: ':memory:' })); await new Promise((r) => server.listen(0, r)); url = `http://localhost:${server.address().port}`; });
after(() => { server.close(); tmp.forEach((d) => rmSync(d, { recursive: true, force: true })); });

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'convorum-')); tmp.push(d);
  const g = (...a) => execFileSync('git', a, { cwd: d });
  g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  writeFileSync(join(d, 'app.js'), Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
  g('add', '.'); g('commit', '-qm', 'init');
  return d;
}
const edit = (d, from, to) => {
  const lines = Array.from({ length: 50 }, (_, i) => (i + 1 >= from && i + 1 <= to ? `changed ${i + 1}` : `line ${i + 1}`));
  writeFileSync(join(d, 'app.js'), lines.join('\n') + '\n');
};

test('parses unified diffs into line ranges', () => {
  const f = parseUnifiedDiff('diff --git a/x.js b/x.js\n@@ -3,2 +3,4 @@\n+a\n@@ -10 +12 @@\n+b\n@@ -20,3 +21,0 @@\ndiff --git a/n.js b/n.js\nnew file mode 100644\n@@ -0,0 +1,5 @@');
  assert.deepEqual(f[0], { path: 'x.js', status: 'modified', ranges: [[3, 6], [12, 12], [21, 21]] });
  assert.equal(f[1].status, 'added');
});

test('overlap detection: line-level with slack, file-level, none', () => {
  const e = (member, path, ranges) => ({ member, path, ranges });
  assert.equal(findOverlaps([e('a', 'x', [[1, 5]]), e('b', 'x', [[7, 9]])])[0].level, 'lines');   // within 3 lines
  assert.equal(findOverlaps([e('a', 'x', [[1, 5]]), e('b', 'x', [[40, 45]])])[0].level, 'file');
  assert.equal(findOverlaps([e('a', 'x', [[1, 5]]), e('b', 'y', [[1, 5]])]).length, 0);
  assert.equal(findOverlaps([e('a', 'x', [[1, 5]]), e('a', 'x', [[1, 5]])]).length, 0);
});

test('reads real uncommitted edits from git (no commits needed)', async () => {
  const d = repo(); edit(d, 10, 12); writeFileSync(join(d, 'new.js'), 'x');
  const wt = await workingTreeEdits(d);
  assert.deepEqual(wt.files.find((f) => f.path === 'app.js').ranges, [[10, 12]]);
  assert.equal(wt.files.find((f) => f.path === 'new.js').status, 'added');
  assert.equal(await workingTreeEdits(tmpdir()), null);
});

test('two teammates editing the same lines get warned before committing', async () => {
  const da = repo(), db = repo();
  edit(da, 10, 15); edit(db, 14, 20);
  const a = m('alice-claude', 'radar'), b = m('bob-codex', 'radar');
  await a.join(); await b.join(); await b.inbox();
  const wa = await workingTreeEdits(da), wb = await workingTreeEdits(db);
  await a.pushEdits(wa.branch, wa.files);
  const { overlaps } = await b.pushEdits(wb.branch, wb.files);
  assert.equal(overlaps.length, 1); assert.equal(overlaps[0].level, 'lines');
  const { messages } = await b.inbox();
  const alert = messages.find((x) => x.type === 'alert');
  assert.ok(alert && alert.mentions.includes('alice-claude') && alert.mentions.includes('bob-codex'));
  assert.match(alert.body, /app\.js/);
  // pushing the same state again does not spam
  await b.pushEdits(wb.branch, wb.files);
  assert.equal((await b.inbox()).messages.filter((x) => x.type === 'alert').length, 0);
  // bob commits/reverts -> cleared
  await b.pushEdits(wb.branch, []);
  assert.ok((await a.inbox()).messages.some((x) => /cleared/.test(x.body)));
  assert.equal((await a.brief()).collisions.length, 0);
});

test('editing a file someone else claimed raises an alert', async () => {
  const a = m('ca', 'rc'), b = m('cb', 'rc');
  await a.join(); await b.join();
  await a.claim(['src/auth/'], 'oauth refactor'); await b.inbox();
  await b.pushEdits('main', [{ path: 'src/auth/login.ts', status: 'modified', ranges: [[1, 3]] }]);
  assert.ok((await b.inbox()).messages.some((x) => x.type === 'alert' && /claimed/.test(x.body)));
});

test('team memory: remember, recall, forget, brief, and auto-saved decisions', async () => {
  const a = m('ma', 'mem'), b = m('mb', 'mem');
  await a.join(); await b.join();
  const { memory } = await a.remember('Use pnpm, not npm', 'convention', ['tooling']);
  assert.equal((await b.recall('pnpm')).memories[0].id, memory.id);
  assert.equal((await b.recall('tooling')).memories.length, 1);
  const { proposal } = await a.propose('Store sessions in Redis');
  await b.vote(proposal.id, 'agree', 'scales');
  const decisions = (await b.recall(null, 'decision')).memories;
  assert.ok(decisions.some((d) => d.text.startsWith('Store sessions in Redis')));
  assert.ok((await b.brief()).memory.length >= 2);
  await a.forget(memory.id);
  assert.equal((await b.recall('pnpm')).memories.length, 0);
});
