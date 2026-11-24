// SQLite persistence for Convorum (uses Node's built-in node:sqlite — no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_kind TEXT NOT NULL DEFAULT 'agent',   -- agent | human | system
  type TEXT NOT NULL DEFAULT 'chat',           -- chat | question | answer | status | decision | handoff | alert
  body TEXT NOT NULL,
  mentions TEXT NOT NULL DEFAULT '[]',
  reply_to INTEGER,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room, id);

CREATE TABLE IF NOT EXISTS members (
  room TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  client TEXT,                 -- claude-code | codex | cursor | human | ...
  owner TEXT,                  -- the human this agent works for
  status TEXT NOT NULL DEFAULT 'idle',
  working_on TEXT,
  last_read INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER NOT NULL,
  PRIMARY KEY (room, name)
);

CREATE TABLE IF NOT EXISTS claims (
  room TEXT NOT NULL,
  path TEXT NOT NULL,
  owner TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room, path)
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | in_progress | blocked | done
  owner TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_room ON tasks(room, status);

CREATE TABLE IF NOT EXISTS goals (
  room TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  milestones TEXT NOT NULL DEFAULT '[]',   -- [{title, done}]
  set_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  author TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',     -- open | accepted | rejected | withdrawn
  votes TEXT NOT NULL DEFAULT '{}',        -- {name: {vote: agree|disagree|abstain, reason}}
  message_id INTEGER,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS edits (          -- live, uncommitted working-tree edits per member
  room TEXT NOT NULL,
  member TEXT NOT NULL,
  path TEXT NOT NULL,
  status TEXT NOT NULL,
  ranges TEXT NOT NULL DEFAULT '[]',
  branch TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room, member, path)
);

CREATE TABLE IF NOT EXISTS rooms (          -- private rooms: one secret key per team/project
  room TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (       -- team knowledge every agent should know
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'fact',        -- decision | convention | gotcha | fact
  text TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  author TEXT NOT NULL,
  source_message INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_room ON memories(room, kind);
`;
const parseProp = (r) => r && { ...r, votes: JSON.parse(r.votes) };
const parseMem = (r) => r && { ...r, tags: JSON.parse(r.tags) };

const parseMsg = (r) => r && { ...r, mentions: JSON.parse(r.mentions), meta: JSON.parse(r.meta) };

export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    try { this.db.exec('ALTER TABLE members ADD COLUMN session TEXT'); } catch {} // upgrade older DBs
  }

  // ---------- private rooms ----------
  roomInfo(room) { return this.db.prepare('SELECT * FROM rooms WHERE room = ?').get(room); }
  createRoom(room, keyHash, created_by) {
    this.db.prepare('INSERT INTO rooms (room, key_hash, created_by, created_at) VALUES (?, ?, ?, ?)').run(room, keyHash, created_by ?? null, Date.now());
  }
  setSession(room, name, session) { this.db.prepare('UPDATE members SET session = ? WHERE room = ? AND name = ?').run(session, room, name); }

  // ---------- messages ----------
  addMessage({ room, sender, sender_kind = 'agent', type = 'chat', body, mentions = [], reply_to = null, meta = {} }) {
    const r = this.db
      .prepare(`INSERT INTO messages (room, sender, sender_kind, type, body, mentions, reply_to, meta, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(room, sender, sender_kind, type, body, JSON.stringify(mentions), reply_to, JSON.stringify(meta), Date.now());
    return parseMsg(r);
  }

  messages(room, { after = 0, limit = 100, before = null } = {}) {
    if (before) {
      return this.db
        .prepare('SELECT * FROM messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(room, before, limit).reverse().map(parseMsg);
    }
    if (after === 0) {
      // latest N
      return this.db
        .prepare('SELECT * FROM messages WHERE room = ? ORDER BY id DESC LIMIT ?')
        .all(room, limit).reverse().map(parseMsg);
    }
    return this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(room, after, limit).map(parseMsg);
  }

  message(id) {
    return parseMsg(this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
  }

  search(room, q, limit = 30) {
    return this.db
      .prepare('SELECT * FROM messages WHERE room = ? AND body LIKE ? ORDER BY id DESC LIMIT ?')
      .all(room, `%${q}%`, limit).reverse().map(parseMsg);
  }

  // ---------- members / presence ----------
  touchMember(room, name, fields = {}) {
    const now = Date.now();
    const cur = this.member(room, name);
    if (!cur) {
      this.db
        .prepare(`INSERT INTO members (room, name, kind, client, owner, status, working_on, last_read, last_seen)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(room, name, fields.kind ?? 'agent', fields.client ?? null, fields.owner ?? null,
          fields.status ?? 'idle', fields.working_on ?? null, this.initialCursor(room, name), now);
    } else {
      const m = { ...cur, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
      this.db
        .prepare(`UPDATE members SET kind=?, client=?, owner=?, status=?, working_on=?, last_seen=? WHERE room=? AND name=?`)
        .run(m.kind, m.client, m.owner, m.status, m.working_on, now, room, name);
    }
    return { member: this.member(room, name), isNew: !cur };
  }

  /** A new member skips old history, except messages from the last 24h that @mention them (asked before they joined). */
  initialCursor(room, name) {
    const r = this.db.prepare(`SELECT MIN(id) AS first FROM messages WHERE room = ? AND created_at > ?
      AND (mentions LIKE ? OR mentions LIKE '%"all"%' OR mentions LIKE '%"everyone"%')`).get(room, Date.now() - 86_400_000, `%"${name.replace(/[%_"]/g, '')}"%`);
    return r?.first ? r.first - 1 : this.maxId(room);
  }

  member(room, name) {
    return this.db.prepare('SELECT * FROM members WHERE room = ? AND name = ?').get(room, name);
  }

  members(room) {
    return this.db.prepare('SELECT * FROM members WHERE room = ? ORDER BY last_seen DESC').all(room);
  }

  setLastRead(room, name, id) {
    this.db.prepare('UPDATE members SET last_read = MAX(last_read, ?) WHERE room = ? AND name = ?').run(id, room, name);
  }

  maxId(room) {
    return this.db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE room = ?').get(room).m;
  }

  rooms() {
    return this.db.prepare(`SELECT room, COUNT(*) AS messages, MAX(created_at) AS last_activity
                            FROM messages GROUP BY room ORDER BY last_activity DESC`).all();
  }

  // ---------- file claims ----------
  claims(room) {
    return this.db.prepare('SELECT * FROM claims WHERE room = ? ORDER BY created_at').all(room);
  }

  /** Claim paths. Returns { claimed, conflicts }. A claim on "src/auth/" covers everything beneath it. */
  claim(room, owner, paths, note) {
    const existing = this.claims(room);
    const claimed = [], conflicts = [];
    for (const p of paths) {
      const clash = existing.find((c) => c.owner !== owner && overlaps(c.path, p));
      if (clash) { conflicts.push({ path: p, held_by: clash.owner, held_path: clash.path, note: clash.note }); continue; }
      this.db.prepare(`INSERT INTO claims (room, path, owner, note, created_at) VALUES (?, ?, ?, ?, ?)
                       ON CONFLICT(room, path) DO UPDATE SET note = excluded.note`)
        .run(room, p, owner, note ?? null, Date.now());
      claimed.push(p);
    }
    return { claimed, conflicts };
  }

  release(room, owner, paths) {
    if (!paths || paths.length === 0) {
      return this.db.prepare('DELETE FROM claims WHERE room = ? AND owner = ?').run(room, owner).changes;
    }
    let n = 0;
    for (const p of paths) n += this.db.prepare('DELETE FROM claims WHERE room = ? AND owner = ? AND path = ?').run(room, owner, p).changes;
    return n;
  }

  checkPaths(room, paths, asker) {
    const existing = this.claims(room);
    return paths.map((p) => {
      // free only if no *other* member holds an overlapping claim (a dir may contain several people's claims)
      const c = existing.find((x) => x.owner !== asker && overlaps(x.path, p));
      return { path: p, free: !c, held_by: c?.owner ?? null, note: c?.note ?? null };
    });
  }

  // ---------- tasks ----------
  tasks(room, status) {
    return status
      ? this.db.prepare('SELECT * FROM tasks WHERE room = ? AND status = ? ORDER BY id').all(room, status)
      : this.db.prepare('SELECT * FROM tasks WHERE room = ? ORDER BY id').all(room);
  }

  task(id) { return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id); }

  createTask(room, { title, description, created_by, owner = null }) {
    const now = Date.now();
    return this.db.prepare(`INSERT INTO tasks (room, title, description, status, owner, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(room, title, description ?? null, owner ? 'in_progress' : 'open', owner, created_by, now, now);
  }

  // ---------- team goal ----------
  goal(room) {
    const g = this.db.prepare('SELECT * FROM goals WHERE room = ?').get(room);
    return g ? { ...g, milestones: JSON.parse(g.milestones) } : null;
  }

  setGoal(room, { goal, milestones, set_by }) {
    const cur = this.goal(room);
    const ms = milestones ?? cur?.milestones ?? [];
    this.db.prepare(`INSERT INTO goals (room, goal, milestones, set_by, updated_at) VALUES (?, ?, ?, ?, ?)
                     ON CONFLICT(room) DO UPDATE SET goal=excluded.goal, milestones=excluded.milestones, set_by=excluded.set_by, updated_at=excluded.updated_at`)
      .run(room, goal ?? cur?.goal ?? '', JSON.stringify(ms), set_by, Date.now());
    return this.goal(room);
  }

  // ---------- proposals ----------
  proposals(room, status) {
    const rows = status
      ? this.db.prepare('SELECT * FROM proposals WHERE room = ? AND status = ? ORDER BY id').all(room, status)
      : this.db.prepare('SELECT * FROM proposals WHERE room = ? ORDER BY id DESC LIMIT 50').all(room).reverse();
    return rows.map(parseProp);
  }

  proposal(id) { return parseProp(this.db.prepare('SELECT * FROM proposals WHERE id = ?').get(id)); }

  createProposal(room, { author, title, body }) {
    const now = Date.now();
    return parseProp(this.db.prepare(`INSERT INTO proposals (room, author, title, body, votes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(room, author, title, body ?? null, JSON.stringify({ [author]: { vote: 'agree', reason: 'author' } }), now, now));
  }

  updateProposal(id, fields) {
    const p = this.proposal(id);
    const m = { ...p, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    this.db.prepare('UPDATE proposals SET status=?, votes=?, message_id=?, decided_by=?, updated_at=? WHERE id=?')
      .run(m.status, JSON.stringify(m.votes), m.message_id, m.decided_by, Date.now(), id);
    return this.proposal(id);
  }

  // ---------- edit radar ----------
  /** Replace a member's whole set of live edits. */
  setEdits(room, member, branch, files) {
    const now = Date.now();
    this.db.prepare('DELETE FROM edits WHERE room = ? AND member = ?').run(room, member);
    const ins = this.db.prepare('INSERT INTO edits (room, member, path, status, ranges, branch, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of files) ins.run(room, member, norm(f.path), f.status ?? 'modified', JSON.stringify(f.ranges ?? []), branch ?? null, now);
  }

  edits(room) {
    return this.db.prepare('SELECT * FROM edits WHERE room = ? ORDER BY member, path').all(room).map((r) => ({ ...r, ranges: JSON.parse(r.ranges) }));
  }

  clearEdits(room, member) { this.db.prepare('DELETE FROM edits WHERE room = ? AND member = ?').run(room, member); }

  // ---------- team memory ----------
  remember(room, { kind = 'fact', text, tags = [], author, source_message = null }) {
    return parseMem(this.db.prepare(`INSERT INTO memories (room, kind, text, tags, author, source_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *`).get(room, kind, text, JSON.stringify(tags), author, source_message, Date.now()));
  }

  recall(room, { q, kind, limit = 50 } = {}) {
    let sql = 'SELECT * FROM memories WHERE room = ?'; const args = [room];
    if (kind) { sql += ' AND kind = ?'; args.push(kind); }
    if (q) {
      const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
      sql += ' AND (' + words.map(() => '(text LIKE ? OR tags LIKE ?)').join(' OR ') + ')';
      for (const w of words) args.push(`%${w}%`, `%${w}%`);
    }
    sql += ' ORDER BY id DESC LIMIT ?'; args.push(limit);
    return this.db.prepare(sql).all(...args).map(parseMem);
  }

  forget(room, id) { return this.db.prepare('DELETE FROM memories WHERE room = ? AND id = ?').run(room, id).changes; }

  updateTask(id, fields) {
    const t = this.task(id);
    if (!t) return null;
    const m = { ...t, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    this.db.prepare('UPDATE tasks SET title=?, description=?, status=?, owner=?, updated_at=? WHERE id=?')
      .run(m.title, m.description, m.status, m.owner, Date.now(), id);
    return this.task(id);
  }
}

function norm(p) { return p.replace(/^\.\//, '').replace(/\/+$/, ''); }
export function overlaps(a, b) {
  a = norm(a); b = norm(b);
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/** Find overlapping live edits between different members. Line-level when both sides have ranges, else file-level. */
export function findOverlaps(edits) {
  const byPath = new Map();
  for (const e of edits) (byPath.get(e.path) ?? byPath.set(e.path, []).get(e.path)).push(e);
  const out = [];
  for (const [path, list] of byPath) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.member === b.member) continue;
      const lines = [];
      if (a.ranges.length && b.ranges.length) {
        for (const [s1, e1] of a.ranges) for (const [s2, e2] of b.ranges) {
          // a little slack: edits 3 lines apart still tend to conflict in a merge
          if (s1 <= e2 + 3 && s2 <= e1 + 3) lines.push([Math.max(Math.min(s1, s2), 1), Math.max(e1, e2)]);
        }
        if (!lines.length) { out.push({ path, members: [a.member, b.member].sort(), level: 'file', lines: [] }); continue; }
      }
      out.push({ path, members: [a.member, b.member].sort(), level: lines.length ? 'lines' : 'file', lines });
    }
  }
  return out;
}
