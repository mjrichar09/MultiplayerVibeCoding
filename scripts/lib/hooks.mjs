// Hook handlers. Each returns a hook output object or null. The CLI wrapper
// makes every handler fail open (PLAN §2.5).

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isAttached, localDir, remoteHasStateBranch } from './git.mjs';
import { InitError, init, locate } from './init.mjs';

// Network operations in hooks get a hard per-call timeout so a slow remote
// can't stall session start.
export const HOOK_NET_TIMEOUT_MS = 3_000;

const sessionStartOutput = (context, userMessage) => ({
  ...(userMessage ? { systemMessage: userMessage } : {}),
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
});

const memberList = (members) =>
  members
    .filter((m) => m.active !== false)
    .map((m) => m.user)
    .join(', ');

export async function sessionStart(input, { env = process.env } = {}) {
  const cwd = input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd();
  let located;
  try {
    located = await locate(cwd);
  } catch (err) {
    if (err instanceof InitError) return null; // not a repo / no remote: nothing to coordinate
    throw err;
  }
  const { root, remote } = located;
  const timeout = HOOK_NET_TIMEOUT_MS;

  // Opt-in per repo: never create the shared branch unasked (PLAN §2.7).
  if (!isAttached(root) && !(await remoteHasStateBranch(root, remote, { timeout }))) {
    const marker = path.join(await localDir(root), 'setup-offered');
    if (existsSync(marker)) return null;
    await writeFile(marker, `${new Date().toISOString()}\n`);
    return sessionStartOutput(
      'multiplayer: this repository is not set up for team coordination. ' +
        'Only if the user asks to set it up, use the multiplayer:init skill. Do not set it up unasked.',
    );
  }

  const result = await init({ cwd: root, env, timeout });
  const team = memberList(result.members);
  if (result.status === 'joined') {
    return sessionStartOutput(
      `multiplayer: you joined this repo's team as "${result.user}". Team: ${team}.`,
      `multiplayer: joined team as ${result.user} (${result.members.length} members)`,
    );
  }
  // Phase 2 replaces this with the full briefing.
  return sessionStartOutput(`multiplayer: you are "${result.user}" on this repo's team. Team: ${team}.`);
}
