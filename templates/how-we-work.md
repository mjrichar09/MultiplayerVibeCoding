## How we work (multiplayer)
This repo uses the multiplayer plugin for Claude Code, so every teammate's Claude shares one picture of the work:
- **Claims:** before editing, each agent claims its task and the files it expects to touch. Every session starts with a briefing of who is working where; editing a teammate's claimed file (or a file in their open PR) warns first.
- **Git:** one task, one branch (`<user>/<task>`), started from the latest `{{defaultBranch}}`. Branches stay current by merging `{{defaultBranch}}` in, never rebasing. Never force-push or commit directly to `{{defaultBranch}}`. Finished work goes through a PR; once its checks pass, the agent merges it with `multiplayer merge` (squash), and claims and branches clean up automatically.
- **Decisions and notes:** settled design choices are recorded in `.multiplayer/decisions/` and summarized below; things teammates need to know are posted as team notes.
- **Seeing the team:** the panel above the prompt (and `/team-board`) shows who is working on what; so does the [`multiplayer-state` branch's page](../../tree/multiplayer-state) on GitHub.
- **Handoffs:** to pass work on, ask your agent to hand it to a teammate by name.
