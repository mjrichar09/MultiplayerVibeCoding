---
name: status
description: Show every multiplayer claim on the team, grouped by teammate, with stale and merged-PR flags. Use before starting new work to see what teammates are doing, when the briefing says more claims are hidden, or when the user asks what the team is working on.
argument-hint: "[user]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs *)
---

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs status $ARGUMENTS` and summarize the result for the user. Point out anything that affects the current task: overlapping claims, stale claims in the area, or teammate claims whose PRs already merged.
