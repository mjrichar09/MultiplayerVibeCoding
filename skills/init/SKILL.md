---
name: init
description: Set up multiplayer team coordination in this repository, or join the team if it is already set up. Use only when the user asks to set up or join multiplayer; joining normally happens automatically at session start.
argument-hint: "[--create]"
allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs *)
---

Set up or join this repository's multiplayer team.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/multiplayer.mjs init` from the project root.
2. If it prints that the repository isn't set up yet:
   - If the user asked to **set up** multiplayer (or passed `--create`: $ARGUMENTS), run it again with `--create`. This pushes a new `multiplayer-state` branch to the repository's remote, which every teammate's Claude will use.
   - Otherwise tell the user the repository isn't set up and ask whether they want to set it up. Do not create it unasked.
3. If it fails with a username collision, tell the user another member already uses that name and ask what name they want; then rerun with `MULTIPLAYER_USER=<name>` set in the command's environment.
4. Report the result in one line, e.g. `multiplayer: created the team as alice (1 member)`.

Teammates don't need to run anything: once the plugin is installed, their next session joins the team automatically.
