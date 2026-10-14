# MultiplayerVibeCoding

This structures a repo so that a team can work together on a project seamlessly using agents.

It ships **crew**, a Claude Code plugin that adds an async coordination layer for a team of any size working on one repo: each person's Claude knows what teammates have claimed, what's been decided, and what was handed off — without a server.

> Status: early scaffold (Phase 0 of [`PLAN.md`](PLAN.md)). The skills are placeholders.

## Install

```
/plugin install crew --marketplace mjrichar09/MultiplayerVibeCoding
```

Or, on older Claude Code versions:

```
claude plugin marketplace add mjrichar09/MultiplayerVibeCoding
claude plugin install crew@multiplayer-vibe-coding
```

## Develop

```
npm test                       # node:test, no dependencies
claude plugin validate .       # check the manifest
claude --plugin-dir .          # load the local copy in a session
```

See [`PLAN.md`](PLAN.md) for the design and [`docs/research-notes.md`](docs/research-notes.md) for verified Claude Code format details.
