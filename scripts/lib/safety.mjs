// Safety nets around merging (PLAN §2.8): GitHub branch protection that
// requires checks to pass, and a clean way to undo a merged PR.

import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claim } from './claims.mjs';
import { git } from './git.mjs';
import { slugify } from './identity.mjs';
import { defaultBranch, dirtyFiles, fetchDefault, revParse } from './workflow.mjs';

/** Run gh and keep its output and errors (for messages the user can act on). */
function ghRun(args, { cwd, env = process.env, timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(env.MULTIPLAYER_GH || 'gh', args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        // not JSON
      }
      resolve({ ok: !err, json, stderr: (stderr || err?.message || '').trim() });
    });
  });
}

const NEED_GH = 'This needs the GitHub CLI (gh), signed in with access to the repository.';

/**
 * Require checks to pass before anything merges into the default branch, and
 * forbid force-pushes and deletion. Needs repo admin rights. `checks` defaults
 * to every check that has run on the default branch's latest commit.
 * Returns { repo, branch, checks }.
 */
export async function protectDefaultBranch(team, { checks } = {}) {
  const { root, env } = team;
  const base = await defaultBranch(root, team.remote, team.config);
  const repo = await ghRun(['repo', 'view', '--json', 'nameWithOwner,viewerPermission'], { cwd: root, env });
  if (!repo.json?.nameWithOwner) throw new Error(`${NEED_GH} ${repo.stderr}`.trim());
  const nwo = repo.json.nameWithOwner;
  if (repo.json.viewerPermission !== 'ADMIN') {
    throw new Error(
      `Only a repository admin can turn on branch protection for ${nwo}. Ask an admin to run \`multiplayer protect\`, ` +
        `or in GitHub: Settings → Branches → add a rule for ${base} with "Require status checks to pass before merging".`,
    );
  }

  let required = checks?.length ? checks : null;
  if (!required) {
    const runs = await ghRun(['api', `repos/${nwo}/commits/${base}/check-runs?per_page=100`], { cwd: root, env });
    const statuses = await ghRun(['api', `repos/${nwo}/commits/${base}/status`], { cwd: root, env });
    required = [
      ...new Set([
        ...(runs.json?.check_runs ?? []).map((r) => r.name),
        ...(statuses.json?.statuses ?? []).map((s) => s.context),
      ]),
    ].sort();
  }
  if (!required.length) {
    throw new Error(
      `No checks have run on ${base} yet, so there's nothing to require. Add CI that runs your tests on pull requests ` +
        '(for example a GitHub Actions workflow), let it run once on the default branch, then run protect again.',
    );
  }

  const body = {
    required_status_checks: { strict: false, contexts: required },
    enforce_admins: false,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
  const dir = await mkdtemp(path.join(tmpdir(), 'multiplayer-protect-'));
  try {
    const file = path.join(dir, 'body.json');
    await writeFile(file, JSON.stringify(body));
    const r = await ghRun(['api', '-X', 'PUT', `repos/${nwo}/branches/${base}/protection`, '--input', file], { cwd: root, env });
    if (!r.ok) {
      const plan = /upgrade|not available|Pro/i.test(r.stderr)
        ? ' Branch protection on private repositories needs a paid GitHub plan (Pro, Team, or Enterprise).'
        : '';
      throw new Error(`GitHub refused the branch protection change: ${r.stderr}${plan}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { repo: nwo, branch: base, checks: required };
}

/**
 * Undo a merged PR (number) or commit (sha) on a fresh branch from the latest
 * default branch, claiming the files it touches. Conflicts are left for the agent.
 * Returns { status: 'reverted' | 'conflict', branch, sha, title, files, pr }.
 */
export async function revertChange(team, ref) {
  const { root, remote, env, me } = team;
  const dirty = await dirtyFiles(root);
  if (dirty.length) throw new Error(`Commit your current work first (${dirty.join(', ')}).`);
  const base = await defaultBranch(root, remote, team.config);
  await fetchDefault(root, remote, base).catch(() => {});

  let sha;
  let title;
  let pr = null;
  const number = /^#?(\d+)$/.exec(String(ref ?? '').trim())?.[1];
  if (number) {
    const view = await ghRun(['pr', 'view', number, '--json', 'number,title,state,mergeCommit'], { cwd: root, env });
    if (!view.json) throw new Error(`Couldn't look up PR #${number}. ${NEED_GH} Or pass the merge commit's id instead.`);
    if (view.json.state !== 'MERGED' || !view.json.mergeCommit?.oid) throw new Error(`PR #${number} isn't merged, so there's nothing to revert.`);
    ({ oid: sha } = view.json.mergeCommit);
    title = view.json.title;
    pr = Number(number);
  } else {
    sha = await revParse(root, ref);
    if (!sha) throw new Error(`"${ref}" is neither a PR number nor a commit in this repository.`);
    title = await git(['log', '-1', '--format=%s', sha], { cwd: root });
  }
  if (!(await revParse(root, sha))) throw new Error(`Commit ${sha.slice(0, 10)} isn't available locally; fetch and try again.`);
  if (!(await git(['merge-base', '--is-ancestor', sha, `${remote}/${base}`], { cwd: root }).then(() => true, () => false))) {
    throw new Error(`${sha.slice(0, 10)} isn't on ${base}, so there's nothing on ${base} to revert.`);
  }

  const parents = (await git(['rev-list', '--parents', '-n', '1', sha], { cwd: root })).split(' ').length - 1;
  const files = (await git(['diff', '--name-only', `${sha}^1`, sha], { cwd: root })).split('\n').filter(Boolean);

  const label = pr ? `pr-${pr}` : sha.slice(0, 7);
  let branch = `${me.user}/revert-${label}`;
  for (let i = 2; await revParse(root, `refs/heads/${branch}`); i++) branch = `${me.user}/revert-${label}-${i}`;
  await git(['switch', '--quiet', '--no-track', '-c', branch, `${remote}/${base}`], { cwd: root });
  await claim(team, {
    task: `Revert ${pr ? `#${pr}` : sha.slice(0, 7)}: ${title}`,
    slug: slugify(`revert-${label}`),
    paths: files.length ? files : ['.'],
    noBranch: true,
  });

  try {
    await git(['revert', '--no-edit', ...(parents > 1 ? ['-m', '1'] : []), sha], { cwd: root });
  } catch {
    const conflicts = (await git(['diff', '--name-only', '--diff-filter=U'], { cwd: root }).catch(() => ''))
      .split('\n')
      .filter(Boolean);
    return { status: 'conflict', branch, sha, title, files: conflicts, pr };
  }
  return { status: 'reverted', branch, sha, title, files, pr };
}
