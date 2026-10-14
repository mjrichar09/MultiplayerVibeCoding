---
name: init
description: Set up multiplayer team coordination in this repository, or join the team if it is already set up. Use only when the user asks to set up or join multiplayer; joining normally happens automatically at session start.
argument-hint: "[--create]"
allowed-tools: Bash(multiplayer *)
---

Set up or join this repository's multiplayer team.

1. Run `multiplayer init` from the project root.
2. If it prints that the repository isn't set up yet:
   - If the user asked to **set up** multiplayer (or passed `--create`: $ARGUMENTS), run it again with `--create`. This pushes a new `multiplayer-state` branch to the repository's remote, which every teammate's Claude will use.
   - Otherwise tell the user the repository isn't set up and ask whether they want to set it up. Do not create it unasked.
3. If it fails with a username collision, tell the user another member already uses that name and ask what name they want; then rerun with `MULTIPLAYER_USER=<name>` set in the command's environment.
4. **After creating a team** (not when joining), add the shared team files: run `multiplayer scaffold`. It never overwrites anything; it creates or extends, on a `<user>/multiplayer-setup` branch:
   - `CLAUDE.md`: a team skeleton (or just the multiplayer sections appended to an existing one). Fill in the placeholder sections (Project, Stack, Commands, Conventions) from what you can see in the repo — README, package/build files, CI config — and leave "Ask before touching" for the user. Commit.
   - `.claude/settings.json`: offers the plugin to everyone who opens the repo, pre-approves the multiplayer skills and everyday git/PR commands so agents aren't stuck on permission prompts, and blocks force-pushes, rebases, pushes to the default branch, and reading `.env` files.
   - `.github/PULL_REQUEST_TEMPLATE.md` if the repo has no PR template.
   Then push the branch and open a PR; tell the user the team gets these files when it merges.
5. Report the result in one line, e.g. `multiplayer: created the team as alice (1 member) and opened the team-setup PR`.

Teammates don't need to run anything: once the plugin is installed, their next session joins the team automatically.
