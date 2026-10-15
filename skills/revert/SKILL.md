---
name: revert
description: Undo a merged PR (or commit) safely through a revert PR, and tell the team. Use when the user asks to undo, roll back, or revert a merged change, or when a just-merged PR broke the default branch.
argument-hint: "<PR number | commit>"
allowed-tools: Bash(multiplayer *) Bash(git add *) Bash(git commit *) Bash(git status*) Bash(git diff*) Bash(git log*) Bash(git revert --continue*) Bash(git revert --abort*) Bash(git push *) Bash(gh pr create *) Bash(gh pr view *) Bash(gh pr checks *)
---

Undo a merged change: $ARGUMENTS

Reverting adds a new commit that reverses the merged one. Nothing is rewritten and later work stays, so it's always safe to try.

1. Make sure you know **which** PR or commit to undo. If the user was vague ("undo yesterday's change"), list the recently merged PRs (`gh pr list --state merged --limit 10`) and confirm with them.
2. Commit any work in progress, then run `multiplayer revert <PR number or commit>`. It starts a fresh branch from the latest default branch, claims the affected files, and makes the revert commit.
3. If it reports conflicts, later work was built on the change. Resolve each file so the reverted change is gone but unrelated later work is kept; if later work depends on what's being removed, explain the trade-off to the user and ask. Then `git add` the files and `git revert --continue`.
4. Run the project's tests. Push, and open a PR titled as the command suggests ("Revert #N: <title>"), explaining why in the description.
5. Post a team note (multiplayer:note): what was reverted and why, and that teammates' branches will pick up the revert automatically once it merges.
6. Merge the revert PR like any other: only after its checks pass.
7. Tell the user in one line, e.g. `multiplayer: opened a PR reverting #42 ("Add coupon codes") and told the team`.
