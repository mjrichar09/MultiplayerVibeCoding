# Trial run (dogfood)

A first trial with a real team, to find friction before anyone else uses multiplayer. Plan on a few days of normal work with **at least two people** (three or more is better), on a real project.

## Before you start

- [ ] Everyone has Claude Code, Node.js 18+, git, and read access to `mjrichar09/MultiplayerVibeCoding`.
- [ ] Ideally everyone has `gh` installed and signed in (`gh auth login`).
- [ ] Decide how production deploys work (see "Deploying safely" in the README). If merging to `main` deploys to production, add `Bash(multiplayer merge *)` and `Bash(gh pr merge *)` to `permissions.ask` in the setup PR's settings before merging it.

## Day 1: setup

- [ ] **Setup (one person):** "Set up multiplayer for this repo". Check that the team-setup PR is sensible: is `CLAUDE.md` filled in correctly? Merge it.
- [ ] **Branch protection:** accept the offer to turn it on (`multiplayer protect`), or note why it couldn't be turned on.
- [ ] **Joining (everyone else):** pull, open Claude Code, accept the trust prompt, install the plugin (project scope), start a session. Did you join automatically?
- [ ] **Health check (everyone):** ask "Is multiplayer working?" and paste anything that isn't ✓ into the log below.

## During the trial: try each of these at least once

- [ ] **Two people work on different things:** each session's start shows the other's claim.
- [ ] **Two people need the same file:** the second agent stops and asks before editing.
- [ ] **A PR merges:** its claim releases and the author ends up back on an updated `main`.
- [ ] **A teammate's merge touches your files:** your agent is told and runs the update (merge, not rebase).
- [ ] **A design choice gets made:** a decision is recorded, and `CLAUDE.md` picks it up via sync.
- [ ] **Something teammates need to know:** a note is posted, e.g. a broken setup step.
- [ ] **"Hand this to <name>"** mid-task: the recipient's next session continues on the branch.
- [ ] **A merged PR is undone:** "Undo PR #N" produces a revert PR and a note.
- [ ] **Parallel agents:** subagents, or "split this across parallel agents" with worktrees (Orca or herdr if you use them).
- [ ] **Cloud session** (Claude Code on the web or mobile), with `MULTIPLAYER_USER` set:
  - does `doctor` show **Sharing claims ✓**?
  - do claims made there appear for teammates?
  - do PR-overlap warnings and merge checks work there too?
- [ ] **Two of your own sessions on different machines at the same time:** do they warn each other?
- [ ] **Leave a claim untouched for 2+ days:** you're nudged to finish, release, or hand it off.

## What to note

For anything surprising, log: what you asked, what the agent did, what you expected, and how much it slowed you down. Also note:
- warnings that were noise (shown when they didn't matter);
- warnings that were missing (a collision nobody was told about);
- permission prompts that interrupted the flow;
- anything you had to do by hand that you expected to be automatic;
- whether the session-start summary is the right length.

## Known issues going in

- **Unverified:** whether a cloud session is allowed to push the `multiplayer-state` branch. `doctor` reports it ("Sharing claims").
- **Orca and herdr** were tested with real git worktrees, but not inside those apps.
- **Branch protection** on private repos needs a paid GitHub plan.

## Friction log

| Date | Who | Setup (local, cloud, worktrees…) | What happened | Expected | Impact (low / med / high) |
|---|---|---|---|---|---|
| 2026-10 | mjrichar09 | local, auto mode | Auto mode stopped the agent running `gh pr merge` | Agents merge green PRs without fuss | high: fixed: agents now merge with `multiplayer merge` (one pre-approved command that checks first, uses the REST API, and cleans up) |
| 2026-10 | mjrichar09 | local | Setup steps needed for testing (dependencies, configuration) were only obvious to whoever hit them first; recorded with a team note | Later teammates know what to set up | med: fixed: setup steps also go in CLAUDE.md's new "Getting set up" section, and a new teammate's first session walks them through it |
| 2026-10 | mjrichar09 | local | Installing asks for a scope (user, project, local); instructions didn't say which | Clear instructions | low: fixed: docs say to pick project scope |
| | | | | | |
