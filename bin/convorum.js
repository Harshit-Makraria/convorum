#!/usr/bin/env node
// Convorum CLI
import { parseArgs } from 'node:util';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Hub, loadConfig, fmt } from '../src/client.js';

const HELP = `convorum: real-time chat between AI coding agents and their humans

Usage:
  convorum serve [--port 7420] [--db .convorum/hub.db] [--token SECRET]
      Start the hub (web dashboard at http://localhost:7420).
  convorum room create ROOM [--url URL] [--token T]
      Create a PRIVATE room for a team/project. Prints its secret key and the join command.
  convorum init --room ROOM --name NAME [--key K] [--url URL] [--token T] [--client claude-code|codex|cursor]
      Write .convorum.json and wire up the MCP server + hooks for your agent (one room per project folder).
  convorum projects        List every project folder you've connected, and its room.
  convorum mcp            Run the MCP bridge over stdio (your agent launches this).
  convorum send "text"    Post a message as yourself (human). --as NAME to override.
  convorum tail           Follow the room live in your terminal.
  convorum inbox [--hook] Print unread messages (used by agent hooks).
  convorum status         Show members, claims and tasks.
  convorum agent [--cooldown 20] [--max-per-hour 20]
      Keep your agent on call: wakes your agent CLI headlessly when teammates need it.
  convorum radar [--watch] Share this checkout's uncommitted edits and show collisions.
  convorum remember "text" [--type convention|decision|gotcha|fact]
  convorum invite NAME [--role member|observer|admin]   Create a personal invite token (needs room key).
  convorum revoke NAME     Revoke someone's invite token.
  convorum approvals       List pending approval requests.
  convorum approve ID ["reason"] / convorum deny ID ["reason"]
  convorum digest [--hours N]   What happened while you were away.
  convorum standup [--hours 24] Team stand-up.
  convorum contracts / convorum contract NAME
  convorum integrate slack|discord|webhook [--url WEBHOOK_URL]   Bridge the room to Slack/Discord.
  convorum audit           Show the room's audit log (admins).
  convorum goal "text"    Set the team goal (as a human).
  convorum propose "idea" Pitch an idea for the team to vote on.
  convorum vote ID agree|disagree "reason"

Config comes from env vars (CONVORUM_URL, _ROOM, _NAME, _TOKEN, _CLIENT, _OWNER)
or a .convorum.json in the current directory.`;

const [cmd, ...rest] = process.argv.slice(2);
const { values: o, positionals } = parseArgs({
  args: rest, allowPositionals: true, strict: false,
  options: {
    port: { type: 'string' }, db: { type: 'string' }, token: { type: 'string' }, url: { type: 'string' },
    room: { type: 'string' }, key: { type: 'string' }, role: { type: 'string' }, hours: { type: 'string' }, 'member-token': { type: 'string' }, name: { type: 'string' }, client: { type: 'string' }, as: { type: 'string' },
    hook: { type: 'boolean' }, watch: { type: 'boolean' }, type: { type: 'string' }, host: { type: 'string' },
    autonomy: { type: 'string' }, rules: { type: 'string' }, cooldown: { type: 'string' }, 'max-per-hour': { type: 'string' },
  },
});

const cfgOverrides = { url: o.url, room: o.room, name: o.name, token: o.token, client: o.client, key: o.key, member_token: o['member-token'] };
const REGISTRY = join(homedir(), '.convorum', 'projects.json');

switch (cmd) {
  case 'serve': {
    const { createHub } = await import('../src/hub/server.js');
    const port = Number(o.port ?? process.env.PORT ?? 7420);
    const host = o.host ?? process.env.HOST ?? '0.0.0.0';
    const { server } = createHub({ dbFile: o.db ?? process.env.CONVORUM_DB ?? '.convorum/hub.db', token: o.token ?? process.env.CONVORUM_TOKEN });
    server.listen(port, host, () => {
      console.log(`convorum hub listening on http://localhost:${port}`);
      console.log(`dashboard:  http://localhost:${port}/r/<room>${o.token || process.env.CONVORUM_TOKEN ? '?token=…' : ''}`);
    });
    break;
  }

  case 'mcp': {
    const { startMcp } = await import('../src/mcp/server.js');
    await startMcp(cfgOverrides);
    break;
  }

  case 'send': {
    const cfg = loadConfig({ ...cfgOverrides, name: o.as ?? o.name ?? process.env.USER ?? 'human', client: 'cli' });
    const text = positionals.join(' ');
    if (!text) die('usage: convorum send "message"');
    const { message } = await new Hub(cfg).send(text, { sender_kind: 'human', type: o.type ?? 'chat', owner: null });
    console.log(`sent #${message.id} to #${cfg.room}`);
    break;
  }

  case 'tail': {
    const cfg = loadConfig(cfgOverrides);
    const hub = new Hub(cfg);
    const { messages } = await hub.history({ limit: 20 });
    messages.forEach((m) => console.log(fmt(m)));
    let after = messages.at(-1)?.id ?? 0;
    console.log(`— following #${cfg.room} (ctrl-c to stop) —`);
    for (;;) {
      try {
        const r = await hub.req('GET', `/messages?after=${after}&wait=60`);
        for (const m of r.messages) { console.log(fmt(m)); after = m.id; }
      } catch (e) { console.error(`(${e.message}, retrying)`); await new Promise((r) => setTimeout(r, 3000)); }
    }
  }

  case 'room': {
    if (positionals[0] !== 'create' || !positionals[1]) die('usage: convorum room create ROOM [--url URL] [--token T]');
    const cfg = loadConfig(cfgOverrides);
    const { room, key } = await Hub.createRoom(cfg, positionals[1], process.env.USER);
    console.log(`✓ created private room "${room}"\n\n  room key: ${key}\n\nShare the key only with this team. Each teammate runs, in their project folder:\n\n  npx convorum init --room ${room} --key ${key} --name <their-name>${cfg.url !== 'http://localhost:7420' ? ` --url ${cfg.url}` : ''}${cfg.token ? ' --token <hub-token>' : ''}\n\nDashboard: ${cfg.url}/r/${room}?key=${key}`);
    break;
  }

  case 'projects': {
    const list = readJson(REGISTRY, []);
    if (!list.length) { console.log('No projects yet. Run `convorum init` inside a project folder.'); break; }
    for (const p of list) console.log(`${existsSync(p.dir) ? '●' : '○'} ${p.room.padEnd(24)} as ${p.name.padEnd(20)} ${p.dir}${p.url !== 'http://localhost:7420' ? `  (${p.url})` : ''}`);
    break;
  }

  case 'agent': {
    const { runAgent } = await import('../src/agent/runner.js');
    await runAgent({ ...cfgOverrides, autonomy: o.autonomy, cooldown: o.cooldown, maxPerHour: o['max-per-hour'] });
    break;
  }

  case 'radar': {
    const { workingTreeEdits } = await import('../src/radar/git.js');
    const cfg = loadConfig(cfgOverrides);
    const hub = new Hub(cfg);
    await hub.join();
    const once = async () => {
      const wt = await workingTreeEdits();
      if (!wt) die('not a git repository');
      const { overlaps } = await hub.pushEdits(wt.branch, wt.files);
      console.log(`${new Date().toLocaleTimeString()}  shared ${wt.files.length} edited file(s) on ${wt.branch}`);
      for (const o of overlaps) console.log(`  ⚠️  ${o.path}: collision with ${o.members.find((m) => m !== cfg.name)}${o.lines.length ? ` (lines ${o.lines.map(([a, b]) => `${a}-${b}`).join(', ')})` : ''}`);
    };
    await once();
    if (process.argv.includes('--watch')) setInterval(() => once().catch((e) => console.error(e.message)), 15_000);
    break;
  }

  case 'invite': case 'revoke': {
    const cfg = loadConfig(cfgOverrides);
    const hub = new Hub(cfg);
    if (!positionals[0]) die(`usage: convorum ${cmd} NAME`);
    if (cmd === 'revoke') { const r = await hub.revoke(positionals[0]); console.log(r.revoked ? 'revoked' : 'no active invite with that name'); break; }
    const r = await hub.invite(positionals[0], o.role ?? 'member');
    console.log(`✓ invite for ${r.name} (${r.role})\n\n  member token: ${r.member_token}\n\nThey join with:\n  npx convorum init --room ${cfg.room} --name ${r.name} --member-token ${r.member_token}${cfg.url !== 'http://localhost:7420' ? ` --url ${cfg.url}` : ''}`);
    break;
  }

  case 'approvals': case 'approve': case 'deny': {
    const cfg = loadConfig({ ...cfgOverrides, name: o.as ?? o.name ?? process.env.USER ?? 'human' });
    const hub = new Hub(cfg);
    await hub.req('POST', '/join', { name: cfg.name, kind: 'human', client: 'cli' });
    if (cmd === 'approvals') {
      const { approvals } = await hub.approvals('pending');
      approvals.forEach((a) => console.log(`A${a.id}  ${a.requester} → ${a.approver ?? 'anyone'}: ${a.action}${a.details ? `\n      ${a.details}` : ''}`));
      if (!approvals.length) console.log('No pending approvals.');
    } else {
      const id = Number(String(positionals[0] ?? '').replace(/^A/i, ''));
      if (!id) die(`usage: convorum ${cmd} ID ["reason"]`);
      const { approval } = await hub.decideApproval(id, cmd === 'approve', positionals.slice(1).join(' ') || undefined);
      console.log(`A${approval.id} ${approval.status}`);
    }
    break;
  }

  case 'digest': case 'standup': {
    const cfg = loadConfig(cfgOverrides);
    const hub = new Hub(cfg);
    if (cmd === 'digest') {
      const d = await hub.digest(o.hours ? Number(o.hours) : undefined);
      console.log(`${d.total} message(s) since ${new Date(d.since).toLocaleString()}`);
      for (const [k, title] of [['for_you', 'For you'], ['decisions', 'Decisions'], ['alerts', 'Alerts'], ['questions', 'Questions'], ['handoffs', 'Handoffs'], ['approvals', 'Approvals'], ['finished', 'Finished']]) {
        if (d[k].length) { console.log(`\n${title}`); d[k].forEach((x) => console.log(`  #${x.id} ${x.sender}: ${x.text}`)); }
      }
    } else {
      const s = await hub.standup(Number(o.hours ?? 24));
      for (const m of s.members) console.log(`\n${m.name} (${m.status}${m.working_on ? `: ${m.working_on}` : ''})\n  done:  ${m.done.join('; ') || 'none'}\n  doing: ${m.doing.join('; ') || 'none'}${m.blocked.length ? `\n  blocked: ${m.blocked.join('; ')}` : ''}`);
      if (s.decisions.length) { console.log('\nDecisions'); s.decisions.forEach((d) => console.log('  ' + d)); }
    }
    break;
  }

  case 'contracts': case 'contract': {
    const hub = new Hub(loadConfig(cfgOverrides));
    if (cmd === 'contracts') { const { contracts } = await hub.contracts(); contracts.forEach((c) => console.log(`${c.name}  v${c.version}  [${c.kind}]  by ${c.owner}  subscribers: ${c.subscribers.join(', ') || 'none'}`)); if (!contracts.length) console.log('No contracts.'); }
    else { const { contract: c } = await hub.contract(positionals.join(' ')); console.log(`${c.name} v${c.version} [${c.kind}] by ${c.owner}\n\n${c.spec}`); }
    break;
  }

  case 'integrate': {
    const cfg = loadConfig(cfgOverrides);
    const kind = positionals[0];
    const { integration, incoming_url_path } = await new Hub(cfg).addIntegration(kind, o.url, undefined);
    console.log(`✓ ${kind} integration #${integration.id}\n  outgoing: ${integration.url ?? '(none: pass --url to post room events there)'} for ${integration.events.join(', ')}\n  incoming: ${cfg.url}${incoming_url_path}\n  (point a Slack slash command / outgoing webhook, or a Discord bot, at the incoming URL; keep it secret)`);
    break;
  }

  case 'audit': {
    const { audit } = await new Hub(loadConfig(cfgOverrides)).audit();
    audit.reverse().forEach((a) => console.log(`${new Date(a.at).toLocaleString()}  ${(a.actor ?? '?').padEnd(18)} ${a.action}`));
    break;
  }

  case 'remember': {
    const cfg = loadConfig({ ...cfgOverrides, name: o.as ?? o.name ?? process.env.USER ?? 'human' });
    const { memory } = await new Hub(cfg).remember(positionals.join(' '), o.type ?? 'fact');
    console.log(`remembered #${memory.id}`);
    break;
  }

  case 'goal': case 'propose': case 'vote': {
    const cfg = loadConfig({ ...cfgOverrides, name: o.as ?? o.name ?? process.env.USER ?? 'human' });
    const hub = new Hub(cfg);
    await hub.req('POST', '/join', { name: cfg.name, kind: 'human', client: 'cli' });
    if (cmd === 'goal') {
      if (!positionals.length) { const { goal } = await hub.goal(); console.log(goal ? goal.goal : 'No goal set.'); break; }
      await hub.setGoal({ goal: positionals.join(' ') }); console.log('goal set');
    } else if (cmd === 'propose') {
      const { proposal } = await hub.propose(positionals.join(' ')); console.log(`proposed P${proposal.id}`);
    } else {
      const [id, vote, ...reason] = positionals;
      const { proposal } = await hub.vote(Number(String(id).replace(/^P/i, '')), vote, reason.join(' ') || undefined);
      console.log(`P${proposal.id} is ${proposal.status}`);
    }
    break;
  }

  case 'inbox': {
    // Designed for agent hooks: stdout gets injected into the agent's context.
    // Never fail loudly: a down hub must not break the user's prompt.
    try {
      const cfg = loadConfig(cfgOverrides);
      const { messages, mentions } = await new Hub(cfg).inbox();
      const shown = messages.filter((m) => m.sender_kind !== 'system');
      if (shown.length) {
        if (o.hook) {
          console.log(`<convorum room="${cfg.room}" you="${cfg.name}" unread="${shown.length}" mentions="${mentions}">`);
          shown.forEach((m) => console.log(fmt(m)));
          console.log('</convorum>\nThese are new team-chat messages from your teammates\' agents/humans. Respond with the convorum chat_send tool if anything is addressed to you.');
        } else shown.forEach((m) => console.log(fmt(m)));
      } else if (!o.hook) console.log('No unread messages.');
    } catch (e) { if (!o.hook) die(e.message); }
    break;
  }

  case 'status': {
    const cfg = loadConfig(cfgOverrides);
    const s = await new Hub(cfg).state();
    console.log(`#${cfg.room}\n\nMembers`);
    s.members.forEach((m) => console.log(`  ${m.online ? '●' : '○'} ${m.name.padEnd(20)} ${(m.client ?? m.kind).padEnd(12)} ${m.status}${m.working_on ? `: ${m.working_on}` : ''}`));
    console.log('\nClaims'); s.claims.forEach((c) => console.log(`  ${c.path} → ${c.owner}`)); if (!s.claims.length) console.log('  none');
    console.log('\nTasks'); s.tasks.forEach((t) => console.log(`  #${t.id} [${t.status}] ${t.title}${t.owner ? ` → ${t.owner}` : ''}`)); if (!s.tasks.length) console.log('  none');
    break;
  }

  case 'init': {
    if (!o.room || !o.name) die('usage: convorum init --room ROOM --name NAME [--url URL] [--token T] [--client claude-code|codex|cursor]');
    const client = o.client ?? 'claude-code';
    const cfg = { url: o.url ?? 'http://localhost:7420', room: o.room, name: o.name, client, owner: process.env.USER, autonomy: o.autonomy ?? 'converse',
      ...(o.rules ? { owner_rules: o.rules } : {}), ...(o.token ? { token: o.token } : {}), ...(o.key ? { key: o.key } : {}), ...(o['member-token'] ? { member_token: o['member-token'] } : {}) };
    writeFileSync('.convorum.json', JSON.stringify(cfg, null, 2) + '\n');
    console.log('✓ wrote .convorum.json (keep it out of git: it holds your room key)');
    ensureGitignored('.convorum.json');
    mkdirSync(join(homedir(), '.convorum'), { recursive: true });
    const reg = readJson(REGISTRY, []).filter((p) => p.dir !== process.cwd());
    reg.push({ dir: process.cwd(), room: cfg.room, name: cfg.name, url: cfg.url, client });
    writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + '\n');
    const bin = resolve(fileURLToPath(import.meta.url));
    const mcpEntry = { command: process.execPath, args: [bin, 'mcp'], env: { CONVORUM_CLIENT: client } };

    if (client === 'claude-code') {
      const mcp = readJson('.mcp.json', { mcpServers: {} });
      mcp.mcpServers.convorum = mcpEntry;
      writeFileSync('.mcp.json', JSON.stringify(mcp, null, 2) + '\n');
      console.log('✓ added convorum to .mcp.json');
      mkdirSync('.claude', { recursive: true });
      const sp = join('.claude', 'settings.local.json');
      const s = readJson(sp, {});
      s.permissions ??= {};
      s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), 'mcp__convorum__*'])];
      s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers ?? []), 'convorum'])];
      s.hooks ??= {};
      const hook = { hooks: [{ type: 'command', command: `"${process.execPath}" "${bin}" inbox --hook` }] };
      for (const ev of ['UserPromptSubmit']) {
        s.hooks[ev] = (s.hooks[ev] ?? []).filter((h) => !JSON.stringify(h).includes('inbox --hook'));
        s.hooks[ev].push(hook);
      }
      writeFileSync(sp, JSON.stringify(s, null, 2) + '\n');
      console.log('✓ added UserPromptSubmit hook to .claude/settings.local.json (unread team messages are injected before every prompt)');
    } else if (client === 'codex') {
      console.log(`Add this to ~/.codex/config.toml:\n\n[mcp_servers.convorum]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(bin)}, "mcp"]\ncwd = ${JSON.stringify(process.cwd())}\nenv = { CONVORUM_CLIENT = "codex" }\n`);
    } else if (client === 'cursor') {
      mkdirSync('.cursor', { recursive: true });
      const p = join('.cursor', 'mcp.json');
      const m = readJson(p, { mcpServers: {} });
      m.mcpServers.convorum = mcpEntry;
      writeFileSync(p, JSON.stringify(m, null, 2) + '\n');
      console.log('✓ added convorum to .cursor/mcp.json');
    } else {
      console.log(`Configure your agent's MCP servers with:\n${JSON.stringify({ convorum: mcpEntry }, null, 2)}`);
    }
    console.log(`\nDashboard: ${cfg.url}/r/${cfg.room}${cfg.key ? `?key=${cfg.key}` : ''}`);
    break;
  }

  default:
    console.log(HELP);
    if (cmd && cmd !== 'help' && cmd !== '--help') process.exit(1);
}

function ensureGitignored(entry) {
  if (!existsSync('.git')) return;
  const cur = existsSync('.gitignore') ? readFileSync('.gitignore', 'utf8') : '';
  if (!cur.split('\n').includes(entry)) { writeFileSync('.gitignore', cur + (cur && !cur.endsWith('\n') ? '\n' : '') + entry + '\n'); console.log(`✓ added ${entry} to .gitignore`); }
}
function readJson(p, fallback) { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; } catch { return fallback; } }
function die(msg) { console.error(msg); process.exit(1); }
