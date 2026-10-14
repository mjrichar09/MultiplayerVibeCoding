# multiplayer — a Claude Code plugin for team "multiplayer vibe coding"

> **For Claude Code:** This is the build plan. Read it fully, then start with **Phase 0**. Work phase by phase, commit at the end of each phase, and stop to report at each ⏸ checkpoint. Where this plan states a fact about Claude Code's plugin/hook/skill format, **verify it against the current official docs first** (code.claude.com/docs) — the docs win over this file. Verified findings live in `docs/research-notes.md`.
>
> *Name:* `multiplayer` (decided; replaced the placeholder `duo`, which implied exactly two people).

---

## 1. Problem & goal

A team of **N developers** (two or more), each running their own Claude Code sessions against one shared repo. Today, each Claude only knows what its own human told it, which produces:

- duplicated or colliding work (several agents editing the same files)
- decisions made in one session that the other Claudes never learn about, then contradict
- lossy handoffs ("what did you change and why?"), including handoffs to whoever picks the work up next
- `CLAUDE.md` drift as the project evolves

**Goal:** a plugin that adds an **async coordination layer** so each person's Claude automatically knows what each teammate is working on, what's been decided, and what was handed off to them (or to everyone) — with minimal ceremony, and with output that stays compact as the team grows.

**Scale target:** works for any team size; designed and tested for **2–15 active members**. Nothing in the design assumes a fixed number of people. Larger teams work, but git push contention on the state branch and briefing size are the limits (see §2.6).

**Non-goals (v1):**
- Live shared sessions — use [claude-share](https://github.com/Paradigm-Study/claude-share) or similar alongside this; don't rebuild it.
- Hosted servers, dashboards, auth, permissions between members.
- Blocking anyone's work. Every guard **warns**, never blocks.

---

## 2. Core design decisions

### 2.1 Where shared state lives — an orphan git branch
Claims and decisions must be visible to teammates *immediately*, but feature branches aren't. So:

- State lives on an **orphan branch `multiplayer-state`** in the same remote.
- Locally it's checked out as a **git worktree at `.multiplayer/`** (gitignored in the main tree).
- Scripts `git pull --rebase` before reading and commit + push after writing.
- No server, no extra repo, works with any GitHub/GitLab remote.

*Fallback (config option, not default):* a `.collab/` folder committed to `main`.

### 2.2 Merge-conflict-free file layout — one writer per file
Never have two people edit the same state file. Every file is created and only ever modified or deleted by **one** member — its author. This is what makes the design scale to any team size: concurrent writers only ever add/remove *different* paths, so `pull --rebase` always succeeds.

```
.multiplayer/
├── multiplayer.config.json          # team-wide settings only (written once by the creator; no member list)
├── members/<user>.json              # one file per member, self-registered on join; edited only by that member
├── claims/<user>--<slug>.md         # one file per active claim; deleted by its owner on release
├── decisions/<ts>--<user>--<slug>.md  # ADR-style, append-only, never edited after write
├── handoffs/<ts>--<from>--<slug>.md   # passing work: `to: [bob]`, transfers a claim
├── notes/<ts>--<user>--<slug>.md      # team notes, to everyone
└── history/<user>.md                # per-member log of released claims
```

- Each file has YAML frontmatter (machine-readable) + markdown body (human/Claude-readable).
- IDs are timestamp-based (`20261014-0943`) **plus the author slug**, so two members writing in the same minute never collide and nobody has to coordinate a counter.
- **Membership is the set of files in `members/`.** Joining adds a file; leaving sets `"active": false` in your own file. No one edits a shared roster, so N members can join concurrently.
- Handoff recipients live in frontmatter, not the filename. A handoff always names its recipient(s); broadcast updates are notes, a separate type.
- Read/unread state is **per user and local** (`.multiplayer/.local/`, gitignored on the state branch), so marking something read never writes shared state.

### 2.3 Identity
`MULTIPLAYER_USER` env var → else `git config user.name` slugified. On join, if `members/<slug>.json` already exists with a different `git config user.email`, init refuses and asks the user to set `MULTIPLAYER_USER` (prevents two people silently sharing an identity).

### 2.4 Implementation stack
- Hook/helper scripts: **Node (ESM), zero runtime dependencies**, one CLI entry `scripts/multiplayer.mjs <subcommand>`.
- `gh` CLI optional (used for PR overlap detection; degrade gracefully if missing/unauthenticated).
- Skills (markdown) call the CLI via Bash so behavior is deterministic and testable outside Claude.

### 2.5 Hook guardrails (non-negotiable)
- **Fail open:** any error → exit 0 with no output (or a one-line note). Never break a session.
- **Fast:** SessionStart < 3s, PreToolUse < 1s. Network calls cached (TTL ~5 min) with hard timeouts. PreToolUse never touches the network synchronously — it reads local state and caches only.
- **Warn, don't block.** (PreToolUse returns `hookSpecificOutput.additionalContext` with no `permissionDecision`.)
- Never print or commit secrets; never read `.env*`.

### 2.6 Scaling to N members
- **Push contention:** with many members, pushes to `multiplayer-state` race. Writes retry `pull --rebase` + push with jittered exponential backoff (up to ~6 attempts). Because of §2.2 the rebase never conflicts; only the push can lose a race.
- **Briefing size:** the SessionStart briefing has a hard cap (~40 lines) regardless of team size. It prioritizes, in order: handoffs addressed to me → claims overlapping my current branch/claims → new decisions → recent notes → other teammates' claims grouped per person, most recent first. Anything past the cap collapses to a summary line (`+7 more claims from carol, dan, erin — run /multiplayer:status`).
- **Overlap warnings** list *every* teammate whose claim or open PR touches the file, not just the first match.
- **Inactive members** (left the team, or no activity in N days, configurable) are hidden from briefings but their claims still show as stale.
- **Stale claims:** a claim with no activity for `staleClaimDays` (default **3**, set in `multiplayer.config.json`) is flagged as stale in `/status` and the briefing. Only the owner deletes their claim. A teammate who needs the area runs `/multiplayer:claim --takeover <user>/<slug>`, which creates *their own* claim that supersedes the stale one (`supersedes:` in frontmatter). Warnings then point to the new owner, the original file is untouched (one-writer rule holds), and the original owner's next briefing says who took it over. Takeover of a non-stale claim is refused.

### 2.7 Automatic by default
Members shouldn't have to remember slash commands. Each action runs **automatically** — triggered by a hook or by the agent on its own judgment — or **when asked** in plain language ("hand this off to Bob"). Slash commands still exist as a manual override, but nothing depends on anyone typing them.

Three layers make this work, from most to least deterministic:
1. **Hooks** (run every time, no model judgment): briefing at session start, auto-join, release-on-merge, overlap warnings, unclaimed-edit nudges, and a "where I left off" snapshot at session end.
2. **Model-invoked skills**: every skill is model-invocable (no `disable-model-invocation`), with a description that says *when* to use it ("Use proactively before your first edit for a new task…"). Hooks nudge the agent toward the right skill via `additionalContext`.
3. **Standing rules** in the scaffolded `CLAUDE.md` and in the session-start briefing, restating when to claim, record a decision, post a note, and sync.

Automatic actions announce themselves in one line to the user (e.g. `multiplayer: claimed src/checkout/** for "redo checkout flow"`), so nothing happens invisibly. Every action is still **warn, don't block**.

| Action | Runs | Trigger |
|---|---|---|
| join (init, joiner path) | automatic | SessionStart: `multiplayer-state` exists on the remote and I'm not registered → attach worktree + register me. |
| create (init, creator path) | **when asked** | Creating a branch on the shared remote is opt-in per repo — the plugin may be enabled globally, so it must not set up every repo the user opens. The briefing mentions it once if the repo has a remote but no state branch. |
| claim | automatic | Agent claims before its first edit for a new task (skill description + standing rule). PreToolUse backstop: editing a file not covered by any of my claims adds context "no claim covers this file — claim it before continuing". Nudged at most once per area per session to avoid noise. |
| release | automatic | (a) PostToolUse hook after a successful merge (`gh pr merge`, or the GitHub MCP merge tool): release my claims on the merged PR's branch and log "merged in #N" to my history. (c) SessionStart: release my claims whose PRs merged outside Claude (cached `gh` check). Claims marked `keep: true` (`--keep`) survive a merge, for multi-PR tasks. If someone else's agent merges my PR, my claim shows as "PR merged" in everyone's briefing until my next SessionStart releases it (one-writer rule). |
| status | automatic | Briefing at every SessionStart; agent re-checks before starting new work. |
| decide | automatic | Agent records an ADR when a design choice is settled in conversation (user agreed, or an alternative was rejected for a stated reason). No confirmation prompt; announced in one line. Mistakes are fixed by a new decision with `supersedes:`. |
| note | automatic | Agent posts a team note (to everyone) when it learns something teammates need: broken env, flaky test, half-done refactor, changed command. |
| handoff | **when asked** | User says to pass work to someone ("Bob is taking over checkout"). Requires a named recipient; transfers the claim to them with notes. |
| sync | automatic | Briefing flags decisions not yet reflected in `CLAUDE.md`; agent updates `CLAUDE.md` as its own commit (`multiplayer: sync CLAUDE.md`). |
| snapshot | automatic | SessionEnd hook writes "where I left off" (branch, last commits, uncommitted files) into my own active claims — no model needed. Commit locally; push best-effort, else on next SessionStart. |

---

## 3. Plugin layout (verified against docs — see `docs/research-notes.md`)

The repo root is the plugin, and also a single-plugin marketplace.

```
./
├── .claude-plugin/
│   ├── plugin.json            # manifest (only `name` required)
│   └── marketplace.json       # `plugins: [{ name: "multiplayer", source: "./" }]`
├── skills/                    # invoked as /multiplayer:<skill>
│   ├── init/SKILL.md
│   ├── claim/SKILL.md
│   ├── release/SKILL.md
│   ├── status/SKILL.md
│   ├── decide/SKILL.md
│   ├── handoff/SKILL.md
│   ├── note/SKILL.md
│   └── sync/SKILL.md
├── hooks/hooks.json           # SessionStart, PreToolUse (Edit|Write|MultiEdit), PostToolUse (merge), SessionEnd
├── scripts/
│   ├── multiplayer.mjs        # CLI entry
│   └── lib/                   # state, git, gh, identity, render
├── templates/                 # files scaffolded into the user's project by init
│   ├── CLAUDE.md.tmpl
│   ├── settings.json.tmpl
│   └── PULL_REQUEST_TEMPLATE.md
├── test/                      # node:test; N-clone simulation harness
├── docs/
├── README.md
└── LICENSE (MIT)
```

---

## 4. Features (what each piece does)

Every feature runs automatically or when asked (§2.7); the slash command is the manual override.

| Feature | Manual command | Behavior |
|---|---|---|
| **init** | `/multiplayer:init` | **Joiner path is automatic; creator path runs when asked.** **Creator** (no `multiplayer-state` on remote): creates the orphan branch + `.multiplayer/` worktree, writes `multiplayer.config.json`, registers self in `members/`. **Joiner** (branch exists): attaches the worktree and registers self in `members/`. Both: add `.multiplayer/` to `.gitignore`, scaffold `CLAUDE.md` / `.claude/settings.json` / PR template **only if absent** (otherwise offer a diff). Any number of members can join, in any order, concurrently. |
| **claim** | `/multiplayer:claim <task> [#issue]` | Creates `claims/<user>--<slug>.md` with: task, branch, expected paths/globs (the agent derives them from the task; kept narrow), optional GitHub issue number, started time, notes. Warns, listing **each** teammate whose claim overlaps the paths. Free-text paths are the source of truth; once the claim's branch has an open PR, the PR's actual changed files are also checked (catches paths the claim missed). `--takeover <user>/<slug>` supersedes a stale claim (§2.6). |
| **release** | `/multiplayer:release [slug]` | Deletes my claim; one-line outcome appended to `history/<user>.md`. Automatic on PR merge (PostToolUse hook) and at SessionStart for PRs merged elsewhere, unless the claim has `keep: true`. |
| **status** | `/multiplayer:status [user]` | Renders, grouped by teammate: active claims, decisions in last 14 days, unread handoffs to me, recent notes, stale claims (> N days). Optional filter to one teammate. |
| **decide** | `/multiplayer:decide <summary>` | The agent writes an ADR (context, decision, consequences, alternatives) from the current conversation when a choice is settled, then pushes it and tells the user in one line. Visible to every member. `supersedes:` replaces an earlier decision. |
| **handoff** | `/multiplayer:handoff <user>` | **When asked** to pass work on. The agent summarizes: what changed (from `git diff`/log on branch), why, open questions, next steps, gotchas, and transfers the claim (the recipient gets a new claim that supersedes mine; I release mine). Recipient required. Marked read *per recipient, locally* when their SessionStart surfaces it. |
| **note** | `/multiplayer:note <text>` | Team update to everyone (broken env, flaky test, half-done work). Posted automatically by the agent when it learns something teammates need. Lower priority than handoffs in the briefing; ages out after `noteDays` (default 3). |
| **sync** | `/multiplayer:sync` | Reads recent decisions (from all members) + merged PRs; updates `CLAUDE.md` as its own commit when the briefing flags unsynced decisions. Flags stale claims. |
| **SessionStart hook** | — | Pull state; auto-join; release claims whose PRs merged; inject a compact briefing (prioritized and capped per §2.6) plus the standing rules from §2.7. |
| **Overlap guard hook** | — (PreToolUse on Edit/Write/MultiEdit) | If the target file matches any teammate's claimed path glob, **or** a file changed in any teammate's open PR (via `gh pr list` + `gh pr view --json files`, cached), add context for Claude: "⚠️ carol (claim: X) and dan (PR #N) are working on this file. Confirm with user before proceeding." Also nudges the agent to claim when no claim of mine covers the file. |
| **Merge hook** | — | PostToolUse on `Bash` (`gh pr merge`) and the GitHub MCP merge tool: on success, release my claims on that PR's branch. |
| **SessionEnd hook** | — | Writes a "where I left off" snapshot into my active claims. |

---

## 5. Phases

### Phase 0 — Research & scaffold
1. Read current Claude Code docs for: plugins (manifest, marketplace), skills (SKILL.md frontmatter), hooks (event names, input JSON, how to inject context on SessionStart, how PreToolUse returns a warning without blocking), plugin env vars (e.g., plugin root path).
2. Review for ideas (check licenses before copying anything): [jsnkle/Claude-Code-Team-Collaboration-Guide](https://github.com/jsnkle/Claude-Code-Team-Collaboration-Guide), [peterkrueck/Claude-Code-Development-Kit](https://github.com/peterkrueck/Claude-Code-Development-Kit), [Paradigm-Study/claude-share](https://github.com/Paradigm-Study/claude-share).
3. Write `docs/research-notes.md` summarizing verified format details and any places this plan is wrong.
4. Scaffold the repo layout from §3 with a no-op hook to confirm the plugin loads locally (`claude plugin validate .`).

⏸ **Checkpoint:** report doc findings + any plan corrections before writing real logic.

### Phase 1 — State store + identity + init
- `lib/git.mjs`: create orphan branch, add worktree, pull/commit/push with jittered retries on non-fast-forward.
- `lib/identity.mjs` (incl. identity-collision check), `lib/state.mjs` (read/write frontmatter files, members directory).
- `multiplayer init` (creator + joiner paths), `/multiplayer:init` skill wrapping it. Auto-join from the SessionStart hook; creator path only when asked.
- Tests: an **N-clone harness** — a bare repo plus `n` temp clones (default 3: alice, bob, carol). Cover: one creator + several joiners; two joiners registering concurrently.

### Phase 2 — Claims + SessionStart briefing
- `multiplayer claim|release|status`, matching model-invocable skills with "use proactively" descriptions.
- Unclaimed-edit nudge in PreToolUse; PostToolUse merge hook + SessionStart merged-PR check for auto-release (`keep: true` opt-out); SessionEnd snapshot.
- SessionStart hook with the briefing renderer (grouping, prioritization, cap) + "last seen" tracking stored locally (`.multiplayer/.local/`, gitignored on the state branch too).
- Tests: alice and bob claim → carol's SessionStart output shows both, grouped; with 10 simulated members the briefing stays within the line cap; a simulated `gh pr merge` releases the matching claim but not a `keep: true` one.

⏸ **Checkpoint:** demo the multi-clone flow end to end.

### Phase 3 — Decisions, notes, handoffs
- `multiplayer decide|note|handoff`; skills where the agent drafts the content and calls the CLI. `decide` and `note` are proactive; `handoff` runs when asked and transfers the claim.
- Per-recipient local read tracking; notes age out after `noteDays`.
- Briefing shows new decisions, unread handoffs (highest priority), recent notes.
- Tests: handoff to bob appears for bob only and moves the claim; a note appears for everyone except its author; marking read in one clone doesn't affect another.

### Phase 4 — Overlap guard
- Path-glob matching against all teammates' claims (no network).
- Optional `gh` PR-file overlap across all teammates' open PRs, with cache + timeout (refreshed by SessionStart / background, read-only in PreToolUse).
- Tests for glob matching, multiple simultaneous overlaps, cache, `gh`-missing fallback, and fail-open on errors.

### Phase 5 — Sync + templates
- `/multiplayer:sync` skill (updates `CLAUDE.md` as its own commit), triggered by the briefing's unsynced-decisions flag.
- `templates/` content: a solid team `CLAUDE.md` skeleton (stack, commands, conventions, "ask before touching" list with owners, link to `.multiplayer/decisions`, and the §2.7 standing rules), shared `settings.json` (secrets guard + destructive-command guard + formatter hooks as *project* hooks), PR template (what/why/how to test/claims released).

### Phase 6 — Packaging + dogfood
- `marketplace.json`, README with 2-minute quickstart for the creator and for each joining member.
- Install into a real team project (ideally 3+ people); collect friction notes in `docs/dogfood.md`.

---

## 6. Definition of done (v1)
- [ ] Every member can install with one command. The first member sets up the repo by asking; everyone else joins automatically on their first session, in any order, concurrently.
- [ ] Claims, releases, decisions, notes, status, and sync happen without anyone typing a slash command; handoffs happen when asked.
- [ ] Teammates' claims, new decisions, notes, and handoffs addressed to me appear automatically at session start, within the line cap regardless of team size.
- [ ] Editing a file any teammate has claimed produces a visible warning naming every overlapping teammate, never a block.
- [ ] No state file is ever edited by two people → zero merge conflicts on `multiplayer-state` in tests with ≥ 3 concurrent writers.
- [ ] All hooks fail open and meet the time budgets; covered by tests.
- [ ] `node --test` passes with no network access (gh mocked).

---

## 7. Open questions (ask Mark before deciding)
_None open._

## 8. Decisions log
- **Name:** `multiplayer`.
- **Claim granularity:** free-text paths/globs plus an optional GitHub issue number; open-PR changed files are also used for overlap.
- **Stale claims:** default 3 days, configurable; teammates use `--takeover` (supersede, never delete someone else's claim).
- **Visibility:** private until dogfooded.
- **Release on merge:** automatic — PostToolUse hook on agent merges, plus a SessionStart check for PRs merged elsewhere. No GitHub Action. `keep: true` opts a claim out.
- **Handoffs vs notes:** handoff = pass work to a named person and transfer the claim; note = team update to everyone. Handoff always needs a recipient.
- **Automation:** every action runs automatically or when asked (handoff, creating the state branch); slash commands are only a manual override (§2.7).
