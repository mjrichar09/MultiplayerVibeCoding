---
name: delegate
description: Split a task across parallel agents running in their own worktrees (separate sessions, e.g. Orca or herdr panes), with you as the lead who owns git. Use whenever you are about to start other Claude Code sessions to work in parallel on this repo. Not needed for subagents you spawn with the Agent tool — those are workers automatically.
argument-hint: "<task>"
allowed-tools: Bash(multiplayer *) Bash(git add *) Bash(git commit *) Bash(git status*) Bash(git diff*) Bash(git log*) Bash(git worktree list*)
---

Run parallel worker agents for: $ARGUMENTS

You are the **lead**: you own the claim, all git, and the PR. Workers only edit their assigned files.

1. **Claim the whole task first** (multiplayer:claim) and commit your current work, so workers start from it.
2. **Split** the work into parts with non-overlapping files (e.g. `src/api/**` vs `src/ui/**`). Overlapping assignments cause merge conflicts.
3. **Create one worker worktree per part:**
   ```
   multiplayer worktree "<part>" --paths "<globs>" --worker
   ```
   This creates a folder and branch forked from your commit, marks its sessions as workers, and extends your claim to cover the paths. It prints the command to start the agent there.
4. **Start each worker** with the printed command (in Orca, herdr, or a new terminal), giving it a precise brief: its files, the goal, and "don't commit or touch git; report what you changed".
   - A worker that must share *your* folder instead of a worktree must be started with `MULTIPLAYER_ROLE=worker` in its environment (e.g. `MULTIPLAYER_ROLE=worker claude`), never by marking the folder.
5. **Collect each finished worker** — this commits its changes, merges its branch into yours, and removes the worktree:
   ```
   multiplayer collect "<worktree folder or branch>"
   ```
   On conflicts, resolve them (ask the user only when both sides changed the same logic), `git add`, `git commit --no-edit`, then run `collect` again to remove the worktree.
6. Review the combined result, run the tests, then push and open the PR as usual.

Tell the user in one line per step, e.g. `multiplayer: started 2 workers (src/api/**, src/ui/**) in their own worktrees`.
