---
name: decide
description: Record a team decision (a short ADR) so every teammate's Claude learns it. Use proactively when a design or architecture choice is settled in conversation — the user agreed to an approach, or an alternative was rejected for a stated reason — and it affects how others should work. Also use when the user asks to record a decision.
argument-hint: "<summary>"
allowed-tools: Bash(multiplayer *)
---

Record a decision for the whole team. Summary (if given): $ARGUMENTS

1. Only record choices that matter beyond this one change: conventions, libraries, data models, APIs, workflows. Skip trivia. If an earlier decision (listed in the briefing or in `.multiplayer/decisions/`) is being reversed, note its id to supersede it.
2. Draft it from the conversation — short and concrete:
   - **Title:** one line stating the decision (e.g. "Compute cart totals on the server").
   - **Body:** four short sections — `## Context` (the problem), `## Decision` (what we'll do), `## Consequences` (what changes for everyone, including what to avoid), `## Alternatives` (what was rejected and why).
3. Record it, passing the body on stdin:
   ```
   multiplayer decide --title "<title>" [--supersedes <id>] <<'EOF'
   ## Context
   ...
   EOF
   ```
4. Tell the user in one line, e.g. `multiplayer: recorded decision "Compute cart totals on the server"`. Don't ask for confirmation first; if the user disagrees, record a corrected decision with `--supersedes`.
