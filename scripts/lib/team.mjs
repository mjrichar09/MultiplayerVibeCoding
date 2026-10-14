// Open the current repo's team for reading or writing.

import { pull, pushPending, isAttached, stateDir } from './git.mjs';
import { identity } from './identity.mjs';
import { InitError, locate } from './init.mjs';
import { listMembers, readConfig } from './state.mjs';

/**
 * Returns { root, remote, dir, me, config, members } for an attached team.
 * With `sync`, pulls teammates' changes and pushes any of ours still pending.
 */
export async function openTeam(cwd, { env = process.env, sync = true, timeout } = {}) {
  const { root, remote } = await locate(cwd);
  if (!isAttached(root)) {
    throw new InitError('not-set-up', 'This repository has no multiplayer team here yet. Run init first.');
  }
  const dir = stateDir(root);
  if (sync) {
    await pull(dir, remote, { timeout });
    await pushPending(dir, remote, { timeout });
  }
  const [me, config, members] = await Promise.all([identity(root, env), readConfig(dir), listMembers(dir)]);
  return { root, remote, dir, me, config, members, env };
}
