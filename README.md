# MultiplayerVibeCoding

This structures a repo so that a team can work together on a project seamlessly using agents.

It ships **multiplayer**, a Claude Code plugin that adds an async coordination layer for a team of any size working on one repo: each person's Claude knows what teammates have claimed, what's been decided, and what was handed off — without a server.

> Status: Phases 0–2 of [`PLAN.md`](PLAN.md) are done: team setup, automatic joining, claims, release-on-merge, the session-start briefing, and overlap warnings on edit. Decisions, notes, and handoffs come next.

## How it works

- **One person sets it up** by asking Claude to set up multiplayer (`/multiplayer:init`). This creates a `multiplayer-state` branch on the repo's remote.
- **Everyone else joins automatically** the first time they start a Claude Code session in the repo.
- **Agents claim work** before their first edit, with narrow file paths. Every session starts with a briefing of who has claimed what.
- **Editing a teammate's claimed file** makes Claude stop and check with you. It never blocks.
- **Claims release themselves** when their PR merges, whether an agent merged it or someone clicked Merge on GitHub.
- **Stale claims** (no activity for 3 days, configurable) can be taken over; the owner is told.

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
