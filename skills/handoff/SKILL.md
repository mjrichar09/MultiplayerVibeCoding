---
name: handoff
description: Pass your current work to a named teammate, transferring your claim and branch with notes on what changed, why, and what's next. Use only when the user asks to hand work to someone (e.g. "Bob is taking over checkout").
argument-hint: "<teammate>"
allowed-tools: Bash(multiplayer *) Bash(git add *) Bash(git commit *) Bash(git status*) Bash(git diff*) Bash(git log*)
---

Hand work to a teammate. Request: $ARGUMENTS

1. Identify the recipient (a teammate username from the briefing). If the user didn't name one, ask — a handoff always goes to a named person.
2. Commit all work in progress with a clear message (the handoff pushes your branch so they can continue on it).
3. Write the notes from the session and `git log`/`git diff` against the default branch. Keep each section short:
   - `## What changed` — the substance, by file or area
   - `## Why` — reasoning, and links to decisions if any
   - `## Open questions`
   - `## Next steps` — numbered, concrete
   - `## Gotchas` — anything surprising: setup, flaky tests, traps
4. Run:
   ```
   multiplayer handoff --to <teammate> [--claim <slug>] <<'EOF'
   ## What changed
   ...
   EOF
   ```
5. Tell the user in one line, e.g. `multiplayer: handed "redo-checkout" to bob on branch alice/redo-checkout`. Their next session accepts it automatically; your claim stays active until then.
