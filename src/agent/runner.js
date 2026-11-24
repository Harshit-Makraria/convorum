// `convorum agent`: keeps a teammate's agent "on call" while its owner is away.
//
// Interactive agents (Claude Code, Codex, …) only act when their human types a prompt. The runner
// watches the room and, when something warrants attention (a mention, a question, a proposal to vote on,
// a handoff), launches the owner's agent CLI headlessly in the project directory. That agent has the
// Convorum MCP server configured, so it reads its brief and replies or acts by itself, under the
// owner's rules and autonomy level.
//
// Guardrails against runaway agent-to-agent loops:
//   - only wakes for messages that are addressed to it (mention / @all / question / proposal / handoff)
//   - never wakes for messages from itself, system notices, or plain acknowledgements
//   - cooldown between runs and an hourly run budget
//   - one run at a time; messages that arrive mid-run are batched into the next run
import { spawn } from 'node:child_process';
import { Hub, loadConfig, fmt } from '../client.js';

const PRESETS = {
  // headless Claude must be explicitly allowed to use the Convorum MCP tools (plus read-only code tools to answer accurately)
  'claude-code': ['claude', ['-p', '--permission-mode', 'acceptEdits', '--allowedTools', 'mcp__convorum__*,Read,Grep,Glob', '--max-turns', '25']],
  codex: ['codex', ['exec', '--full-auto']],
  gemini: ['gemini', ['-p']],
};
const ACK = /^(ok(ay)?|thanks?( you)?|thx|sounds good|got it|cool|nice|great|👍|ack|noted)[.! ]*$/i;

export async function runAgent(overrides = {}, { log = console.log } = {}) {
  const cfg = loadConfig(overrides);
  const hub = new Hub(cfg);
  const cooldownMs = Number(overrides.cooldown ?? 20) * 1000;
  const maxPerHour = Number(overrides.maxPerHour ?? 20);
  const runs = [];

  const [cmd, args] = resolveCommand(cfg);
  await hub.join({ status: 'idle', working_on: 'on call (autonomous)' });
  await hub.inbox(); // start fresh: don't react to history
  log(`🤖 ${cfg.name} on call in #${cfg.room} (autonomy: ${cfg.autonomy}). Waking via: ${cmd} ${args.join(' ')}`);

  const hb = setInterval(() => hub.heartbeat().catch(() => {}), 25_000);
  const stop = async () => { clearInterval(hb); await hub.leave().catch(() => {}); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);

  let pending = [];
  for (;;) {
    try {
      const { messages } = await hub.inbox({ wait: 60 });
      pending.push(...messages.filter((m) => shouldWake(m, cfg.name)));
      if (!pending.length) continue;

      runs.splice(0, runs.length, ...runs.filter((t) => Date.now() - t < 3600_000));
      if (runs.length >= maxPerHour) {
        log(`⏸  hourly budget (${maxPerHour}) reached; ${pending.length} message(s) waiting`);
        await sleep(60_000); continue;
      }
      const since = Date.now() - (runs.at(-1) ?? 0);
      if (since < cooldownMs) await sleep(cooldownMs - since);
      // collect anything that arrived during cooldown
      const extra = await hub.inbox();
      pending.push(...extra.messages.filter((m) => shouldWake(m, cfg.name)));

      const batch = pending; pending = [];
      runs.push(Date.now());
      log(`⚡ waking for ${batch.length} message(s):\n${batch.map((m) => '   ' + fmt(m)).join('\n')}`);
      await hub.status('working', `responding to ${batch.map((m) => m.sender).filter(uniq).join(', ')}`, false).catch(() => {});
      const code = await exec(cmd, [...args, wakePrompt(cfg, batch)], log, hub.session, cfg.name);
      await hub.status('idle', 'on call (autonomous)', false).catch(() => {});
      log(code === 0 ? '✓ done' : `✗ agent exited with ${code}`);
    } catch (e) {
      log(`(hub error: ${e.message}; retrying in 5s)`); await sleep(5000);
    }
  }
}

export function shouldWake(m, me) {
  if (m.sender === me) return false;
  if (m.sender_kind === 'system') return m.type === 'alert' && m.mentions.includes(me); // e.g. edit-collision warnings
  if (m.type === 'status') return false;
  if (ACK.test(m.body.trim())) return false;
  const direct = m.mentions.includes(me);
  const everyone = m.mentions.includes('all') || m.mentions.includes('everyone');
  if (direct) return true;
  if (m.meta?.proposal && m.type === 'question') return true;          // a new proposal to weigh in on
  if (everyone && ['question', 'decision', 'alert', 'handoff'].includes(m.type)) return true;
  if (m.type === 'question' && m.mentions.length === 0) return true;    // open question to the room
  return false;
}

export function wakePrompt(cfg, batch) {
  return `[Convorum wake-up] You are ${cfg.name}, ${cfg.owner}'s AI teammate. ${cfg.owner} is away; you were woken because teammates need you in #${cfg.room}:

${batch.map(fmt).join('\n')}

Do this:
1. Call the convorum team_brief tool to get full context (goal, decisions, what's waiting on you).
2. Respond like a real teammate: answer questions (chat_send with reply_to), vote on proposals with a real reason, coordinate on conflicts.
3. Work within your autonomy level (${cfg.autonomy}) and ${cfg.owner}'s rules. If something needs ${cfg.owner}'s judgement, say "I'll check with ${cfg.owner}" in the room instead of deciding.
4. Be brief. Don't send acknowledgements nobody needs. When finished, stop.`;
}

function resolveCommand(cfg) {
  if (cfg.agent_command) {
    const parts = cfg.agent_command.match(/(?:[^\s"]+|"[^"]*")+/g).map((s) => s.replace(/^"|"$/g, ''));
    return [parts[0], parts.slice(1)];
  }
  const p = PRESETS[cfg.client];
  if (!p) throw new Error(`No agent command for client "${cfg.client}". Set "agent_command" in .convorum.json (the prompt is appended as the last argument).`);
  return p;
}

function exec(cmd, args, log, session, name) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CONVORUM_SESSION: session, CONVORUM_NAME: name } });
    const out = (d) => String(d).split('\n').filter(Boolean).forEach((l) => log('   │ ' + l));
    child.stdout.on('data', out); child.stderr.on('data', out);
    const kill = setTimeout(() => { log('   (timeout, stopping agent)'); child.kill('SIGTERM'); }, 15 * 60_000);
    child.on('error', (e) => { log(`   could not start "${cmd}": ${e.message}`); clearTimeout(kill); resolve(127); });
    child.on('close', (code) => { clearTimeout(kill); resolve(code); });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uniq = (v, i, a) => a.indexOf(v) === i;
