---
name: release
description: Release one of your multiplayer claims when you finish or abandon work without a merged PR. Claims on a branch release automatically when its PR merges, so use this only for work that ends some other way.
argument-hint: "[slug] [outcome]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs *)
---

Release a multiplayer claim. Request: $ARGUMENTS

1. Pick the claim's slug from "Your claims" in the multiplayer briefing (or run `node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs status`).
2. Run:
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs release <slug> --outcome "<one line: what happened>"
   ```
   With exactly one claim the slug can be omitted; `--all` releases all of yours.
3. Tell the user in one line, e.g. `multiplayer: released "fix-refunds" (abandoned, approach superseded)`.

Only the owner can release a claim. For a teammate's stale claim, use the claim skill's `--takeover` instead.
