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
├── handoffs/<ts>--<from>--<slug>.md   # recipients in frontmatter (`to: [bob, carol]` or `to: all`)
└── history/<user>.md                # per-member log of released claims
```

- Each file has YAML frontmatter (machine-readable) + markdown body (human/Claude-readable).
- IDs are timestamp-based (`20261014-0943`) **plus the author slug**, so two members writing in the same minute never collide and nobody has to coordinate a counter.
- **Membership is the set of files in `members/`.** Joining adds a file; leaving sets `"active": false` in your own file. No one edits a shared roster, so N members can join concurrently.
- Handoff recipients live in frontmatter, not the filename, so a handoff can target one person, several, or `all`.
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
- **Briefing size:** the SessionStart briefing has a hard cap (~40 lines) regardless of team size. It prioritizes, in order: handoffs addressed to me → claims overlapping my current branch/claims → new decisions → other teammates' claims grouped per person, most recent first. Anything past the cap collapses to a summary line (`+7 more claims from carol, dan, erin — run /multiplayer:status`).
- **Overlap warnings** list *every* teammate whose claim or open PR touches the file, not just the first match.
- **Inactive members** (left the team, or no activity in N days, configurable) are hidden from briefings but their claims still show as stale.
- **Stale claims:** only the owner deletes their claim. Others see stale claims flagged in `/status` and the briefing; `/release --stale <user>/<slug>` is out of scope for v1 (see §7).

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
│   └── sync/SKILL.md
├── hooks/hooks.json           # SessionStart, PreToolUse (Edit|Write|MultiEdit)
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

| Feature | Trigger | Behavior |
|---|---|---|
| **init** | `/multiplayer:init` | **Creator** (no `multiplayer-state` on remote): creates the orphan branch + `.multiplayer/` worktree, writes `multiplayer.config.json`, registers self in `members/`. **Joiner** (branch exists): attaches the worktree and registers self in `members/`. Both: add `.multiplayer/` to `.gitignore`, scaffold `CLAUDE.md` / `.claude/settings.json` / PR template **only if absent** (otherwise offer a diff). Any number of members can join, in any order, concurrently. |
| **claim** | `/multiplayer:claim <task>` | Creates `claims/<user>--<slug>.md` with: task, branch, expected paths/globs, started time, notes. Warns, listing **each** teammate whose claim overlaps the paths. |
| **release** | `/multiplayer:release [slug]` | Deletes my claim; optional one-line outcome appended to `history/<user>.md`. Auto-suggested after PR merge. |
| **status** | `/multiplayer:status [user]` | Renders, grouped by teammate: active claims, decisions in last 14 days, unread handoffs addressed to me or `all`, stale claims (> N days). Optional filter to one teammate. |
| **decide** | `/multiplayer:decide <summary>` | Claude drafts an ADR (context, decision, consequences, alternatives) from the current conversation, user confirms, file written + pushed. Visible to every member. |
| **handoff** | `/multiplayer:handoff [to...|all]` | Claude summarizes session: what changed (from `git diff`/log on branch), why, open questions, next steps, gotchas. Recipients: one or more members, or `all` (default when omitted: ask). Written + pushed. Marked read *per recipient, locally* when their SessionStart surfaces it. |
| **sync** | `/multiplayer:sync` | Reads recent decisions (from all members) + merged PRs; proposes concrete edits to `CLAUDE.md` (show diff, apply on approval). Flags stale claims. |
| **SessionStart hook** | automatic | Pull state; inject a compact briefing into context, prioritized and capped per §2.6. |
| **Overlap guard hook** | PreToolUse on Edit/Write/MultiEdit | If the target file matches any teammate's claimed path glob, **or** a file changed in any teammate's open PR (via `gh pr list` + `gh pr view --json files`, cached), add context for Claude: "⚠️ carol (claim: X) and dan (PR #N) are working on this file. Confirm with user before proceeding." |

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
- `multiplayer init` (creator + joiner paths), `/multiplayer:init` skill wrapping it.
- Tests: an **N-clone harness** — a bare repo plus `n` temp clones (default 3: alice, bob, carol). Cover: one creator + several joiners; two joiners registering concurrently.

### Phase 2 — Claims + SessionStart briefing
- `multiplayer claim|release|status`, matching skills.
- SessionStart hook with the briefing renderer (grouping, prioritization, cap) + "last seen" tracking stored locally (`.multiplayer/.local/`, gitignored on the state branch too).
- Tests: alice and bob claim → carol's SessionStart output shows both, grouped; with 10 simulated members the briefing stays within the line cap.

⏸ **Checkpoint:** demo the multi-clone flow end to end.

### Phase 3 — Decisions + handoffs
- `multiplayer decide|handoff`, skills that have Claude draft content then call the CLI with the confirmed text.
- Handoffs to one member, several, or `all`; per-recipient local read tracking.
- Briefing shows new decisions + unread handoffs.
- Tests: handoff to `[bob, carol]` appears for both, not for dan; `all` appears for everyone except the author; marking read in one clone doesn't affect another.

### Phase 4 — Overlap guard
- Path-glob matching against all teammates' claims (no network).
- Optional `gh` PR-file overlap across all teammates' open PRs, with cache + timeout (refreshed by SessionStart / background, read-only in PreToolUse).
- Tests for glob matching, multiple simultaneous overlaps, cache, `gh`-missing fallback, and fail-open on errors.

### Phase 5 — Sync + templates
- `/multiplayer:sync` skill (proposes `CLAUDE.md` diff).
- `templates/` content: a solid team `CLAUDE.md` skeleton (stack, commands, conventions, "ask before touching" list with owners, link to `.multiplayer/decisions`), shared `settings.json` (secrets guard + destructive-command guard + formatter hooks as *project* hooks), PR template (what/why/how to test/claims released).

### Phase 6 — Packaging + dogfood
- `marketplace.json`, README with 2-minute quickstart for the creator and for each joining member.
- Install into a real team project (ideally 3+ people); collect friction notes in `docs/dogfood.md`.

---

## 6. Definition of done (v1)
- [ ] Every member can install with one command and run `/multiplayer:init` (creator and joiner paths both work; joiners can join in any order, concurrently).
- [ ] Teammates' claims, new decisions, and handoffs addressed to me or to `all` appear automatically at session start, within the line cap regardless of team size.
- [ ] Editing a file any teammate has claimed produces a visible warning naming every overlapping teammate, never a block.
- [ ] No state file is ever edited by two people → zero merge conflicts on `multiplayer-state` in tests with ≥ 3 concurrent writers.
- [ ] All hooks fail open and meet the time budgets; covered by tests.
- [ ] `node --test` passes with no network access (gh mocked).

---

## 7. Open questions (ask Mark before deciding)
1. Claim granularity: free-text paths/globs, or tie claims to GitHub Issues?
2. Should `/release` happen automatically when a PR merges (needs a GitHub Action), or stay manual in v1?
3. Should a member be able to release someone else's stale claim (e.g. a teammate on vacation), or stay owner-only in v1?
4. Handoff default when no recipient is given: ask, or default to `all`?
5. Public open-source from day one, or private until dogfooded?
