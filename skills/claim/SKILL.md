---
name: claim
description: Claim a task and the files it will touch so every teammate's Claude knows you're working there. Use proactively before your first edit on a new task, when a multiplayer hook says none of your claims covers a file, or when the user asks to take over a teammate's stale claim.
argument-hint: "<task> [#issue]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs *)
---

Claim work for this repository's multiplayer team. Request: $ARGUMENTS

1. Decide the **task** (a short phrase, e.g. "Redo checkout flow") and the **paths** it will touch, as repo-relative files or globs. Keep them narrow: the directories and files you actually expect to change (`src/checkout/**`, `src/api/payments.ts`), not `src/**`. Include a GitHub issue number if the work has one.
2. If you already have a claim for this work (it appears under "Your claims" in the multiplayer briefing) and it just needs more paths, extend it instead of creating a new one: pass its slug with `--slug <slug>` and only the new paths.
3. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs claim --task "<task>" --paths "<path1>,<path2>" [--issue <n>] [--keep] [--notes "<context>"]
   ```
   - `--keep` keeps the claim open after its PR merges. Use it only when this PR is one part of a larger task.
   - To take over a teammate's **stale** claim (only when the user wants that work picked up), run `claim --takeover <user>--<slug>`. Non-stale claims can't be taken over; suggest the user ask the owner instead.
4. Tell the user in one line, e.g. `multiplayer: claimed src/checkout/** for "Redo checkout flow"`.
5. If the output has ⚠️ overlap lines, tell the user which teammates are working in the same files and ask how to proceed before editing those files.
