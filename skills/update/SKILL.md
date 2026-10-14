---
name: update
description: Bring your task branch up to date with the default branch by merging it in, and resolve any conflicts. Use when multiplayer says the default branch has new changes to your files or that your branch is behind, before opening a PR, or when the user asks to update or sync their branch.
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs *)
---

Update the current branch with the latest default branch. This team always **merges** (never rebases or force-pushes), so history is never rewritten.

1. Commit any work in progress first, with a clear message.
2. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs update`.
3. If it reports conflicts, the merge is in progress. For each conflicted file:
   - Read both sides and keep the intent of both changes.
   - If both sides changed the same logic in incompatible ways, explain the two versions to the user in plain language and ask which to keep.
   - Then `git add <file>`.
   When every file is resolved, run `git commit --no-edit`, and run the project's tests if it has them. To back out entirely, run `git merge --abort`.
4. Tell the user in one line, e.g. `multiplayer: merged 3 new commits from main into bob/fix-refunds (no conflicts)`.
