# MultiplayerVibeCoding

This structures a repo so that a team can work together on a project seamlessly using agents.

It ships **multiplayer**, a Claude Code plugin that adds an async coordination layer for a team of any size working on one repo: each person's Claude knows what teammates have claimed, what's been decided, and what was handed off — without a server.

> Status: Phases 0–3 of [`PLAN.md`](PLAN.md) are done: team setup, automatic joining, claims, release-on-merge, the session-start briefing, overlap warnings, the git autopilot, decisions, notes, and handoffs. Next: PR-file overlap warnings (Phase 4), then CLAUDE.md sync and project templates (Phase 5).

## How it works

- **One person sets it up** by asking Claude to set up multiplayer (`/multiplayer:init`). This creates a `multiplayer-state` branch on the repo's remote.
- **Everyone else joins automatically** the first time they start a Claude Code session in the repo.
- **Agents claim work** before their first edit, with narrow file paths. Every session starts with a briefing of who has claimed what.
- **Editing a teammate's claimed file** makes Claude stop and check with you. It never blocks.
- **Claims release themselves** when their PR merges, whether an agent merged it or someone clicked Merge on GitHub.
- **Stale claims** (no activity for 3 days, configurable) can be taken over; the owner is told.
- **Decisions and notes spread on their own.** When a design choice is settled, the agent records a short decision record; when it learns something the team needs (a broken environment, a flaky test), it posts a note. Teammates see both at their next session start.
- **Handoffs when you ask.** "Bob is taking over checkout" makes the agent commit, push the branch, and write a handoff. Bob's next session accepts the claim, switches to the branch if he's free, and starts with the notes.
- **Git runs itself.** Each task gets its own branch from the latest `main`. Branches are kept current by merging `main` in (never rebasing), automatically at session start when that's safe. Conflicts are resolved by the agent, which asks you only when both sides changed the same logic. After a PR merges, you're switched back to an updated `main` and the old branch is deleted. Nothing automatic ever runs if it could lose work.

## Install

```
/plugin install multiplayer --marketplace mjrichar09/MultiplayerVibeCoding
```

Or, on older Claude Code versions:

```
claude plugin marketplace add mjrichar09/MultiplayerVibeCoding
claude plugin install multiplayer@multiplayer-vibe-coding
```

## Develop

```
npm test                       # node:test, no dependencies
claude plugin validate .       # check the manifest
claude --plugin-dir .          # load the local copy in a session
```

See [`PLAN.md`](PLAN.md) for the design and [`docs/research-notes.md`](docs/research-notes.md) for verified Claude Code format details.
