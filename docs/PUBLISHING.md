# Sharing and publishing multiplayer

This repository is its own Claude Code **marketplace**: `.claude-plugin/marketplace.json` lists one plugin, `multiplayer`, served from the repo root (`"source": "./"`). Anyone who can read the repo can install it. This page covers installing it from outside the team, running your own copy, cutting releases, and listing it publicly.

## The names to know

| Thing | Value | Where it's set |
|---|---|---|
| Plugin name | `multiplayer` | `.claude-plugin/plugin.json` → `name` |
| Marketplace name | `multiplayer-vibe-coding` | `.claude-plugin/marketplace.json` → `name` |
| Marketplace location | `mjrichar09/MultiplayerVibeCoding` | the GitHub repo |
| Full install id | `multiplayer@multiplayer-vibe-coding` | plugin name `@` marketplace name |

**Never rename the plugin or the marketplace casually.** Teams' `.claude/settings.json` files (written by the team-setup PR) refer to both names, and skills are invoked as `/multiplayer:<skill>`. If a rename is unavoidable, add a `renames` entry to `marketplace.json` (`{ "renames": { "old-name": "new-name" } }`) so existing installs follow it.

## Installing it (anyone)

In Claude Code:

```
/plugin install multiplayer --marketplace mjrichar09/MultiplayerVibeCoding
```

Or from a terminal:

```
claude plugin marketplace add mjrichar09/MultiplayerVibeCoding
claude plugin install multiplayer@multiplayer-vibe-coding
```

- **While the repo is private**, only people with read access to it can install. Their git or `gh` credentials are used to fetch it.
- **Teams don't need everyone to run the install command.** The team-setup PR adds `extraKnownMarketplaces` and `enabledPlugins` to the project's `.claude/settings.json`, so teammates are offered the plugin when they trust the folder.
- **Updates:** auto-update is off by default for third-party marketplaces. Users get new versions with `claude plugin marketplace update multiplayer-vibe-coding`, or by turning on auto-update for the marketplace in `/plugin`.

## Running your own copy (fork)

1. Fork the repo.
2. In `.claude-plugin/plugin.json`, change `repository`, `homepage`, `author`, `documentationUrl`, and `supportUrl` to point at your fork. **`repository` matters**: the team-setup PR reads it to write the marketplace location into teams' settings.
3. In `.claude-plugin/marketplace.json`, change `owner` and the entry's `author`, `homepage`, and `repository`. Give the marketplace a different `name` if both the original and your fork might be installed on one machine.
4. Install from your fork: `claude plugin marketplace add <you>/<fork>`, then `claude plugin install multiplayer@<your marketplace name>`.

Marketplace names that Anthropic reserves (such as `claude-plugins-official`, `claude-code-plugins`, anything starting with `anthropic-` or `claudeai-`, `github`, and `npm`) are rejected.

## Releasing a new version

`version` in `plugin.json` pins what users get: Claude Code only offers an update when it changes.

1. Run the checks:
   ```
   npm test
   claude plugin validate --strict .
   claude plugin validate --strict .claude-plugin/plugin.json
   ```
2. Try it end to end in a scratch repo: `claude --plugin-dir /path/to/this/repo`, then "Set up multiplayer for this repo."
3. Bump `version` in **both** `.claude-plugin/plugin.json` and `package.json` (semver: patch for fixes, minor for new features, major for anything that changes the shared-state format or settings teams already have).
4. Merge to `main`, then tag the release: `git tag v0.2.0 && git push origin v0.2.0`. Add release notes on GitHub saying what changed and whether teams need to do anything.

## Making it public

Before flipping the repo to public:

- [ ] Finish a real-team trial ([`dogfood.md`](dogfood.md)) and fix what it finds.
- [ ] Remove the "while this plugin's repo is private" note from the README quickstart.
- [ ] Turn on GitHub Issues (it's the plugin's `supportUrl`).
- [ ] Check that nothing private is in the history: `git log -p | grep -iE "token|secret|password"`, plus a read through `docs/` and `PLAN.md`.
- [ ] Release `1.0.0` once the shared-state format is something you're willing to keep compatible.

## Listing it in Anthropic's plugin directory

Once the repo is public, you can submit the plugin for listing at **https://claude.ai/directory/manage**. Submitting needs a paid claude.ai plan (Pro or Max, or an Owner on Team or Enterprise).

- Read the submission walkthrough and pre-submission checklist first: https://claude.com/docs/plugins/submit and https://claude.com/docs/plugins/pre-submission-checklist.
- `claude plugin validate --strict` must pass.
- The directory reads these `plugin.json` fields, which are already set: `displayName`, `description`, `author`, `homepage`, `repository`, `license`, `keywords`, `documentationUrl`, `supportUrl`. It can also show an `icon` (a path to an image in the repo, such as `./logo.png`) and links to a privacy policy and terms (`privacyPolicyUrl`, `termsOfServiceUrl`). multiplayer sends no data anywhere except your own git host, which is worth saying in a short privacy note.

Reference: [plugin manifest](https://code.claude.com/docs/en/plugins/manifest-reference), [marketplace manifest](https://code.claude.com/docs/en/plugins/marketplace-reference), [publishing](https://code.claude.com/docs/en/plugins/publish).
