# MultiplayerVibeCoding

This structures a repo so that a team can work together on a project seamlessly using agents.

It ships **multiplayer**, a Claude Code plugin that adds an async coordination layer for a team of any size working on one repo: each person's Claude knows what teammates have claimed, what's been decided, and what was handed off — without a server.

> Status: Phases 0–5 of [`PLAN.md`](PLAN.md) are done. Next: packaging polish and a trial run with a real team (Phase 6).

## How it works

- **One person sets it up** by asking Claude to "set up multiplayer". This creates a `multiplayer-state` branch on the repo's remote and opens a team-setup PR with:
  - a team `CLAUDE.md` (Claude fills in the project, stack, and commands from the repo),
  - shared `.claude/settings.json` that offers the plugin to everyone who opens the repo, pre-approves the multiplayer commands and everyday git/PR commands, and blocks force-pushes, rebases, pushes to `main`, and reading `.env` files,
  - a PR template.

  Existing files are extended, never overwritten. The settings apply once each person accepts Claude Code's "trust this folder" prompt for the repo.
- **Everyone else joins automatically** the first time they start a Claude Code session in the repo.
- **Agents claim work** before their first edit, with narrow file paths. Every session starts with a briefing of who has claimed what.
- **Editing a file a teammate has claimed, or that a teammate's open PR changes,** makes Claude stop and check with you. It never blocks. (PR checks use the `gh` CLI when it's installed and signed in; without it, claim-based warnings still work.)
- **Claims release themselves** when their PR merges, whether an agent merged it or someone clicked Merge on GitHub.
- **Stale claims** (no activity for 3 days, configurable) can be taken over; the owner is told.
- **CLAUDE.md keeps up.** Its "Team decisions" section lists every current decision; when it falls behind, the agent updates it as its own commit. Conflicts in that section are settled automatically.
- **Decisions and notes spread on their own.** When a design choice is settled, the agent records a short decision record; when it learns something the team needs (a broken environment, a flaky test), it posts a note. Teammates see both at their next session start.
- **Handoffs when you ask.** "Bob is taking over checkout" makes the agent commit, push the branch, and write a handoff. Bob's next session accepts the claim, switches to the branch if he's free, and starts with the notes.
- **Merging is guarded.** Agents merge only after a PR's checks pass. They're warned if checks are failing, still running, or missing. `multiplayer protect` turns on GitHub branch protection, so failing PRs can't merge at all. To undo a merged PR, ask for it ("revert #42"): the agent opens a revert PR and tells the team. Later work is kept.
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

## Running several agents at once

- **Separate worktrees** (`git worktree`, [Orca](https://onorca.dev/), …): fully supported. Every worktree shares the team state and keeps its own branch, so each agent works as a normal session. `multiplayer worktree "<task>" --paths …` sets one up in a single step (new folder and branch from the latest `main`, plus a claim) and prints the command to start the agent there. Handy with terminal tools like [herdr](https://github.com/ogulcancelik/herdr) or tmux, which don't create worktrees themselves.
- **A lead agent with workers:** the lead claims the task, splits the files, and does all the git; workers only edit and are warned if they try git or claims.
  - *Subagents* are detected automatically: nothing to do.
  - *Separate sessions* (Orca worktrees, herdr panes): the lead uses the `delegate` skill on its own. It runs `multiplayer worktree "<part>" --paths … --worker` for each worker (a folder forked from the lead's commit, marked as a worker), then `multiplayer collect <folder>` to fold each worker's changes back into the lead's branch.
  - A worker that shares the lead's folder (e.g. a herdr pane in the same directory) must be started with `MULTIPLAYER_ROLE=worker claude`.
- **Several independent sessions in one folder** (e.g. herdr panes all opened in the project): works, but they share one checkout, so automatic git steps pause until the other sessions end. Separate worktrees are smoother.

Whatever the setup, your own agents are warned when they edit the same file as each other.

## Develop

```
npm test                       # node:test, no dependencies
claude plugin validate .       # check the manifest
claude --plugin-dir .          # load the local copy in a session
```

See [`PLAN.md`](PLAN.md) for the design and [`docs/research-notes.md`](docs/research-notes.md) for verified Claude Code format details.
