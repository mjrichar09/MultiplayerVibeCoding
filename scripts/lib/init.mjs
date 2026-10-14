// Setting up and joining a team (PLAN §4 init). The creator path makes the
// orphan state branch; every other member attaches to it and registers.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  STATE_BRANCH,
  attachStateWorktree,
  commitAndPush,
  createStateWorktree,
  defaultRemote,
  excludeStateDir,
  git,
  isAttached,
  pull,
  pushPending,
  remoteHasStateBranch,
  removeStateWorktree,
  repoRoot,
  stateDir,
} from './git.mjs';
import { identity } from './identity.mjs';
import { CONFIG_FILE, DEFAULT_CONFIG, listMembers, memberPath, readMember, writeJson } from './state.mjs';

export class InitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** Resolve repo root + remote, or throw an InitError explaining why we can't. */
export async function locate(cwd) {
  const root = await repoRoot(cwd);
  if (!root) throw new InitError('not-a-repo', 'Not inside a git repository.');
  const remote = await defaultRemote(root);
  if (!remote) throw new InitError('no-remote', 'This repository has no git remote to share team state through.');
  return { root, remote };
}

/**
 * Create or join the team for the repo containing `cwd`.
 * Returns { status: 'created' | 'joined' | 'member', user, root, members }.
 */
export async function init({ cwd, create = false, env = process.env, timeout } = {}) {
  const { root, remote } = await locate(cwd);
  const me = await identity(root, env);
  await excludeStateDir(root);

  let status = 'member';
  if (isAttached(root)) {
    await pull(stateDir(root), remote, { timeout });
    await pushPending(stateDir(root), remote, { timeout });
  } else if (await remoteHasStateBranch(root, remote, { timeout })) {
    await attachStateWorktree(root, remote, { timeout });
    status = 'joined';
  } else if (create) {
    status = (await createTeam(root, remote, me, { timeout })) ? 'created' : 'joined';
  } else {
    throw new InitError(
      'not-set-up',
      `This repository isn't set up for multiplayer yet (no ${STATE_BRANCH} branch on ${remote}). Run init with --create to set it up.`,
    );
  }

  const registered = await register(root, remote, me, { timeout });
  if (status === 'member' && registered) status = 'joined';
  return { status, user: me.user, root, members: await listMembers(stateDir(root)) };
}

/** Returns true if we created the branch, false if a concurrent creator beat us and we joined theirs. */
async function createTeam(root, remote, me, { timeout }) {
  const dir = stateDir(root);
  await createStateWorktree(root);
  await writeJson(path.join(dir, CONFIG_FILE), {
    ...DEFAULT_CONFIG,
    createdBy: me.user,
    created: new Date().toISOString(),
  });
  // Per-member read/unread state lives in .local/ and never leaves the machine.
  await writeFile(path.join(dir, '.gitignore'), '.local/\n');
  await git(['add', '--all'], { cwd: dir });
  await git(['commit', '--quiet', '-m', `multiplayer: create team (${me.user})`], { cwd: dir });
  try {
    await git(['push', '--quiet', '-u', remote, `HEAD:refs/heads/${STATE_BRANCH}`], { cwd: dir, timeout });
    return true;
  } catch (err) {
    if (!(await remoteHasStateBranch(root, remote, { timeout }))) throw err;
    // Someone else created the team first; discard ours and join theirs.
    await removeStateWorktree(root);
    await attachStateWorktree(root, remote, { timeout });
    return false;
  }
}

/** Write my member file if missing or inactive. Returns true if it changed. */
async function register(root, remote, me, { timeout }) {
  const dir = stateDir(root);
  const existing = await readMember(dir, me.user);
  if (existing) {
    if (existing.email && me.email && existing.email.toLowerCase() !== me.email.toLowerCase()) {
      throw new InitError(
        'identity-collision',
        `The username "${me.user}" already belongs to ${existing.email}. Set MULTIPLAYER_USER to a different name and try again.`,
      );
    }
    if (existing.active !== false) return false;
  }
  const member = {
    user: me.user,
    name: me.name,
    email: me.email,
    joined: existing?.joined ?? new Date().toISOString(),
    active: true,
  };
  await writeJson(memberPath(dir, me.user), member);
  await commitAndPush(dir, remote, [path.relative(dir, memberPath(dir, me.user))], `multiplayer: ${me.user} joined`, {
    timeout,
  });
  return true;
}
