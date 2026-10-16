// Git plumbing for the shared state branch: an orphan branch checked out as a
// worktree inside the project. Every write is one-file-per-author (PLAN §2.2),
// so `pull --rebase` never conflicts; only the push can lose a race.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
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
    // windowsHide: on Windows a hook has no console of its own, so every git call
    // would otherwise flash a console window.
    const opts = { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) };
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

/**
 * Where a worktree's git data lives: { gitDir, commonDir, mainRoot }. Linked
 * worktrees (git worktree add, Orca, ...) share the main checkout's commonDir;
 * mainRoot is null for worktrees of a bare repository.
 */
export function gitLayout(root) {
  const dotgit = path.join(root, '.git');
  let gitDir = dotgit;
  try {
    if (!statSync(dotgit).isDirectory()) {
      const m = /gitdir:\s*(.+)/.exec(readFileSync(dotgit, 'utf8'));
      if (m) gitDir = path.resolve(root, m[1].trim());
    }
  } catch {
    return { gitDir, commonDir: gitDir, mainRoot: root };
  }
  const commondirFile = path.join(gitDir, 'commondir');
  const commonDir = existsSync(commondirFile)
    ? path.resolve(gitDir, readFileSync(commondirFile, 'utf8').trim())
    : gitDir;
  const mainRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
  return { gitDir, commonDir, mainRoot };
}

/**
 * The team-state worktree, shared by every worktree of this clone: the main
 * checkout's .multiplayer/, or inside the git directory for a bare repo.
 */
export function stateDir(root) {
  const { commonDir, mainRoot } = gitLayout(root);
  return mainRoot ? path.join(mainRoot, STATE_DIR) : path.join(commonDir, 'multiplayer', 'state');
}

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

// The team board (README.md, PLAN §2.10) is regenerated by whoever pushes, so
// it is the one file with many writers. Its commit is never rebased: unpushed
// board commits are dropped before pulling and a fresh one is made just before
// each push. board.mjs registers the writer (kept out of here to avoid an
// import cycle with the modules that read state).
const BOARD_MESSAGE = 'multiplayer: update team board';
const BOARD_FILE = 'README.md';
let boardWriter = null;

export function setBoardWriter(fn) {
  boardWriter = fn;
}

async function dropBoardCommits(dir, remote) {
  const log = await git(['log', '--format=%H %s', `${remote}/${STATE_BRANCH}..HEAD`], { cwd: dir }).catch(() => '');
  const shas = log
    .split('\n')
    .filter((l) => l.slice(41) === BOARD_MESSAGE)
    .map((l) => l.slice(0, 40)); // newest first
  // Later commits never touch README.md, so replaying them can't conflict.
  for (const sha of shas) await git(['rebase', '--quiet', '--onto', `${sha}^`, sha], { cwd: dir });
}

async function addBoardCommit(dir) {
  if (!boardWriter) return;
  try {
    if (!(await boardWriter(dir))) return;
    await git(['add', '--', BOARD_FILE], { cwd: dir });
    await git(['commit', '--quiet', '-m', BOARD_MESSAGE], { cwd: dir });
  } catch {
    // Never leave a half-written board behind: a dirty worktree would block the next pull.
    await git(['reset', '--quiet', '--', BOARD_FILE], { cwd: dir }).catch(() => {});
    await git(['checkout', '--quiet', '--', BOARD_FILE], { cwd: dir }).catch(() => rm(path.join(dir, BOARD_FILE), { force: true }));
  }
}

export async function pull(dir, remote, { timeout } = {}) {
  await dropBoardCommits(dir, remote);
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
    await addBoardCommit(dir);
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
