// Optional GitHub CLI access. Every call degrades to null when `gh` is
// missing, unauthenticated, slow, or the remote isn't on GitHub.
// MULTIPLAYER_GH overrides the binary (tests point it at a fake).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { localDir } from './git.mjs';

export const GH_CACHE_TTL_MS = 5 * 60 * 1000;

export function gh(args, { cwd, env = process.env, timeout = 2_500 } = {}) {
  return new Promise((resolve) => {
    execFile(env.MULTIPLAYER_GH || 'gh', args, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
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
 * Recently merged and open PRs, cached for GH_CACHE_TTL_MS (MULTIPLAYER_GH_TTL_MS
 * overrides). Returns { merged: [...], open: [...] } or null if gh is unavailable.
 */
export async function prs(root, { env = process.env, refresh = false } = {}) {
  const ttl = env.MULTIPLAYER_GH_TTL_MS !== undefined ? Number(env.MULTIPLAYER_GH_TTL_MS) : GH_CACHE_TTL_MS;
  const cached = await readPrCache(root);
  if (!refresh && cached && Date.now() - cached.fetchedAt < ttl) return cached;

  const fields = 'number,headRefName,headRefOid,author,mergedAt,url';
  const [merged, open] = await Promise.all([
    gh(['pr', 'list', '--state', 'merged', '--limit', '50', '--json', fields], { cwd: root, env }),
    gh(['pr', 'list', '--state', 'open', '--limit', '100', '--json', fields], { cwd: root, env }),
  ]);
  if (!merged && !open) return cached ?? null;
  const fresh = { fetchedAt: Date.now(), merged: merged ?? [], open: open ?? [] };
  await writeFile(await cacheFile(root), JSON.stringify(fresh)).catch(() => {});
  return fresh;
}

/** One PR's current state, bypassing the cache. `ref` is a number, URL, or branch. */
export function prView(root, ref, { repo, env = process.env } = {}) {
  const args = ['pr', 'view', ...(ref ? [String(ref)] : []), '--json', 'number,state,headRefName,headRefOid,url'];
  if (repo) args.push('--repo', repo);
  return gh(args, { cwd: root, env });
}
