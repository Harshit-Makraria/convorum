// Tiny HTTP client for the Convorum hub, shared by the MCP bridge and the CLI.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { redact } from './redact.js';

/** Resolve config from env vars, then ./.convorum.json, then defaults. */
export function loadConfig(overrides = {}) {
  let file = {};
  const p = join(process.cwd(), '.convorum.json');
  if (existsSync(p)) { try { file = JSON.parse(readFileSync(p, 'utf8')); } catch {} }
  const env = process.env;
  const cfg = {
    url: env.CONVORUM_URL ?? file.url ?? 'http://localhost:7420',
    room: env.CONVORUM_ROOM ?? file.room ?? 'default',
    name: env.CONVORUM_NAME ?? file.name ?? `${os.userInfo().username}-agent`,
    owner: env.CONVORUM_OWNER ?? file.owner ?? os.userInfo().username,
    client: env.CONVORUM_CLIENT ?? file.client ?? 'agent',
    token: env.CONVORUM_TOKEN ?? file.token ?? null,
    key: env.CONVORUM_KEY ?? file.key ?? null,             // private room key
    member_token: env.CONVORUM_MEMBER_TOKEN ?? file.member_token ?? null, // personal invite token (name + role)
    autonomy: env.CONVORUM_AUTONOMY ?? file.autonomy ?? 'converse',      // observe | converse | act
    owner_rules: env.CONVORUM_OWNER_RULES ?? file.owner_rules ?? null,    // free text, e.g. "never touch infra/"
    agent_command: env.CONVORUM_AGENT_COMMAND ?? file.agent_command ?? null, // used by `convorum agent`
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };
  cfg.url = cfg.url.replace(/\/+$/, '');
  return cfg;
}

export class Hub {
  // CONVORUM_SESSION lets a child process (e.g. an agent woken by the on-call runner) act as the same live identity
  constructor(cfg) { this.cfg = cfg; this.session = process.env.CONVORUM_SESSION || randomUUID(); this.attached = !!process.env.CONVORUM_SESSION; }

  get headers() {
    return { 'content-type': 'application/json',
      ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}),
      ...(this.cfg.key ? { 'x-room-key': this.cfg.key } : {}),
      ...(this.cfg.member_token ? { 'x-member-token': this.cfg.member_token } : {}) };
  }

  /** Create a private room on the hub. Returns { room, key }. */
  static async createRoom(cfg, room, created_by) {
    const res = await fetch(`${cfg.url}/api/rooms`, { method: 'POST', headers: new Hub(cfg).headers, body: JSON.stringify({ room, created_by }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }

  async req(method, path, body) {
    const res = await fetch(`${this.cfg.url}/api/rooms/${encodeURIComponent(this.cfg.room)}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  get me() { return this.cfg.name; }
  /** Join; if our name is held by another live session (e.g. a second terminal in the same project), take name-2, name-3, … */
  async join(extra = {}) {
    const base = this.cfg.name;
    for (let i = 1; i <= 20; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      try {
        const r = await this.req('POST', '/join', { name, session: this.session, kind: 'agent', client: this.cfg.client, owner: this.cfg.owner, ...extra });
        this.cfg.name = name;
        return r;
      } catch (e) { if (e.status !== 409) throw e; }
    }
    throw new Error(`could not find a free name based on "${base}"`);
  }
  heartbeat() { return this.req('POST', '/heartbeat', { name: this.me, kind: 'agent', client: this.cfg.client, owner: this.cfg.owner }); }
  leave() { return this.req('POST', '/leave', { name: this.me }); }
  send(body, opts = {}) { return this.req('POST', '/messages', { sender: this.me, client: this.cfg.client, owner: this.cfg.owner, body: redact(body).text, ...opts }); }
  inbox({ wait = 0, peek = false, mentionsOnly = false } = {}) {
    const q = new URLSearchParams({ name: this.me, client: this.cfg.client, wait: String(wait), peek: peek ? '1' : '0', mentions_only: mentionsOnly ? '1' : '0' });
    return this.req('GET', `/inbox?${q}`);
  }
  history({ limit = 50, q, before } = {}) {
    const p = new URLSearchParams({ limit: String(limit) });
    if (q) p.set('q', q); if (before) p.set('before', String(before));
    return this.req('GET', `/messages?${p}`);
  }
  thread(id) { return this.req('GET', `/thread/${id}`); }
  ask(to, body, wait, type) { return this.req('POST', '/ask', { sender: this.me, to, body: redact(body).text, wait, type }); }
  state() { return this.req('GET', `/state?name=${encodeURIComponent(this.me)}`); }
  status(status, working_on, announce = true) { return this.req('POST', '/status', { name: this.me, status, working_on, announce }); }
  claim(paths, note) { return this.req('POST', '/claims', { owner: this.me, paths, note }); }
  release(paths) { return this.req('POST', '/claims/release', { owner: this.me, paths }); }
  check(paths) { return this.req('POST', '/claims/check', { name: this.me, paths }); }
  tasks(status) { return this.req('GET', `/tasks${status ? `?status=${status}` : ''}`); }
  createTask(title, description, owner) { return this.req('POST', '/tasks', { title, description, owner, created_by: this.me }); }
  updateTask(id, fields) { return this.req('PATCH', `/tasks/${id}`, { by: this.me, ...fields }); }
  brief() { return this.req('GET', `/brief?name=${encodeURIComponent(this.me)}`); }
  goal() { return this.req('GET', '/goal'); }
  setGoal(fields) { return this.req('PUT', '/goal', { by: this.me, ...fields }); }
  proposals(status) { return this.req('GET', `/proposals${status ? `?status=${status}` : ''}`); }
  propose(title, body) { return this.req('POST', '/proposals', { author: this.me, title, body }); }
  vote(id, vote, reason) { return this.req('POST', `/proposals/${id}/vote`, { name: this.me, vote, reason }); }
  pushEdits(branch, files) { return this.req('PUT', '/edits', { member: this.me, branch, files }); }
  radar() { return this.req('GET', '/radar'); }
  remember(text, kind, tags) { return this.req('POST', '/memory', { author: this.me, text, kind, tags }); }
  recall(q, kind) { const p = new URLSearchParams(); if (q) p.set('q', q); if (kind) p.set('kind', kind); return this.req('GET', `/memory?${p}`); }
  forget(id) { return this.req('DELETE', `/memory/${id}?by=${encodeURIComponent(this.me)}`); }
  // contracts
  contracts() { return this.req('GET', '/contracts'); }
  contract(name) { return this.req('GET', `/contracts/${encodeURIComponent(name)}`); }
  publishContract(name, spec, { kind, note, breaking } = {}) { return this.req('PUT', `/contracts/${encodeURIComponent(name)}`, { by: this.me, spec, kind, note, breaking }); }
  subscribeContract(name, unsubscribe = false) { return this.req('POST', `/contracts/${encodeURIComponent(name)}/subscribe`, { member: this.me, unsubscribe }); }
  // delegation
  delegate(to, title, details) { return this.req('POST', '/delegations', { from: this.me, to, title, details }); }
  respondDelegation(id, accept, reason) { return this.req('POST', `/delegations/${id}/respond`, { by: this.me, accept, reason }); }
  taskResult(id, result) { return this.req('POST', `/tasks/${id}/result`, { by: this.me, result }); }
  // approvals
  requestApproval(action, details, wait = 0) { return this.req('POST', '/approvals', { requester: this.me, action, details, wait }); }
  approval(id, wait = 0) { return this.req('GET', `/approvals/${id}?wait=${wait}`); }
  approvals(status) { return this.req('GET', `/approvals${status ? `?status=${status}` : ''}`); }
  decideApproval(id, approve, reason) { return this.req('POST', `/approvals/${id}/decide`, { by: this.me, approve, reason }); }
  // roles, digest, misc
  invite(name, role) { return this.req('POST', '/invites', { name, role }); }
  revoke(name) { return this.req('POST', '/invites/revoke', { name }); }
  whoami() { return this.req('GET', '/whoami'); }
  digest(hours) { return this.req('GET', `/digest?name=${encodeURIComponent(this.me)}${hours ? `&hours=${hours}` : ''}`); }
  standup(hours = 24) { return this.req('GET', `/standup?hours=${hours}`); }
  timeline(after = 0) { return this.req('GET', `/timeline?after=${after}`); }
  audit() { return this.req('GET', '/audit'); }
  addIntegration(kind, url, events) { return this.req('POST', '/integrations', { kind, url, events }); }
  decide(id, status) { return this.req('POST', `/proposals/${id}/decide`, { by: this.me, status }); }
}

/** Human-friendly rendering of messages for agents and terminals. */
export function fmt(m) {
  const t = new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const tag = m.type !== 'chat' ? ` [${m.type}]` : '';
  const who = m.sender_kind === 'human' ? `${m.sender} (human)` : m.sender;
  const reply = m.reply_to ? ` ↩#${m.reply_to}` : '';
  return `#${m.id} ${t} ${who}${tag}${reply}: ${m.body}`;
}
