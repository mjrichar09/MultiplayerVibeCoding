// Git autopilot for the project's own branches (PLAN §2.8): branch per task,
// merge-only updates, safe fast-forwards, and cleanup after a PR merges.
// Every automatic step either can't lose work or doesn't run.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';

export async function revParse(root, ref) {
  return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root }).catch(() => null);
}

const isAncestor = (root, a, b) =>
  git(['merge-base', '--is-ancestor', a, b], { cwd: root })
    .then(() => true)
    .catch(() => false);

/** The remote's default branch: config override, then origin/HEAD, then main/master. */
export async function defaultBranch(root, remote, config = {}) {
  if (config.defaultBranch) return config.defaultBranch;
  const head = await git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`], { cwd: root }).catch(
    () => '',
  );
  if (head) return head.slice(remote.length + 1);
  for (const name of ['main', 'master', 'trunk', 'develop']) {
    if (await revParse(root, `refs/remotes/${remote}/${name}`)) return name;
  }
  return 'main';
}

export async function fetchDefault(root, remote, branch, { timeout } = {}) {
  await git(['fetch', '--quiet', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`], {
    cwd: root,
    timeout,
  });
}

/** Tracked files with uncommitted changes (untracked files don't block a merge). */
export async function dirtyFiles(root) {
  const out = await git(['status', '--porcelain', '--untracked-files=no'], { cwd: root });
  return out ? out.split('\n').map((l) => l.slice(3)) : [];
}

export async function operationInProgress(root) {
  const gitDir = path.resolve(root, await git(['rev-parse', '--git-dir'], { cwd: root }));
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].some((f) =>
    existsSync(path.join(gitDir, f)),
  );
}

export async function currentBranchOrNull(root) {
  return (await git(['branch', '--show-current'], { cwd: root }).catch(() => '')) || null;
}

/**
 * Move local `branch` up to the remote's tip if that loses nothing: only when
 * it's an ancestor, and (if checked out) only via `merge --ff-only`.
 * Returns 'updated' | 'up-to-date' | 'skipped'.
 */
export async function fastForwardLocal(root, remote, branch) {
  const local = await revParse(root, `refs/heads/${branch}`);
  const upstream = await revParse(root, `refs/remotes/${remote}/${branch}`);
  if (!local || !upstream) return 'skipped';
  if (local === upstream) return 'up-to-date';
  if (!(await isAncestor(root, local, upstream))) return 'skipped'; // local has its own commits
  if ((await currentBranchOrNull(root)) === branch) {
    if (await operationInProgress(root)) return 'skipped';
    try {
      await git(['merge', '--ff-only', '--quiet', `${remote}/${branch}`], { cwd: root });
      return 'updated';
    } catch {
      return 'skipped'; // e.g. an uncommitted change would be overwritten
    }
  }
  await git(['update-ref', `refs/heads/${branch}`, upstream, local], { cwd: root });
  return 'updated';
}

async function conflictedFiles(root) {
  const out = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: root }).catch(() => '');
  return out ? out.split('\n') : [];
}

/**
 * Merge the remote default branch into the current task branch.
 * onConflict: 'abort' (leave everything as it was) or 'leave' (merge in
 * progress, for the agent to resolve).
 * Returns { status: 'merged'|'up-to-date'|'conflict'|'dirty'|'skipped', behind, files, reason }.
 */
export async function mergeDefault(root, remote, base, { onConflict = 'abort' } = {}) {
  const branch = await currentBranchOrNull(root);
  if (!branch || branch === base) return { status: 'skipped', reason: 'not on a task branch' };
  if (await operationInProgress(root)) return { status: 'skipped', reason: 'a merge or rebase is already in progress' };
  const upstream = `${remote}/${base}`;
  if (!(await revParse(root, upstream))) return { status: 'skipped', reason: `${upstream} not found` };
  const behind = Number(await git(['rev-list', '--count', `HEAD..${upstream}`], { cwd: root }));
  if (behind === 0) return { status: 'up-to-date', behind };
  const dirty = await dirtyFiles(root);
  if (dirty.length) return { status: 'dirty', behind, files: dirty };
  try {
    await git(['merge', '--no-edit', '--quiet', upstream], { cwd: root });
    return { status: 'merged', behind };
  } catch (err) {
    const files = await conflictedFiles(root);
    if (onConflict === 'abort' || files.length === 0) {
      await git(['merge', '--abort'], { cwd: root }).catch(() => {});
      return files.length
        ? { status: 'conflict', behind, files }
        : { status: 'skipped', behind, reason: err.stderr?.trim().split('\n')[0] ?? 'merge failed' };
    }
    return { status: 'conflict', behind, files, inProgress: true };
  }
}

/** Files changed on the remote default branch since this branch last took it in. */
export async function incomingFiles(root, remote, base) {
  const upstream = `${remote}/${base}`;
  const mergeBase = await git(['merge-base', 'HEAD', upstream], { cwd: root }).catch(() => '');
  if (!mergeBase) return { tip: null, files: [] };
  const tip = await revParse(root, upstream);
  if (tip === mergeBase) return { tip, files: [] };
  const out = await git(['diff', '--name-only', mergeBase, upstream], { cwd: root }).catch(() => '');
  return { tip, files: out ? out.split('\n') : [] };
}

/**
 * Put new work on a task branch. On the default branch (or detached), create
 * `name` from the freshest base available, carrying uncommitted changes.
 * Returns { branch, created }.
 */
export async function startTaskBranch(root, remote, base, name, { timeout } = {}) {
  const current = await currentBranchOrNull(root);
  if (current && current !== base) return { branch: current, created: false };
  await fetchDefault(root, remote, base, { timeout }).catch(() => {});
  if (current === base) await fastForwardLocal(root, remote, base);

  let branch = name;
  for (let i = 2; await revParse(root, `refs/heads/${branch}`); i++) branch = `${name}-${i}`;
  const upstream = `${remote}/${base}`;
  const clean = (await dirtyFiles(root)).length === 0;
  const fresh = clean && (await revParse(root, upstream));
  // --no-track: the branch's upstream is set when it's first pushed, not to main.
  await git(['switch', '--quiet', '--no-track', '-c', branch, ...(fresh ? [upstream] : [])], { cwd: root });
  return { branch, created: true };
}

/**
 * After `branch` merged as PR head `headOid`: if it's checked out with no
 * uncommitted changes and its tip is part of what merged, switch to the default
 * branch, fast-forward it, and delete the task branch.
 * Returns { status: 'cleaned' | 'kept', reason }.
 */
export async function cleanupMergedBranch(root, remote, base, branch, headOid, { timeout } = {}) {
  if ((await currentBranchOrNull(root)) !== branch) return { status: 'kept', reason: 'not checked out' };
  if ((await dirtyFiles(root)).length) return { status: 'kept', reason: 'uncommitted changes' };
  if (await operationInProgress(root)) return { status: 'kept', reason: 'operation in progress' };
  const tip = await revParse(root, 'HEAD');
  if (!headOid || !(await isAncestor(root, tip, headOid).catch(() => false))) {
    return { status: 'kept', reason: 'it has commits that were not part of the merged PR' };
  }
  await fetchDefault(root, remote, base, { timeout }).catch(() => {});
  if (await revParse(root, `refs/heads/${base}`)) await git(['switch', '--quiet', base], { cwd: root });
  else await git(['switch', '--quiet', '--track', '-c', base, `${remote}/${base}`], { cwd: root });
  await fastForwardLocal(root, remote, base);
  await git(['branch', '-D', '--quiet', branch], { cwd: root });
  return { status: 'cleaned' };
}
