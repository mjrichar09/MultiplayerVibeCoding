// Starting and collecting parallel agents in their own worktrees (PLAN §2.9).
// `worktree` gives a new agent its own folder and branch; with `worker`, it's
// a worker under the current (lead) session, forked from the lead's commit.
// `collect` folds a worker's finished changes back into the lead's branch.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { activeClaims, claim, listClaims } from './claims.mjs';
import { git, gitLayout } from './git.mjs';
import { slugify } from './identity.mjs';
import { setWorker, workerRole } from './sessions.mjs';
import { openTeam } from './team.mjs';
import { currentBranchOrNull, defaultBranch, dirtyFiles, fetchDefault, revParse } from './workflow.mjs';

function uniquePath(p) {
  let out = p;
  for (let i = 2; existsSync(out); i++) out = `${p}-${i}`;
  return out;
}

async function uniqueBranch(root, name) {
  let out = name;
  for (let i = 2; await revParse(root, `refs/heads/${out}`); i++) out = `${name}-${i}`;
  return out;
}

/** Default home for a new worktree: next to the main checkout, named after the task. */
function defaultLocation(root, slug) {
  const { commonDir, mainRoot } = gitLayout(root);
  if (mainRoot) return path.join(path.dirname(mainRoot), `${path.basename(mainRoot)}-${slug}`);
  return path.join(path.dirname(commonDir), slug);
}

/**
 * Create a worktree + branch for another agent. Returns
 * { dir, branch, worker, claim, leadClaim, leadDirty, startCommand }.
 */
export async function createWorktree(team, { task, paths = [], worker = false, dir }) {
  if (await workerRole(team.root)) throw new Error('Workers do not start other agents; ask your lead.');
  const slug = slugify(task ?? '');
  if (!slug) throw new Error('A worktree needs a task (e.g. "Payments API").');
  const branch = await uniqueBranch(team.root, `${team.me.user}/${slug}`);
  const location = uniquePath(path.resolve(dir ?? defaultLocation(team.root, slug)));

  let startPoint;
  let leadDirty = [];
  if (worker) {
    // Workers fork from the lead's latest commit, so their work merges back cleanly.
    startPoint = 'HEAD';
    leadDirty = await dirtyFiles(team.root);
  } else {
    const base = await defaultBranch(team.root, team.remote, team.config);
    await fetchDefault(team.root, team.remote, base).catch(() => {});
    startPoint = (await revParse(team.root, `${team.remote}/${base}`)) ? `${team.remote}/${base}` : 'HEAD';
  }
  await git(['worktree', 'add', '--quiet', '--no-track', '-b', branch, location, startPoint], { cwd: team.root });

  let claimed = null;
  let leadClaim = null;
  if (worker) {
    const leadBranch = await currentBranchOrNull(team.root);
    await setWorker(location, { lead: team.me.user, task, paths, leadBranch, leadRoot: team.root });
    // The lead's claim must cover what its workers touch; extend it if needed.
    const mine = activeClaims(await listClaims(team.dir)).filter((c) => c.user === team.me.user);
    const onBranch = mine.find((c) => c.branch === leadBranch);
    if (onBranch && paths.length) {
      leadClaim = (await claim(team, { slug: onBranch.slug, paths })).claim;
    } else leadClaim = onBranch ?? null;
  } else {
    const there = await openTeam(location, { sync: false });
    claimed = (await claim(there, { task, paths, noBranch: true })).claim;
  }
  return {
    dir: location,
    branch,
    worker,
    claim: claimed,
    leadClaim,
    leadDirty,
    startCommand: `cd ${JSON.stringify(location)} && claude`,
  };
}

/** Find a worktree by folder or branch name. */
async function findWorktree(root, target) {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd: root });
  const entries = out.split('\n\n').map((block) => {
    const e = {};
    for (const line of block.split('\n')) {
      const [k, ...v] = line.split(' ');
      e[k] = v.join(' ');
    }
    return { dir: e.worktree, branch: e.branch?.replace(/^refs\/heads\//, '') };
  });
  const abs = path.resolve(target);
  return entries.find((e) => e.dir === abs || e.branch === target || path.basename(e.dir ?? '') === target) ?? null;
}

/**
 * Commit a worker worktree's changes, merge its branch into the lead's current
 * branch, then remove the worktree. Conflicts are left in progress for the lead.
 * Returns { status: 'merged' | 'conflict' | 'nothing', branch, dir, files }.
 */
export async function collectWorktree(team, target, { message } = {}) {
  const wt = await findWorktree(team.root, target);
  if (!wt?.dir || !wt.branch) throw new Error(`No worktree "${target}". See \`git worktree list\`.`);
  if (wt.dir === team.root) throw new Error("That's this session's own folder.");
  const leadDirty = await dirtyFiles(team.root);
  if (leadDirty.length) throw new Error(`Commit your own changes first (${leadDirty.join(', ')}).`);

  const role = await workerRole(wt.dir);
  const status = await git(['status', '--porcelain'], { cwd: wt.dir });
  if (status) {
    await git(['add', '--all'], { cwd: wt.dir });
    await git(['commit', '--quiet', '-m', message ?? `${role?.task ?? wt.branch}: worker changes`], { cwd: wt.dir });
  }
  const ahead = Number(await git(['rev-list', '--count', `HEAD..${wt.branch}`], { cwd: team.root }));
  if (ahead > 0) {
    try {
      await git(['merge', '--no-edit', '--quiet', wt.branch], { cwd: team.root });
    } catch {
      const files = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: team.root }).catch(() => ''))
        .split('\n')
        .filter(Boolean);
      return { status: 'conflict', branch: wt.branch, dir: wt.dir, files };
    }
  }
  await setWorker(wt.dir, null);
  await git(['worktree', 'remove', wt.dir], { cwd: team.root });
  await git(['branch', '-d', '--quiet', wt.branch], { cwd: team.root }).catch(() => {});
  return { status: ahead > 0 ? 'merged' : 'nothing', branch: wt.branch, dir: wt.dir, commits: ahead };
}
