// Optional GitHub access through the gh CLI's REST API (`gh api repos/…`).
// REST works everywhere gh does, including Claude Code cloud sessions, which
// block the GraphQL API that `gh pr …` commands use. Every call degrades to
// null when gh is missing, signed out, slow, or the repo isn't on GitHub.
// MULTIPLAYER_GH overrides the binary (tests point it at a fake);
// MULTIPLAYER_GITHUB_REPO (owner/repo) overrides the repo read from the remote.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultRemote, git, localDir } from './git.mjs';

export const GH_CACHE_TTL_MS = 5 * 60 * 1000;
const OPEN_PRS_WITH_FILES = 30; // most recently updated open PRs whose files we fetch

export function gh(args, { cwd, env = process.env, timeout = 4_000 } = {}) {
  return new Promise((resolve) => {
    execFile(env.MULTIPLAYER_GH || 'gh', args, { cwd, env, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** owner/repo parsed from a GitHub remote URL (https or ssh), or null. */
export function parseGithubRepo(url) {
  return /github\.com[/:]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url ?? '')?.[1] ?? null;
}

/** The GitHub repository (owner/repo) for the repo at `root`, or null. */
export async function githubRepo(root, { env = process.env } = {}) {
  if (env.MULTIPLAYER_GITHUB_REPO) return env.MULTIPLAYER_GITHUB_REPO;
  const remote = await defaultRemote(root).catch(() => null);
  if (!remote) return null;
  const url = await git(['remote', 'get-url', remote], { cwd: root }).catch(() => '');
  return parseGithubRepo(url);
}

const api = (root, endpoint, env, timeout) => gh(['api', endpoint], { cwd: root, env, timeout });

/** REST pull request → the shape the rest of the plugin uses. */
function toPr(p) {
  return {
    number: p.number,
    title: p.title,
    headRefName: p.head?.ref,
    headRefOid: p.head?.sha,
    headRepo: p.head?.repo?.full_name ?? null,
    author: { login: p.user?.login },
    mergedAt: p.merged_at ?? null,
    state: p.merged_at ? 'MERGED' : String(p.state ?? '').toUpperCase(),
    isDraft: Boolean(p.draft),
    url: p.html_url,
    mergeCommit: p.merge_commit_sha ? { oid: p.merge_commit_sha } : null,
    updatedAt: p.updated_at,
  };
}

async function cacheFile(root) {
  return path.join(await localDir(root), 'gh-cache.json');
}

/** Read cached PR lists without touching the network (for fast hooks). */
export async function readPrCache(root) {
  try {
    const file = await cacheFile(root);
    return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : null;
  } catch {
    return null;
  }
}

/**
 * Recently merged and open PRs (open ones with their changed files), cached for
 * GH_CACHE_TTL_MS (MULTIPLAYER_GH_TTL_MS overrides). Returns
 * { fetchedAt, merged: [...], open: [...] } or null if GitHub is unavailable.
 */
export async function prs(root, { env = process.env, refresh = false } = {}) {
  const ttl = env.MULTIPLAYER_GH_TTL_MS !== undefined ? Number(env.MULTIPLAYER_GH_TTL_MS) : GH_CACHE_TTL_MS;
  const cached = await readPrCache(root);
  if (!refresh && cached && Date.now() - cached.fetchedAt < ttl) return cached;
  const repo = await githubRepo(root, { env });
  if (!repo) return cached ?? null;

  const [closed, open] = await Promise.all([
    api(root, `repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, env),
    api(root, `repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100`, env),
  ]);
  if (!Array.isArray(closed) && !Array.isArray(open)) return cached ?? null;

  // Changed files, one call per open PR; reuse the cached list while the PR's head hasn't moved.
  const known = new Map((cached?.open ?? []).filter((p) => p.files).map((p) => [`${p.number}@${p.headRefOid}`, p.files]));
  const openPrs = (Array.isArray(open) ? open : []).map(toPr);
  await Promise.all(
    openPrs.slice(0, OPEN_PRS_WITH_FILES).map(async (p) => {
      const reuse = known.get(`${p.number}@${p.headRefOid}`);
      if (reuse) p.files = reuse;
      else {
        const files = await api(root, `repos/${repo}/pulls/${p.number}/files?per_page=100`, env);
        if (Array.isArray(files)) p.files = files.map((f) => ({ path: f.filename }));
      }
    }),
  );

  const fresh = {
    fetchedAt: Date.now(),
    repo,
    merged: (Array.isArray(closed) ? closed : []).filter((p) => p.merged_at).map(toPr),
    open: openPrs,
  };
  await writeFile(await cacheFile(root), JSON.stringify(fresh)).catch(() => {});
  return fresh;
}

/** The GitHub login gh is authenticated as, or null. */
export async function githubLogin(root, { env = process.env } = {}) {
  const me = await gh(['api', 'user'], { cwd: root, env });
  return typeof me?.login === 'string' ? me.login : null;
}

/**
 * One PR's current state, bypassing the cache. `ref` is a number, a PR URL, a
 * branch name, or empty for the current branch. `repo` (owner/repo) overrides
 * the repository. Returns { number, state, headRefName, headRefOid, title,
 * url, mergeCommit } or null.
 */
export async function prView(root, ref, { repo, env = process.env } = {}) {
  const nwo = repo || (await githubRepo(root, { env }));
  if (!nwo) return null;
  const text = String(ref ?? '').trim();
  const number = /^#?(\d+)$/.exec(text)?.[1] ?? /\/pull\/(\d+)/.exec(text)?.[1];
  if (number) {
    const p = await api(root, `repos/${nwo}/pulls/${number}`, env);
    return p?.number ? toPr(p) : null;
  }
  const branch = text || (await git(['branch', '--show-current'], { cwd: root }).catch(() => ''));
  if (!branch) return null;
  const owner = nwo.split('/')[0];
  const list = await api(root, `repos/${nwo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=5`, env);
  return Array.isArray(list) && list.length ? toPr(list[0]) : null;
}

/** REST check-run/status → pass | fail | pending | skipping | cancel. */
function runBucket(run) {
  if (run.status && run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
      return 'pass';
    case 'skipped':
      return 'skipping';
    case 'cancelled':
      return 'cancel';
    default:
      return 'fail';
  }
}

const statusBucket = (s) => ({ success: 'pass', pending: 'pending' })[s.state] ?? 'fail';

/**
 * A PR's checks: [{ name, bucket }] where bucket is pass | fail | pending |
 * skipping | cancel; [] if it has none; null if GitHub is unavailable.
 */
export async function prChecks(root, ref, { repo, env = process.env } = {}) {
  const pr = await prView(root, ref, { repo, env });
  if (!pr?.headRefOid) return null;
  const nwo = repo || (await githubRepo(root, { env }));
  const [runs, status] = await Promise.all([
    api(root, `repos/${nwo}/commits/${pr.headRefOid}/check-runs?per_page=100`, env),
    api(root, `repos/${nwo}/commits/${pr.headRefOid}/status`, env),
  ]);
  if (!runs && !status) return null;
  return [
    ...(runs?.check_runs ?? []).map((r) => ({ name: r.name, bucket: runBucket(r) })),
    ...(status?.statuses ?? []).map((s) => ({ name: s.context, bucket: statusBucket(s) })),
  ];
}
