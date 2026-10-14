# Phase 0 research notes

Verified against code.claude.com/docs on 2026-10-14 with Claude Code 2.1.299. Where these notes and `PLAN.md` disagree, these notes win.

## Plugin manifest & layout
- Manifest lives at `.claude-plugin/plugin.json`. It is optional; only `name` is required (kebab-case). `version`, `description`, `author` are recommended (`claude plugin validate` warns without them).
- Components live at the plugin root, **not** inside `.claude-plugin/`: `skills/<name>/SKILL.md`, `hooks/hooks.json`, `commands/`, `agents/`, `.mcp.json`, `bin/`.
- Plugin names may not start with `claude-` / `anthropic-` etc. `crew` is fine.
- `CLAUDE.md` at the plugin root is **not** loaded as context (validate warns). Context must come from skills or hooks.
- `claude plugin validate .` is the authoritative check; `claude --plugin-dir .` loads the plugin for a session.

## Marketplace
- `.claude-plugin/marketplace.json` with required `name`, `owner.name`, `plugins[]`. Each entry needs `name` + `source`.
- A relative `source` resolves from the marketplace root (the dir containing `.claude-plugin/`), must start with `./`; `"./"` lets one repo be both the marketplace and the plugin. Relative sources work for `github`/`git` marketplace sources (not for a bare `url` to the JSON file).
- Install: `claude plugin marketplace add mjrichar09/MultiplayerVibeCoding`, then `/plugin install crew@multiplayer-vibe-coding` (or the one-step `/plugin install crew --marketplace mjrichar09/MultiplayerVibeCoding` on ≥ 2.1.275, which validate suggests for the README).

## Skills
- `skills/<dir>/SKILL.md` with YAML frontmatter. Useful fields: `name`, `description`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`.
- **Plugin skills are namespaced: `/crew:claim`, not `/claim`.** The plan's bare `/claim` etc. were wrong; `PLAN.md` now uses `/crew:<skill>`, so the init skill is just `init` (→ `/crew:init`) rather than `duo-init`.
- Arguments: `$ARGUMENTS`, `$ARGUMENTS[N]` / `$N`, or named `$name` via `arguments:`.
- `${CLAUDE_PLUGIN_ROOT}` is substituted inline in skill bodies and in `allowed-tools` Bash rules, e.g. `allowed-tools: Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/crew.mjs *)`. It is **not** set in the Bash tool's environment — skills must use the inline substitution.
- Gotcha: `argument-hint` values like `[user... | all]` must be quoted or YAML parses them as a list.

## Hooks
- Plugin hooks file: `hooks/hooks.json` with a top-level `"hooks"` wrapper around the event map.
- Use shell form with the variable quoted: `node "${CLAUDE_PLUGIN_ROOT}"/scripts/crew.mjs hook session-start`. Hook processes also get `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PROJECT_DIR` in their env.
- `timeout` is in **seconds** (default 600 for command hooks). A timed-out PreToolUse hook does not block.
- Matchers: `Edit|Write` style lists; SessionStart matchers are `startup|resume|clear|compact|fork`.
- **SessionStart** stdin: common fields (`session_id`, `transcript_path`, `cwd`, `hook_event_name`) + `source`. Inject context either as plain stdout (exit 0) or JSON `{"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}`. We'll use the JSON form.
- **PreToolUse** stdin: common fields + `tool_name`, `tool_input` (`file_path` for Edit/Write), `tool_use_id`. To **warn without blocking**, return `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "additionalContext": "⚠️ ..."}}` with **no** `permissionDecision` (`allow` would auto-approve; `deny`/`ask` change the flow). Optional top-level `systemMessage` is shown to the user.
- Exit codes: 0 = success (stdout parsed as JSON if it's one object); 2 = blocking for PreToolUse — **never use it**; other codes = non-blocking error notice. Our fail-open rule = always exit 0, empty stdout on error.
- `MultiEdit` is kept in the matcher for older Claude Code versions; harmless if the tool doesn't exist.

## Ideas from reference repos (all MIT; nothing copied)
- **jsnkle/Claude-Code-Team-Collaboration-Guide** — commit shared `.claude/` + a team `CLAUDE.md` template (stack, key dirs, contacts) and path-scoped rules. Feeds the Phase 5 templates. Doesn't cover claims/decisions/handoffs, which confirms the gap this plugin fills.
- **peterkrueck/Claude-Code-Development-Kit** — tiered context loading and advisory (never blocking) review hooks; secret scanner hook; deny rules for force-push / `rm -rf`. Matches our "warn, don't block" stance and informs the Phase 5 `settings.json` template.
- **Paradigm-Study/claude-share** — live shared sessions via a relay server (host runs everything). Complementary, as the plan says; `crew` stays async and serverless.

## Plan corrections applied
1. Generalized from two people to N members (one-writer-per-file layout, `members/` directory instead of a roster in config, multi-recipient handoffs, capped/prioritized briefing, push retries with jitter).
2. Renamed placeholder `duo` → `crew` (open question in §7).
3. Skills are invoked as `/crew:<skill>`.
4. Repo root is both the plugin and a single-plugin marketplace (`source: "./"`).
