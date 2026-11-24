// Reads the local working tree (uncommitted edits) without ever writing to git.
// Only paths, line ranges and the branch name leave the machine, never code.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = (cwd, ...args) => run('git', args, { cwd, maxBuffer: 20 * 1024 * 1024 }).then((r) => r.stdout);

/**
 * @returns {Promise<null | { branch: string, base: string, files: {path: string, status: string, ranges: [number, number][]}[] }>}
 * null when cwd is not a git repo.
 */
export async function workingTreeEdits(cwd = process.cwd()) {
  try {
    await git(cwd, 'rev-parse', '--is-inside-work-tree');
  } catch { return null; }

  const branch = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => 'unknown')).trim();
  const base = (await git(cwd, 'rev-parse', '--short', 'HEAD').catch(() => '')).trim();
  const files = new Map();

  // tracked changes, staged + unstaged, against HEAD (falls back to the index for repos with no commits yet)
  const diff = await git(cwd, 'diff', '--unified=0', '--no-color', '--no-ext-diff', base ? 'HEAD' : '--cached').catch(() => '');
  parseUnifiedDiff(diff).forEach((f) => files.set(f.path, f));

  // untracked files count as whole-file edits
  const untracked = await git(cwd, 'ls-files', '--others', '--exclude-standard').catch(() => '');
  for (const path of untracked.split('\n').filter(Boolean)) files.set(path, { path, status: 'added', ranges: [] });

  return { branch, base, files: [...files.values()].slice(0, 500) };
}

/** Parse `git diff --unified=0` into files with line ranges (in the new version of each file). */
export function parseUnifiedDiff(text) {
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/ b\/(.+)$/);
      cur = { path: m ? m[1] : '', status: 'modified', ranges: [] };
      out.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('new file')) cur.status = 'added';
    else if (line.startsWith('deleted file')) cur.status = 'deleted';
    else if (line.startsWith('rename to ')) { cur.path = line.slice(10); cur.status = 'renamed'; }
    else if (line.startsWith('@@')) {
      // @@ -a,b +c,d @@ : c = start in new file, d = count (0 = pure deletion at c)
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      if (m) {
        const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
        cur.ranges.push(count === 0 ? [start, start] : [start, start + count - 1]);
      }
    }
  }
  return out;
}
