---
name: pitch
description: Pitch an idea to the whole team so it can be discussed and voted on. Use when the user has an idea they want teammates to consider ("pitch this", "I have an idea for…", "add my idea to the pitches"), or when the team is collecting options before choosing one with multiplayer:vote.
argument-hint: "<idea>"
allowed-tools: Bash(multiplayer *)
---

Pitch an idea to the team. Idea (if given): $ARGUMENTS

1. Help the user shape it, briefly. Ask only what's missing; don't invent features they didn't describe. A good pitch has:
   - **Name:** a few words.
   - **The hook:** two or three sentences on what it is and why it's exciting.
   - **What makes it stand out**, and a concrete example moment.
   - **Size and risk:** a rough size and the riskiest part, honestly.
   - **Links:** mockups or documents in the repo, if any (repo-relative paths).
2. If the repo's `CLAUDE.md` has house rules for pitches, follow them.
3. Read it back and confirm, then run (name on the first line):
   ```
   multiplayer pitch <<'EOF'
   <name>
   <the pitch>
   EOF
   ```
4. Tell the user in one line, e.g. `multiplayer: pitched "Night market" to the team`. Teammates see it in their next briefing and on the team board.
5. If several pitches are now in and the team seems ready to choose, offer to start a pick vote (multiplayer:vote).
