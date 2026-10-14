---
name: sync
description: Bring CLAUDE.md up to date with the team's recorded decisions. Use when the multiplayer briefing says CLAUDE.md is missing team decisions, after recording a decision that changes conventions or commands, or when merging leaves a conflict in CLAUDE.md's Team decisions section.
allowed-tools: Bash(multiplayer *) Bash(git add *) Bash(git commit *) Bash(git status*) Bash(git diff*)
---

Keep CLAUDE.md current with team decisions.

1. Commit your work in progress first.
2. Run `multiplayer sync`. It rewrites the "Team decisions" section from `.multiplayer/decisions/` and commits CLAUDE.md on your task branch (starting `<user>/sync-claude-md` if you're on the default branch).
3. Read the decisions it added. If one changes something CLAUDE.md states elsewhere — a convention, a command, a folder layout, an "ask before touching" owner — update that section too, keeping it short, and commit with a message like `docs: CLAUDE.md follows "<decision title>"`.
4. If you were on the default branch, push the new branch and open a PR.
5. **Merge conflict in the Team decisions section** (from `multiplayer update` or a PR merge): run `multiplayer sync --resolve`, then `git commit --no-edit`. Conflicts elsewhere in CLAUDE.md need a normal resolution.
6. Tell the user in one line, e.g. `multiplayer: CLAUDE.md now lists the decision "Store all money as integer cents"`.
