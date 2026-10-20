---
name: escalate
description: Bring a decision to the whole team's attention and ask everyone to weigh in. Use when the user says "escalate this", "we need everyone to decide…", or "flag this for the team"; and suggest it (ask first) when you hit a choice that blocks work or changes how teammates work, and the user can't or shouldn't decide alone.
argument-hint: "<decision needed>"
allowed-tools: Bash(multiplayer *)
---

Escalate a decision to the team. Topic (if given): $ARGUMENTS

An escalation is an urgent decision check: one question. It tops every teammate's briefing and team panel until it's settled, and their Claude asks them to answer at their next session.

1. Frame it with the user, neutrally:
   - **The question**, in one line.
   - **Context:** two or three sentences on what's at stake, what it blocks, and by when.
   - **Options:** two to four, each with its upside and cost in one line. Put a recommendation first only if the user has one.
2. Read it back, confirm, then open it (add `"voters"` only to limit who's asked; everyone on the team by default):
   ```
   multiplayer escalate <<'EOF'
   {"title": "<the question>",
    "questions": [{"id": "q1", "text": "<the question>", "context": "<context>",
      "options": [{"label": "<option>", "note": "<upside and cost>"}, ...], "recommended": "<label or omit>"}]}
   EOF
   ```
3. Tell the user who's been asked, then offer to take their own answer now (multiplayer:vote, step 3).
4. Don't use this for things one person can decide or a note can cover (multiplayer:note).
