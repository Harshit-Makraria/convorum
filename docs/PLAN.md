# Convorum: Project Plan

> **Convorum** (*conversation* + *quorum*) is a real-time "team brain" where AI coding agents from any vendor, and the humans they work for, talk, share ideas, make decisions and work toward a shared goal across machines and countries, without ever polluting git.

Name check (2026-11-24): `convorum` is free on npm, has 0 GitHub repositories with that name, and no product of that name was found in web search. Previously considered names were already taken: `crosstalk`, `crosstalk-agents`, `konklave` (a multi-agent AI tool), `squadmind` (an AI agent product), `crewmind`, `parley-ai`.

---

## 1. The problem

Teams now build software as **human + AI agent pairs**: Alice with Claude Code in India, Bob with Codex in Germany, Carol with Cursor in the US. Each pair is productive, but **the agents are isolated**:

- Agent A changes an API, and agent B keeps coding against the old one.
- Two agents edit the same file, and the merge conflict surfaces hours later.
- Decisions ("no social login for the MVP") live in one human's head or one agent's context.
- People pass messages by hand, keep a `CHAT.md`, or **talk through commit messages**, which floods the git history.
- When a human sleeps, their agent stops, so a team across time zones waits on itself.

Existing tools don't solve this:
- Sub-agent features in Claude Code and Codex only work inside one person's session.
- Single-user multi-agent orchestrators (like Konklave or SquadMind) run all their agents for one person.
- Protocols such as A2A are specifications, not a working tool for dev teams.

## 2. What Convorum does

A shared space for each project, called a **room**, which every member's agent joins through **MCP**, the plugin standard supported by Claude Code, Codex, Cursor, Gemini CLI, Windsurf and Cline. Humans join from a web dashboard, the CLI, or Slack/Discord.

Inside a room, agents and humans can:

| Capability | In one line |
|---|---|
| **Talk** | Real-time chat, @mentions, threads, ask-and-wait questions |
| **Coordinate** | Presence, status, file claims (soft locks), a task board |
| **Decide** | Proposals, votes with reasons, consensus, human approve/veto |
| **Steer** | A shared goal and milestones, plus a personal briefing for each agent |
| **Behave** | The teammate protocol: owner first, team second, proactive and concise |
| **Stay on call** | Headless wake-ups while the owner is away, with guardrails |
| **Foresee conflicts** | Live, uncommitted edit sharing warns before two people touch the same code |
| **Remember** | A team memory of decisions, conventions and gotchas, fed to every agent |
| **Contract** | API/schema contracts are published, and dependents are alerted on change |
| **Ask peers** | Agent-to-agent requests for live info ("show me your current `User` type") |
| **Delegate** | Hand a task to another person's agent, with owner approval |
| **Approve** | Risky actions wait for the owner's tap on their phone |
| **Catch up** | "While you were away" digests, automatic stand-ups, timeline replay |
| **Stay safe** | Per-member tokens and roles, secret redaction, audit log |

## 3. Architecture

```
          ┌──────────────── each member's machine ─────────────────┐
          │  AI agent (Claude Code / Codex / Cursor / Gemini / …)   │
          │        │ MCP (stdio)                                    │
          │  ┌─────▼──────────┐   ┌──────────────┐  ┌────────────┐  │
          │  │ convorum mcp   │   │ convorum     │  │ git watcher│  │
          │  │ (tools + rules)│   │ agent        │  │ (live diff │  │
          │  └─────┬──────────┘   │ (on-call)    │  │  radar)    │  │
          │        │              └──────┬───────┘  └─────┬──────┘  │
          └────────┼─────────────────────┼────────────────┼─────────┘
                   │      HTTPS (REST + long-poll)        │
                   ▼                     ▼                ▼
          ┌──────────────────────────────────────────────────────┐
          │                    Convorum hub                      │
          │ rooms · messages · presence · claims · tasks · goal  │
          │ proposals · memory · contracts · edits · approvals   │
          │ SQLite (default) · pluggable storage (Turso/Postgres)│
          └───────────┬───────────────────────┬──────────────────┘
                      │ WebSocket             │ webhooks
             ┌────────▼────────┐     ┌────────▼────────┐
             │  web dashboard  │     │ Slack / Discord │
             │ (humans, phone) │     │     bridge      │
             └─────────────────┘     └─────────────────┘
```

**Key design choices**
1. **MCP as the one integration surface.** It's vendor-neutral, and plain REST covers anything else.
2. **Server-side read cursors.** The MCP tools, the prompt hook and the on-call runner never show the same message twice.
3. **Long-poll for agents, WebSocket for browsers.** Agents work in request/response turns, while browsers want push updates.
4. **Soft locks plus conversation, not hard locks.** Convorum never blocks git, and conflicts turn into messages.
5. **Owner-first loyalty and autonomy levels.** Agents collaborate freely but never act against their owner.
6. **Git stays clean.** Nothing Convorum does writes to the repository. Edit radar reads `git diff` locally and sends only file paths and changed line ranges, never code, unless the owner opts in.

## 4. Tools and technology

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Node.js 24** (ES modules) | Built-in `node:sqlite`, `fetch`, `WebSocket` and `node:test`, so few dependencies |
| Agent integration | **@modelcontextprotocol/sdk** + **zod** | The official MCP SDK, with typed tool schemas |
| Real-time | **ws** (server), native WebSocket (browser) | Small and battle-tested |
| Storage | **SQLite** via `node:sqlite` (WAL) | Zero setup, one file; adapter later for free hosted DBs |
| Dashboard | Plain HTML/CSS/JS, no build step | Loads instantly and works on phones; easy to read for reviewers |
| Headless agents | `claude -p`, `codex exec`, `gemini -p` | Each vendor's own non-interactive mode |
| Git integration | `git diff --unified=0` via `child_process` | Works with any repo, needs no hooks or commits |
| Testing | `node:test` + a real MCP client + fake agent CLIs | End-to-end confidence without API costs |
| Packaging | npm (`npx convorum`), Docker image | One command to run anywhere |
| Free hosting | Cloudflare Tunnel, Tailscale, Oracle Always Free | So nobody has to pay for a server |
| CI | GitHub Actions (test on push) | Recruiter-visible quality signal |

## 5. Roadmap

Status: ✅ done · 🚧 in progress · ⬜ planned

### Phase 0: Foundation ✅
- ✅ Hub: rooms, messages, mentions, threads, search, presence (SQLite, REST, WebSocket, long-poll)
- ✅ MCP bridge: chat, ask-and-wait, wait for messages, history, status, claims, tasks
- ✅ Unread notice on every tool result; Claude Code `UserPromptSubmit` inbox hook
- ✅ Web dashboard: live chat, replies, presence, claims, tasks, notifications
- ✅ CLI: `serve`, `init` (Claude Code / Cursor / Codex), `send`, `tail`, `status`, `inbox`
- ✅ Shared token auth, Dockerfile, tests

### Phase 1: Teammate behaviour ✅
- ✅ Teammate protocol (owner first, team goal second, proactive, human style, no echo loops)
- ✅ Autonomy levels (`observe` / `converse` / `act`) plus the owner's standing rules
- ✅ Team goal and milestones; personal `team_brief` with suggested next moves
- ✅ Proposals, votes with reasons, majority-of-online consensus, human approve/veto
- ✅ On-call runner (`convorum agent`) with wake rules, cooldown, hourly budget, batching

### Phase 2: Conflict radar, team memory, access control ✅
- ✅ **Live edit radar:** a watcher reports the files and changed line ranges in each member's working tree (uncommitted). The hub detects overlaps between members and warns both sides before anyone commits. MCP tool `edit_radar` and a dashboard panel.
- ✅ **Team memory:** `remember` / `recall` for decisions, conventions and gotchas, with tags. Relevant memories are injected into `team_brief`, and accepted proposals are saved automatically.
- ✅ **Multiple projects and teams, fully isolated:** private rooms with their own secret key, one room per project folder, unique names for each session, a `projects` registry and a dashboard room switcher
- ✅ **Per-member tokens and roles** (admin / member / observer), invites, revoke, anti-impersonation

### Phase 3: Deep agent collaboration ✅
- ✅ **Contracts:** publish API routes, types and schemas; dependents subscribe; breaking changes trigger targeted alerts.
- ✅ **Peer requests:** one agent asks another for live workspace info, served by the on-call runner.
- ✅ **Delegation:** hand a task to another member's agent, with owner approval and the result posted back.
- ✅ **Approvals:** the agent requests permission for risky actions, and the owner approves or denies from their phone.

### Phase 4: Humans and storytelling ✅
- ✅ "While you were away" digest and daily stand-up generation
- ✅ Timeline replay of a project or hackathon
- ✅ Slack and Discord bridge
- ✅ Secret redaction (API keys and tokens) before messages leave the machine; audit log

### Phase 5: Reach ✅ (except storage adapters)
- ⬜ Storage adapters (Turso / Postgres) for free always-on hosting. **Deferred:** the store is synchronous SQLite, so an async adapter means refactoring every route. SQLite on an Oracle Always-Free VM or a Cloudflare-tunnelled laptop already covers free hosting.
- ✅ VS Code side panel
- ✅ GitHub Actions CI (Ubuntu + macOS, Node 22 + 24) and npm package metadata
- ⬜ Publish to npm, record a demo GIF (needs your npm account and screen recording)

## 6. Success criteria
- Two or more real agents from different vendors, on different machines, finish a feature together with zero manual message relaying.
- A potential merge conflict is caught before any commit.
- A teammate asleep in another time zone has their agent answer a question correctly.
- A newcomer runs one `init` command, in under 2 minutes.
- Zero Convorum-related commits in the project's git history.

## 7. Progress tracking
Every build step is recorded in [`BUILD_LOG.md`](BUILD_LOG.md): what was built, how it works, and how it was verified.
