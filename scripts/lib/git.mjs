// Git plumbing for the shared state branch: an orphan branch checked out as a
// worktree inside the project. Every write is one-file-per-author (PLAN §2.2),
// so `pull --rebase` never conflicts; only the push can lose a race.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const STATE_BRANCH = 'multiplayer-state';
export const STATE_DIR = '.multiplayer';

export class GitError extends Error {
  constructor(args, stderr, code) {
    super(`git ${args.join(' ')} failed: ${stderr.trim() || `exit ${code}`}`);
    this.stderr = stderr;
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gitOnce(args, { cwd, timeout, env }) {
  return new Promise((resolve, reject) => {
    const opts = { cwd, timeout, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) };
    execFile('git', args, opts, (err, stdout, stderr) => {
      if (err) reject(new GitError(args, stderr || err.message, err.code));
      else resolve(stdout.trimEnd());
    });
  });
}

// Another multiplayer process (e.g. the background refresh) may briefly hold
// the worktree's lock; wait it out instead of failing.
const LOCKED = /index\.lock|\.lock': File exists|cannot lock ref|unable to create .*\.lock|another git process/i;

export async function git(args, { cwd, timeout = 30_000, env } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await gitOnce(args, { cwd, timeout, env });
    } catch (err) {
      if (attempt >= 8 || !LOCKED.test(err.stderr ?? '')) throw err;
      await sleep(100 * (attempt + 1));
    }
  }
}

/** Project root of the main working tree containing `cwd`, or null if not a git repo. */
export async function repoRoot(cwd) {
  try {
    return await git(['rev-parse', '--show-toplevel'], { cwd, timeout: 5_000 });
  } catch {
    return null;
  }
}

export async function gitCommonDir(root) {
  const dir = await git(['rev-parse', '--git-common-dir'], { cwd: root });
  return path.resolve(root, dir);
}

/** Per-clone private directory inside .git, never shared or committed. */
export async function localDir(root) {
  const dir = path.join(await gitCommonDir(root), 'multiplayer');
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function defaultRemote(root) {
  const remotes = (await git(['remote'], { cwd: root })).split('\n').filter(Boolean);
  if (remotes.length === 0) return null;
  return remotes.includes('origin') ? 'origin' : remotes[0];
}

export async function remoteHasStateBranch(root, remote, { timeout } = {}) {
  const out = await git(['ls-remote', '--heads', remote, STATE_BRANCH], { cwd: root, timeout });
  return out.trim().length > 0;
}

export const stateDir = (root) => path.join(root, STATE_DIR);

export function isAttached(root) {
  return existsSync(path.join(stateDir(root), '.git'));
}

/** Keep the worktree out of the main tree's `git status` without touching tracked files. */
export async function excludeStateDir(root) {
  const file = path.join(await gitCommonDir(root), 'info', 'exclude');
  await mkdir(path.dirname(file), { recursive: true });
  const current = existsSync(file) ? await readFile(file, 'utf8') : '';
  const line = `/${STATE_DIR}/`;
  if (current.split('\n').some((l) => l.trim() === line)) return;
  await appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
}

/**
 * Create a brand-new orphan state branch, rooted at an empty commit, and check
 * it out in the worktree. Built from plumbing so it works in a repo with no
 * commits yet and on git versions without `worktree add --orphan`. Does not push.
 */
export async function createStateWorktree(root, message = 'multiplayer: start') {
  const scratch = await mkdtemp(path.join(tmpdir(), 'multiplayer-index-'));
  try {
    // An index file that doesn't exist yet writes the empty tree.
    const tree = await git(['write-tree'], { cwd: root, env: { GIT_INDEX_FILE: path.join(scratch, 'index') } });
    const commit = await git(['commit-tree', tree, '-m', message], { cwd: root });
    await git(['branch', '--force', STATE_BRANCH, commit], { cwd: root });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  await git(['worktree', 'add', '--quiet', stateDir(root), STATE_BRANCH], { cwd: root });
}

/** Attach the worktree to the existing remote state branch. */
export async function attachStateWorktree(root, remote, { timeout } = {}) {
  const dir = stateDir(root);
  await git(['fetch', '--quiet', remote, `+refs/heads/${STATE_BRANCH}:refs/remotes/${remote}/${STATE_BRANCH}`], {
    cwd: root,
    timeout,
  });
  await git(['worktree', 'add', '--quiet', '-B', STATE_BRANCH, dir, `${remote}/${STATE_BRANCH}`], { cwd: root });
  await git(['branch', '--quiet', `--set-upstream-to=${remote}/${STATE_BRANCH}`, STATE_BRANCH], { cwd: dir });
}

/** Throw away a local worktree (used when a concurrent creator won the race). */
export async function removeStateWorktree(root) {
  await git(['worktree', 'remove', '--force', stateDir(root)], { cwd: root }).catch(() => {});
  await rm(stateDir(root), { recursive: true, force: true });
  await git(['worktree', 'prune'], { cwd: root }).catch(() => {});
  await git(['branch', '-D', STATE_BRANCH], { cwd: root }).catch(() => {});
}

export async function pull(dir, remote, { timeout } = {}) {
  await git(['pull', '--quiet', '--rebase', remote, STATE_BRANCH], { cwd: dir, timeout });
}

/**
 * Stage `paths`, commit, and push, retrying `pull --rebase` + push with jittered
 * exponential backoff when another member pushed first.
 */
export async function commitAndPush(dir, remote, paths, message, { attempts = 6, baseDelayMs = 150, timeout } = {}) {
  if (paths.length) await git(['add', '--all', '--', ...paths], { cwd: dir });
  const staged = await git(['diff', '--cached', '--name-only'], { cwd: dir });
  if (staged) await git(['commit', '--quiet', '-m', message], { cwd: dir });

  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await git(['push', '--quiet', '-u', remote, `HEAD:refs/heads/${STATE_BRANCH}`], { cwd: dir, timeout });
      return;
    } catch (err) {
      lastErr = err;
      if (!/rejected|non-fast-forward|fetch first|failed to update ref|cannot lock ref/i.test(err.stderr ?? '')) throw err;
      await sleep(baseDelayMs * 2 ** i * (0.5 + Math.random()));
      await pull(dir, remote, { timeout });
    }
  }
  throw lastErr;
}

/** Push local state commits that an earlier push couldn't deliver (e.g. offline at session end). */
export async function pushPending(dir, remote, { timeout } = {}) {
  const ahead = await git(['rev-list', '--count', `${remote}/${STATE_BRANCH}..HEAD`], { cwd: dir }).catch(() => '0');
  if (Number(ahead) > 0) await commitAndPush(dir, remote, [], 'multiplayer: sync', { timeout });
}

export async function currentBranch(root) {
  return git(['branch', '--show-current'], { cwd: root }).catch(() => '');
}

export async function trackedFiles(root) {
  const out = await git(['ls-files'], { cwd: root }).catch(() => '');
  return out ? out.split('\n') : [];
}
