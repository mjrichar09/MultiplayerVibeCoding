# duo — a Claude Code plugin for two-person "multiplayer vibe coding"

> **For Claude Code:** This is the build plan. Read it fully, then start with **Phase 0**. Work phase by phase, commit at the end of each phase, and stop to report at each ⏸ checkpoint. Where this plan states a fact about Claude Code's plugin/hook/skill format, **verify it against the current official docs first** (code.claude.com/docs) — the docs win over this file.

---

## 1. Problem & goal

Two developers, each running their own Claude Code sessions against one shared repo. Today, each Claude only knows what its own human told it, which produces:

- duplicated or colliding work (both agents editing the same files)
- decisions made in one session that the other Claude never learns about, then contradicts
- lossy handoffs ("what did you change and why?")
- `CLAUDE.md` drift as the project evolves

**Goal:** a plugin that adds an **async coordination layer** so each person's Claude automatically knows what the partner is working on, what's been decided, and what was handed off — with minimal ceremony.

**Non-goals (v1):**
- Live shared sessions — use [claude-share](https://github.com/Paradigm-Study/claude-share) or similar alongside this; don't rebuild it.
- More than ~2–4 collaborators, hosted servers, dashboards, auth.
- Blocking anyone's work. Every guard **warns**, never blocks.

---

## 2. Core design decisions

### 2.1 Where shared state lives — an orphan git branch
Claims and decisions must be visible to the partner *immediately*, but feature branches aren't. So:

- State lives on an **orphan branch `duo-state`** in the same remote.
- Locally it's checked out as a **git worktree at `.duo/`** (gitignored in the main tree).
- Scripts `git pull --rebase` before reading and commit + push after writing.
- No server, no extra repo, works with any GitHub/GitLab remote.

*Fallback (config option, not default):* a `.collab/` folder committed to `main`.

### 2.2 Merge-conflict-free file layout — one file per entry
Never have two people edit the same state file.

```
.duo/
├── duo.config.json            # members, settings (written once by init)
├── claims/<user>--<slug>.md   # one file per active claim; deleted on release
├── decisions/NNNN-<slug>.md   # ADR-style, append-only, never edited after write
└── handoffs/<date>--<from>--to--<to>.md
```

Each file has YAML frontmatter (machine-readable) + markdown body (human/Claude-readable). Decision numbers: use timestamp-based IDs (e.g., `20261014-0943-<slug>`) to avoid numbering races.

### 2.3 Identity
`DUO_USER` env var → else `git config user.name` slugified. Partners listed in `duo.config.json`.

### 2.4 Implementation stack
- Hook/helper scripts: **Node (ESM), zero runtime dependencies**, one CLI entry `scripts/duo.mjs <subcommand>`.
- `gh` CLI optional (used for PR overlap detection; degrade gracefully if missing/unauthenticated).
- Skills (markdown) call the CLI via Bash so behavior is deterministic and testable outside Claude.

### 2.5 Hook guardrails (non-negotiable)
- **Fail open:** any error → exit 0 with no output (or a one-line note). Never break a session.
- **Fast:** SessionStart < 3s, PreToolUse < 1s. Network calls cached (TTL ~5 min) with hard timeouts.
- **Warn, don't block.**
- Never print or commit secrets; never read `.env*`.

---

## 3. Plugin layout (target — verify structure against docs)

```
duo/
├── .claude-plugin/
│   ├── plugin.json            # manifest
│   └── marketplace.json       # so it installs via `claude plugin marketplace add`
├── skills/
│   ├── duo-init/SKILL.md
│   ├── claim/SKILL.md
│   ├── release/SKILL.md
│   ├── status/SKILL.md
│   ├── decide/SKILL.md
│   ├── handoff/SKILL.md
│   └── sync/SKILL.md
├── hooks/hooks.json           # SessionStart, PreToolUse (Edit|Write|MultiEdit)
├── scripts/
│   ├── duo.mjs                # CLI entry
│   └── lib/                   # state, git, gh, identity, render
├── templates/                 # files scaffolded into the user's project by duo-init
│   ├── CLAUDE.md.tmpl
│   ├── settings.json.tmpl
│   └── PULL_REQUEST_TEMPLATE.md
├── test/                      # node:test; two-clone simulation harness
├── README.md
└── LICENSE (MIT)
```

---

## 4. Features (what each piece does)

| Feature | Trigger | Behavior |
|---|---|---|
| **init** | `/duo-init` | Creates `duo-state` orphan branch + `.duo/` worktree, writes config (members), adds `.duo/` to `.gitignore`, scaffolds `CLAUDE.md` / `.claude/settings.json` / PR template **only if absent** (otherwise offers a diff). Also handles the *joining* partner: if `duo-state` exists on remote, just attach the worktree. |
| **claim** | `/claim <task>` | Creates `claims/<user>--<slug>.md` with: task, branch, expected paths/globs, started time, notes. Warns if paths overlap an existing claim. |
| **release** | `/release [slug]` | Deletes the claim; optional one-line outcome appended to a `claims/_log.md`-style history *per user* (`history/<user>.md`) to stay conflict-free. Auto-suggested after PR merge. |
| **status** | `/status` | Renders: partner's active claims, decisions in last 14 days, unread handoffs addressed to me, stale claims (> N days). |
| **decide** | `/decide <summary>` | Claude drafts an ADR (context, decision, consequences, alternatives) from the current conversation, user confirms, file written + pushed. |
| **handoff** | `/handoff [to]` | Claude summarizes session: what changed (from `git diff`/log on branch), why, open questions, next steps, gotchas. Written + pushed. Marked read when recipient's SessionStart surfaces it. |
| **sync** | `/sync` | Reads recent decisions + merged PRs; proposes concrete edits to `CLAUDE.md` (show diff, apply on approval). Flags stale claims. |
| **SessionStart hook** | automatic | Pull state; inject a compact briefing into context: partner's claims (+paths), new decisions since my last session, handoffs to me. Hard cap ~40 lines. |
| **Overlap guard hook** | PreToolUse on Edit/Write/MultiEdit | If target file matches a partner's claimed path glob, **or** a file changed in partner's open PR (via `gh pr list` + `gh pr view --json files`, cached), emit a warning to Claude: "⚠️ <partner> is working on this file (claim: X / PR #N). Confirm with user before proceeding." |

---

## 5. Phases

### Phase 0 — Research & scaffold
1. Read current Claude Code docs for: plugins (manifest, marketplace), skills (SKILL.md frontmatter), hooks (event names, input JSON, how to inject context on SessionStart, how PreToolUse returns a warning without blocking), plugin env vars (e.g., plugin root path).
2. Review for ideas (check licenses before copying anything): [jsnkle/Claude-Code-Team-Collaboration-Guide](https://github.com/jsnkle/Claude-Code-Team-Collaboration-Guide), [peterkrueck/Claude-Code-Development-Kit](https://github.com/peterkrueck/Claude-Code-Development-Kit), [Paradigm-Study/claude-share](https://github.com/Paradigm-Study/claude-share).
3. Write `docs/research-notes.md` summarizing verified format details and any places this plan is wrong.
4. Scaffold the repo layout from §3 with a no-op hook to confirm the plugin loads locally.

⏸ **Checkpoint:** report doc findings + any plan corrections before writing real logic.

### Phase 1 — State store + identity + init
- `lib/git.mjs`: create orphan branch, add worktree, pull/commit/push with retries on non-fast-forward.
- `lib/identity.mjs`, `lib/state.mjs` (read/write frontmatter files).
- `duo init` (creator + joiner paths), `/duo-init` skill wrapping it.
- Tests: two temp clones of a bare repo simulate Alice and Bob.

### Phase 2 — Claims + SessionStart briefing
- `duo claim|release|status`, matching skills.
- SessionStart hook with the briefing renderer + "last seen" tracking stored locally (`.duo/.local/` gitignored on the state branch too).
- Tests: Alice claims → Bob's SessionStart output shows it.

⏸ **Checkpoint:** demo the two-clone flow end to end.

### Phase 3 — Decisions + handoffs
- `duo decide|handoff`, skills that have Claude draft content then call the CLI with the confirmed text.
- Briefing shows new decisions + unread handoffs; mark-as-read.

### Phase 4 — Overlap guard
- Path-glob matching against partner claims (no network).
- Optional `gh` PR-file overlap with cache + timeout.
- Tests for glob matching, cache, `gh`-missing fallback, and fail-open on errors.

### Phase 5 — Sync + templates
- `/sync` skill (proposes `CLAUDE.md` diff).
- `templates/` content: a solid team `CLAUDE.md` skeleton (stack, commands, conventions, "ask partner before" list, link to `.duo/decisions`), shared `settings.json` (secrets guard + destructive-command guard + formatter hooks as *project* hooks), PR template (what/why/how to test/claims released).

### Phase 6 — Packaging + dogfood
- `marketplace.json`, README with 2-minute quickstart for both creator and joiner.
- Install into a real two-person project; collect friction notes in `docs/dogfood.md`.

---

## 6. Definition of done (v1)
- [ ] Both partners can install with one command and run `/duo-init` (creator and joiner paths both work).
- [ ] Partner's claims, new decisions, and handoffs appear automatically at session start.
- [ ] Editing a file the partner has claimed produces a visible warning, never a block.
- [ ] No state file is ever edited by two people → zero merge conflicts on `duo-state` in tests.
- [ ] All hooks fail open and meet the time budgets; covered by tests.
- [ ] `node --test` passes with no network access (gh mocked).

---

## 7. Open questions (ask Mark before deciding)
1. Plugin name — `duo` is a placeholder.
2. Claim granularity: free-text paths/globs, or tie claims to GitHub Issues?
3. Should `/release` happen automatically when a PR merges (needs a GitHub Action), or stay manual in v1?
4. Public open-source from day one, or private until dogfooded?
