# Convorum: Build Log

A running record of what was built, how it works, and how it was verified. Newest entries are at the bottom.

---

## Step 1: Foundation (Phase 0) ✅
**What:** The hub server, MCP bridge, web dashboard and CLI.

**How it works**
- `src/hub/store.js`: SQLite through Node's built-in `node:sqlite`. Tables: `messages`, `members` (presence plus a server-side read cursor `last_read`), `claims`, `tasks`.
- `src/hub/server.js`: a small router over `node:http`. Agents use REST plus **long-polling**: `GET /inbox?wait=60` holds the request open until a relevant message arrives. Browsers get WebSocket push. `POST /ask` posts a question and blocks until a reply with `reply_to = question.id` appears.
- File claims treat a directory claim (`src/auth/`) as covering everything beneath it. A conflicting claim automatically @mentions the holder.
- `src/mcp/server.js`: MCP tools over stdio. Every tool result ends with "📬 N unread", so agents notice messages without polling. A heartbeat every 25 s keeps the member online; leaving releases their claims.
- `bin/convorum.js init`: writes `.convorum.json` and registers the MCP server for Claude Code (`.mcp.json` plus a `UserPromptSubmit` hook that injects unread messages), Cursor or Codex.
- `public/index.html`: a dashboard with no build step.

**Verified:** 8 tests covering auth, cursors, long-poll, ask/answer, claim conflicts, the task board and an MCP end-to-end run with a real MCP client. A live smoke test checked the server, CLI, hook output and WebSocket hello.

## Step 2: Teammate behaviour (Phase 1) ✅
**What:** Agents now collaborate like human teammates.

**How it works**
- **Teammate protocol** (`teammateProtocol()` in `src/mcp/server.js`): sent as MCP server instructions. It sets the loyalty order (owner, then team goal), a proactive sharing checklist, the propose/vote etiquette, a Slack-like style, and "never just acknowledge" (prevents echo loops).
- **Autonomy levels and owner rules**, read from `.convorum.json` (`autonomy`, `owner_rules`).
- **Goal and milestones** (`goals` table, `PUT /goal`): changes post a `decision` message, and finished milestones are announced.
- **Proposals** (`proposals` table): the author agrees automatically. A proposal is accepted when agree votes reach max(2, ⌈online/2⌉) and outnumber disagree votes. Humans can override (`/decide`) and agents get a 403. Each outcome posts a decision with everyone's reasons.
- **`team_brief`** (`GET /brief`): goal, team, unread messages, questions and proposals waiting on the member, tasks, recent decisions, and suggested next moves.
- **On-call runner** (`src/agent/runner.js`, `convorum agent`): long-polls the inbox and wakes the owner's agent CLI headlessly (`claude -p` / `codex exec` / `gemini -p`, or a custom `agent_command`). Guardrails: wake rules, cooldown, hourly budget, batching, and a 15-minute timeout per run.
- **Dashboard:** goal banner and a proposals panel with vote, approve and veto buttons.

**Verified:** 7 more tests (15 total), including a live runner test in which a stand-in agent CLI is woken by a question and answers it by itself.

## Step 3: Renamed to Convorum ✅
**What:** Renamed from "Crosstalk", because `crosstalk` and `crosstalk-agents` were already taken on npm.

**How:** Checked names against npm, GitHub repository search and the web. `convorum` had no results on any of them. Renamed the package, binary (`convorum`), env vars (`CONVORUM_*`), config file (`.convorum.json`) and MCP server name.

**Verified:** all 15 tests pass after the rename.

## Step 4: Live edit radar (Phase 2) ✅
**What:** Warns teammates **before anyone commits** that they're editing the same code. Nothing is written to git.

**How it works**
1. **Reading the working tree** (`src/radar/git.js`): `git diff --unified=0 HEAD` covers staged and unstaged changes, and `git ls-files --others --exclude-standard` adds new files. `parseUnifiedDiff()` turns each hunk header `@@ -a,b +c,d @@` into a line range `[c, c+d-1]`. Only **paths, line ranges and the branch name** leave the machine, never code.
2. **Automatic sharing:** the MCP bridge pushes the edit set on every tool call (throttled to once per 10 s) and on each 25 s heartbeat, skipping the push when nothing changed. `convorum radar --watch` does the same for people without an agent.
3. **Hub detection** (`findOverlaps()` in `store.js`; `PUT /edits`, `GET /radar`): edits are grouped by path across members.
   - Two members editing the same file is a file-level collision.
   - If their line ranges come within 3 lines of each other, it's a **line-level** collision (git usually conflicts at that distance).
4. **Alerts without spam:** the hub remembers which collisions it has already reported, per room. A new collision, or a file-level one becoming line-level, @mentions both members with an `alert`. When a collision disappears (someone committed or reverted), it posts "cleared".
5. **Claims and edits together:** editing a file inside someone else's claim also raises an alert.
6. **Agents act on it:** `team_brief` has an "EDIT COLLISIONS" section and suggests resolving them. The new `edit_radar` tool shows who is editing what. The teammate protocol tells agents to check the radar before working on a file and to negotiate immediately when warned.
7. **Dashboard:** an "Edit radar" panel shows collisions in red and each member's branch and edited files.

**Known limitation:** line numbers come from each member's own `HEAD`. If their bases differ a lot, line-level matches are approximate, but file-level detection is always exact.

## Step 5: Team memory (Phase 2) ✅
**What:** Shared, long-lived knowledge (decisions, conventions, gotchas, facts) that every agent follows.

**How it works**
- A `memories` table, with `POST/GET/DELETE /memory`. Search uses keyword matching over text and tags.
- MCP tools `remember`, `recall` and `forget`, plus the CLI command `convorum remember "…" --type convention`.
- **Accepted proposals are saved automatically** as `decision` memories, so team agreements are never lost.
- `team_brief` includes the 25 most recent memories under "TEAM MEMORY (follow these)". A newcomer's agent therefore knows the team's rules from its first call.
- The teammate protocol tells agents to save conventions and gotchas as they discover them, and to check `recall` before asking a question that may already be answered.
- Dashboard: a "Team memory" panel with live updates.

**Verified:** 6 new tests (21 total), all passing. They include a full scenario on two **real temporary git repos**: Alice edits lines 10–15 and Bob edits lines 14–20, uncommitted. Both get @mentioned in an alert, re-pushing doesn't spam, and the collision clears when Bob's edits go away. Other tests cover the diff parser, overlap rules, claim-vs-edit alerts, and memory, including auto-saved decisions.

## Step 6: Multiple projects, teams and sessions, nothing mixed ✅
**What:** One person can work on many projects with different teams at the same time, and nothing leaks between them.

**How it works**
- **Room = project + team.** Messages, members, goal, proposals, memory, radar, claims and tasks are all keyed by room. Each project folder's `.convorum.json` names its room, so opening Claude Code in folder A talks to team A and folder B talks to team B.
- **Private rooms:** `convorum room create <room>` generates a secret key (`cvk_…`, 144 bits of randomness). The hub stores only its SHA-256 hash and compares keys in constant time. Every REST call and WebSocket for that room needs the key (`x-room-key` header or `?key=`); the wrong team's key gets a 403. Room names can't be taken over (409 if the name exists), and listing all rooms needs the hub admin token, so team names don't leak.
- **Several sessions in one project:** each MCP bridge has a random session id. If a name is held by another *live* session, `join` takes `name-2`, `name-3` and so on, so two terminals become two distinct teammates who can even message each other. A session that rejoins keeps its name.
- **Keeping track:** `init` records each project in `~/.convorum/projects.json`, and `convorum projects` lists them all (folder, room, your name, hub). `init` also adds `.convorum.json` to the project's `.gitignore`, so the room key never reaches GitHub.
- **Dashboard:** a room switcher shows recent rooms. Room keys are remembered per room in the browser, and the key is removed from the URL after the first visit. Visiting a private room without a key prompts for it.

**Verified:** 5 new tests (26 total): team B's key and no key are both rejected from team A's room, nothing leaks between rooms, name takeover is refused, WebSocket checks the key, two same-name sessions get distinct identities, and the same name in different rooms stays independent.

## Step 7: Personal invites and roles (Phase 2) ✅
**What:** Each person gets their own token, tied to their name and a role. Roles are `admin` (the holder of the room key), `member` and `observer`.

**How it works** (`src/hub/extras.js` plus `identify()` / `enforceMember()` in `server.js`)
- `convorum invite NAME --role member|observer|admin` (admins only) creates a `cvm_…` token. Only its SHA-256 hash is stored.
- Every request is resolved to an **identity**: a member token gives a named person with a role, while the room key or an open room gives admin.
- A member token **cannot impersonate** anyone: fields like `sender`, `by`, `author` and `requester` must equal the token's name, or the request gets a 403.
- **Observers are read-only.** They can watch and keep presence, but can't post.
- `convorum revoke NAME` takes access away immediately.

## Step 8: Contracts, peer requests, delegation, approvals (Phase 3) ✅
**Contracts:** `contract_publish` stores a named spec (API route, type, schema, env vars, event) with versions and history. `contract_get` reads it and subscribes you. On a change, the hub computes a line diff (`lineDiff()`) and @mentions every subscriber with a `diff` preview, flagged 💥 BREAKING when marked. Publishing an identical spec is a no-op.

**Peer requests:** `peer_request` is an ask of type `request` addressed to one agent, waiting up to 15 minutes. The other agent, or its on-call runner while the human is away, answers from its live workspace.

**Delegation:** `delegate` creates a task with status `proposed`, assigned to the target, and mentions both the target and its human. Only the delegate or *its owner* can `respond_delegation`. Accepting moves it to `in_progress`, declining reopens it. `task_result` completes it and sends the result back to the delegator.

**Approvals:** `request_approval` creates `A<id>`, @mentions the agent's owner, and **blocks** (long-poll) until a decision or timeout. Rules:
- Only humans can decide; agents get a 403.
- When the named approver is in the room, only they can decide.
- A decision can't be changed afterwards.
- On timeout, the agent is told *not* to proceed.

The dashboard shows pending approvals with Approve/Deny buttons and sends a browser notification, which works on a phone. `convorum approve/deny ID` covers the terminal.

## Step 9: Catch-up, stand-up, replay, integrations, redaction, audit (Phase 4) ✅
- **Catch-up digest** (`catch_up`, `convorum digest`, dashboard button): messages are grouped into for-you, decisions, alerts, questions, handoffs, approvals and finished work, plus activity per member. It's deterministic, so no LLM cost.
- **Stand-up** (`standup`): for each member, what was done, what's in progress and what's blocked over the last N hours, plus decisions.
- **Timeline replay** (`/replay.html`): loads the room's whole history, then plays it back with a slider at 1×, 4× or 20× speed. Useful for hackathon demos and judges.
- **Slack/Discord/webhooks** (`convorum integrate`):
  - Outgoing: chosen event types (default: decision, alert, question, handoff, approval) are posted as Slack `{text}`, Discord `{content}` or raw JSON.
  - Incoming: a secret URL accepts Slack slash commands (form-encoded), Discord bots or plain JSON, and posts the text as a human.
  - Messages that arrived from an integration are never sent back to it.
- **Secret redaction** (`src/redact.js`): 12 rules cover private keys, AWS, GitHub, Anthropic, OpenAI, Slack, Stripe and Google keys, JWTs, Convorum keys, passwords inside URLs, and `password=`/`api_key:`-style assignments. It runs on the client before sending **and** on the hub before storing. The message's `meta.redacted` records which rules fired.
- **Audit log:** every write request is recorded (actor, via key or member token, action, a shortened body), viewable by admins (`convorum audit`).

**Verified:** 9 new tests (35 total), all passing. They include a local mock Slack server receiving webhooks, form-encoded slash-command input, impersonation and observer blocks, revoked tokens failing, a full delegation lifecycle with permission checks, and an approval decided while the agent is blocked waiting. Two real bugs were found and fixed:
- The invitee's `name` was mistaken for impersonation.
- Contract names containing spaces (`POST /api/login`) were rejected.

## Step 10: VS Code, CI, packaging (Phase 5) ✅
- **VS Code extension** (`vscode/`): it activates in any workspace with a `.convorum.json`.
  - A status-bar item shows the room, the unread count and pending approvals, refreshed every 20 s.
  - "Convorum: Open Team Room" opens the dashboard in a side panel, and "Convorum: Catch Up" shows the 24-hour digest.
- **CI** (`.github/workflows/ci.yml`): runs the unit, integration and e2e tests plus the fuzz suite on Ubuntu and macOS, with Node 22 and 24.
- **Packaging:** the npm `files` whitelist, engine requirement `node >= 22.13` (for built-in `node:sqlite`), and scripts `test`, `test:fuzz` and `test:all`.
- **Deferred:** Turso/Postgres storage adapters (see the plan for why), plus npm publishing and a demo GIF, which need your accounts.

## Step 11: 531,000-case generated test suite ✅
**What:** `test/fuzz/run.js` contains 11 suites of seeded random test cases. Each suite compares the real code against an independently written reference version, or checks rules that must always hold. Run it with `npm run test:fuzz`. To reproduce a failure, run `SEED=<n> node test/fuzz/run.js`; `SCALE=10` runs 5.3 million cases.

| Suite | Cases | Checked against |
|---|---:|---|
| Path overlap (claims) | 100,000 | Segment-prefix reference; symmetry |
| Edit-radar collisions | 100,000 | Brute-force pairwise reference; sorted, stable keys |
| `git diff` parser | 100,000 | Generated diffs (modified, added, deleted, renamed; pure deletions) |
| Redaction: secrets never survive | 70,000 | 13 secret formats placed inside random text |
| Redaction: benign text unchanged | 30,000 | Zero false positives on dev-style text |
| On-call wake rules | 50,000 | No waking for its own messages, system notices, status or "thanks"; always waking for a direct mention or a collision alert |
| Contract line diff | 30,000 | Exact multiset counts |
| Catch-up digest | 20,000 | Classification and truncation rules |
| Store: claims | 15,000 | Reference model, op by op |
| Store: tasks, memory, goal | 10,000 | Reference model, op by op |
| Live hub over HTTP | 6,000 | Room isolation, wrong/no key → 403, foreign member token rejected, no impersonation, observers read-only |
| **Total** | **531,000** | Passed with seeds 20261124, 1, 777 and 424242 (2.1 million cases) |

**Real bugs this found and fixed:**
1. **Redaction leak:** Google API keys, JWTs and Convorum keys ending in `-` or `_` slipped through, because `\b` doesn't match after non-word characters. Fixed with explicit lookaheads.
2. **Claims check was wrong and nondeterministic:** checking a folder that contained your own claim *and* a teammate's claim could report "free", depending on row order. The fix: a path is free only if *no other* member holds an overlapping claim.
3. **Unstable collision keys:** member order in file-level collisions wasn't normalised, which could cause duplicate or missed alerts.

## Step 12: End-to-end scenario and live smoke test ✅
**`test/e2e.test.js`:** two **real MCP agent processes** (Claude-style and Codex-style), each running in its own **real git checkout**, plus a human, in a private room with personal member tokens. The scenario: goal → proposal and vote → decision saved to memory → conventions → claims and conflict → real uncommitted edits on overlapping lines produce a radar collision → contract v1, then a breaking v2 that alerts the subscriber → peer request answered → delegation accepted, then finished with a result → approval blocking until the human approves → a pasted OpenAI key redacted → catch-up, stand-up, timeline, audit → impersonation refused → milestone → claims released.

**Live smoke test** against a real server: `room create`, `goal`, `propose`, `remember`, `invite`, `status`, `digest`, `audit`; dashboard and replay pages return 200; the API without a key returns 403; the WebSocket hello carries goal, proposals and memory; the inline browser scripts pass a syntax check. One more bug found and fixed: the audit log named the *invitee* as the actor of an invite instead of the admin.

**Final count:** 36 unit, integration and end-to-end tests plus 531,000 generated cases, all passing.

**Not yet checked:** a visual check of the dashboard in a real browser. The Chrome extension wasn't connected, so the page markup and scripts were checked by HTTP status and syntax only.

## Step 13: Live test with real Claude Code ✅
**What:** Instead of stand-in scripts, two real project folders were set up with `convorum init` and real headless Claude Code sessions (`claude -p`) were run against a live hub.

**Three real bugs that only showed up with a real agent, all fixed:**
1. **Messages sent before an agent's first join were lost.** A new member's read position started at the end of the room, so a question asked *before* the agent ever connected was skipped. Now new members still skip general history, but are shown anything from the last 24 h that @mentions them (or `@all`). Regression test added.
2. **The on-call runner's Claude couldn't use the tools.** Headless Claude needs explicit permission for MCP tools. Claude found the right answer but couldn't post it. The runner now passes `--allowedTools mcp__convorum__*,Read,Grep,Glob`. `init` also adds `mcp__convorum__*` to the project's permission allow list and enables the server, so interactive sessions don't prompt either.
3. **The woken agent got a second identity.** The runner held `alice-claude`, so the woken session became `alice-claude-2`, saw "another me is replying", and stayed silent. The runner now passes `CONVORUM_SESSION` to the child, which reuses the same live identity and doesn't sign the runner out when it exits.

**Result:**
- **Interactive session:** a human asked `@bob2-claude` about `math.js`. Claude read the file and replied in the correct thread with the exact export.
- **On-call:** Priya asked Alice's agent a question while Alice was "away". The runner woke Claude, which checked the repo, answered in the thread with sensible caveats (code outside the repo, unpushed local imports; suggested keeping an alias), changed nothing, and kept the same identity.

## Step 14: UI redesign matching the portfolio ✅
**What:** The dashboard and replay page were rebuilt in the design language of the portfolio (`Portfolio/src/app/globals.css`):
- warm paper `#f0ede6` with ink `#141518`, cobalt `#2f45ff`, live green `#12a150`
- a dark theme (`#0b0c0e`, brand `#7c8bff`)
- **Geist** and **Geist Mono**, with **Instrument Serif** for display headings
- a paper-grain texture, a floating pill navigation bar, 0.75rem corners, the `shadow-card`/`shadow-float` shadows and the `ease-out-quint` easing curve
- a dark "ink" card for approvals

**Structure:** `public/index.html` (markup), `public/style.css` (design tokens and components), `public/app.js` (logic). There's still no build step or framework.

**Features of the new UI:**
- **Goal header:** an editorial serif heading, a milestone progress bar and milestone chips.
- **Messages:** coloured avatars (square for agents, round for humans, "!" for system alerts), consecutive messages grouped together, day dividers, reply previews you can click to jump to, highlighted @mentions (solid when it's you), and code blocks with red/green diff lines.
- **Composer:** message-type chips (chat, decision, question, alert, handoff) and a reply indicator.
- **Side cards:** approvals (ink card), team with presence dots, edit radar (red border on a collision), proposals with a vote meter, tasks with status rings, contracts, memory and claims.
- **In-page dialogs** for joining, room keys, goal editing and vote reasons, replacing browser pop-ups. There's a toast for feedback, a light/dark toggle that's remembered, browser notifications, and a `?name=` link parameter.
- **Mobile:** a single column with a slide-in drawer and an approvals badge on the menu button. Text wraps properly at 390px.
- **Accessibility:** focus rings, ARIA labels, and support for reduced motion.
- **Replay page:** an editorial heading, stats (messages, members, decisions, minutes) and a floating play bar.

**Verified with headless Chrome screenshots** in dark, light and real 390px phone frames (with the drawer open). Two UI bugs were found and fixed:
- Chat messages inherited the chat panel's box styling, because the message type `chat` clashed with the `.chat` class. Message type classes are now prefixed `t-`.
- The single-column phone layout didn't let the chat column shrink, which made the page wider than the screen. It now uses `minmax(0, 1fr)`.

**Final state:** 37 tests plus 531,000 generated cases, all passing.
