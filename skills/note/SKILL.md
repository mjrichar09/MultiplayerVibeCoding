---
name: note
description: Post a short update to the whole team. Use proactively when you learn something teammates' sessions need — a broken setup step or environment, a flaky test, a changed command, a half-finished refactor others may trip over, a service that's down. Also use when the user asks to tell the team something.
argument-hint: "<text>"
allowed-tools: Bash(multiplayer *)
---

Post a team note. Text (if given): $ARGUMENTS

1. Write one headline line that stands alone (it's what teammates see in their briefing), optionally followed by a few lines of detail: what's affected, workaround, who to ask. Notes show for a few days, then age out.
2. Run:
   ```
   multiplayer note <<'EOF'
   <headline>
   <optional details>
   EOF
   ```
3. Tell the user in one line, e.g. `multiplayer: told the team "Staging DB is down; use the local fixtures"`.

If the note is a **setup step every newcomer will need** (a tool or version to install, an environment variable and where to get its value, access to request), also add it to the "Getting set up" section of `CLAUDE.md` on your task branch (create the section if it's missing), so it reaches teammates who join later: notes fade after a few days, `CLAUDE.md` doesn't. New teammates' agents check that section on their first session.

Don't use notes for decisions (use the decide skill) or for passing work to someone (use the handoff skill).
