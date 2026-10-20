// Claims: who is working on what (PLAN §4). One file per claim, written only
// by its owner: claims/<user>--<slug>.md. A takeover never touches the stale
// claim; it creates the new owner's claim with `supersedes:` (PLAN §2.6).

import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAndPush, currentBranch, trackedFiles } from './git.mjs';
import { defaultBranch, startTaskBranch } from './workflow.mjs';
import { readPrCache } from './gh.mjs';
import { matchesAny, normalizePattern, patternsOverlap } from './glob.mjs';
import { slugify } from './identity.mjs';
import { formatFrontmatter, parseFrontmatter } from './state.mjs';
import { DAY_MS, cloneId, deviceLabel, isCloudSession, now } from './util.mjs';
import { localDir } from './git.mjs';

export const claimId = (user, slug) => `${user}--${slug}`;
const claimRel = (id) => path.posix.join('claims', `${id}.md`);
const historyRel = (user) => path.posix.join('history', `${user}.md`);

export async function listClaims(dir) {
  const claimsDir = path.join(dir, 'claims');
  if (!existsSync(claimsDir)) return [];
  const claims = [];
  for (const f of (await readdir(claimsDir)).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { data, body } = parseFrontmatter(await readFile(path.join(claimsDir, f), 'utf8'));
      claims.push({ ...data, paths: data.paths ?? [], id: f.slice(0, -3), notes: body.trim() });
    } catch {
      // Ignore unreadable claim files rather than failing every reader.
    }
  }
  return claims;
}

/** Claims not superseded by a takeover. */
export function activeClaims(claims) {
  const superseded = new Set(claims.map((c) => c.supersedes).filter(Boolean));
  return claims.filter((c) => !superseded.has(c.id));
}

export const supersededBy = (claims, id) => claims.find((c) => c.supersedes === id);

export function isStale(claim, config, at = now()) {
  return at - new Date(claim.updated ?? claim.started) > (config.staleClaimDays ?? 3) * DAY_MS;
}

/** A merged PR for this claim's branch, merged after the claim started. */
export function mergedPr(claim, prCache) {
  if (!claim.branch || !prCache?.merged) return null;
  return (
    prCache.merged.find(
      (pr) => pr.headRefName === claim.branch && (!pr.mergedAt || new Date(pr.mergedAt) >= new Date(claim.started)),
    ) ?? null
  );
}

export const covers = (claim, file) => matchesAny(claim.paths, file);

/**
 * Who an open PR belongs to: the member with a claim on its branch, else the
 * member named by a `<user>/…` branch, else the member with that GitHub login,
 * else `@login`.
 */
export function prOwner(pr, { claims = [], members = [] }) {
  const byClaim = claims.find((c) => c.branch && c.branch === pr.headRefName);
  if (byClaim) return byClaim.user;
  const prefix = pr.headRefName?.split('/')[0];
  if (prefix && members.some((m) => m.user === prefix)) return prefix;
  const login = pr.author?.login?.toLowerCase();
  const member = login && members.find((m) => m.github?.toLowerCase() === login);
  if (member) return member.user;
  return login ? `@${login}` : 'someone';
}

/** Teammates' open PRs that change files matching `patterns`. Returns [{ pr, owner, files }]. */
export function prOverlaps(patterns, { prCache, claims, members, me }) {
  const out = [];
  for (const pr of prCache?.open ?? []) {
    const owner = prOwner(pr, { claims, members });
    if (owner === me) continue;
    const files = (pr.files ?? []).map((f) => f.path ?? f).filter((f) => matchesAny(patterns, f));
    if (files.length) out.push({ pr, owner, files });
  }
  return out;
}

async function writeClaim(dir, claim) {
  const { id, notes, ...data } = claim;
  const file = path.join(dir, claimRel(id));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, formatFrontmatter(data, notes));
}

/** Teammates' active claims whose paths overlap `paths`. */
export async function findOverlaps(team, paths, { claims, prCache, excludeIds = [] } = {}) {
  const all = claims ?? (await listClaims(team.dir));
  const files = await trackedFiles(team.root);
  const out = [];
  for (const c of activeClaims(all)) {
    if (c.user === team.me.user || excludeIds.includes(c.id) || mergedPr(c, prCache)) continue;
    const hits = c.paths.filter((theirs) => paths.some((mine) => patternsOverlap(mine, theirs, files)));
    if (hits.length) out.push({ claim: c, paths: hits });
  }
  const prs = prOverlaps(paths, { prCache, claims: all, members: team.members, me: team.me.user });
  return Object.assign(out, { prs });
}

/**
 * Create or update my claim. Options: task, paths, issue, keep, slug, notes,
 * takeover (id of a stale teammate claim to supersede), noBranch (don't start
 * a task branch, PLAN §2.8), handoff (a handoff addressed to me: supersede its
 * claim without the staleness check and continue on its branch).
 */
export async function claim(team, opts) {
  const { dir, me, config } = team;
  const at = now(team.env).toISOString();
  const all = await listClaims(dir);
  let base = {};
  let supersedes;

  if (opts.takeover) {
    const target = all.find((c) => c.id === opts.takeover);
    if (!target) throw new Error(`No claim "${opts.takeover}" to take over.`);
    if (target.user === me.user) throw new Error('That claim is already yours.');
    if (supersededBy(all, target.id)) throw new Error(`"${target.id}" was already taken over.`);
    const handedToMe = opts.handoff?.claim === target.id && opts.handoff.to?.includes(me.user);
    if (!handedToMe && !isStale(target, config, now(team.env))) {
      throw new Error(
        `${target.user}'s claim "${target.slug}" isn't stale yet (stale after ${config.staleClaimDays} days without activity). Ask ${target.user} instead.`,
      );
    }
    base = { task: target.task, paths: target.paths, issue: target.issue };
    supersedes = target.id;
  }

  const task = opts.task ?? base.task;
  const slug = slugify(opts.slug || (opts.takeover ? all.find((c) => c.id === opts.takeover).slug : task) || '');
  if (!slug) throw new Error('A claim needs a task (or slug).');
  const id = claimId(me.user, slug);
  const existing = all.find((c) => c.id === id);
  if (existing && supersedes) throw new Error(`You already have a claim "${slug}"; pass --slug to name the takeover.`);

  const paths = [...new Set([...(existing?.paths ?? []), ...(base.paths ?? []), ...(opts.paths ?? [])].map(normalizePattern))];
  if (paths.length === 0) throw new Error('A claim needs at least one path or glob (e.g. src/checkout/**).');

  // A new task gets its own branch from the latest default branch (PLAN §2.8).
  let branch = existing?.branch;
  let branchCreated = false;
  if (!existing) {
    if (opts.handoff?.branch) branch = opts.handoff.branch;
    // Cloud sessions are assigned their branch by the environment; work on it.
    else if (opts.noBranch || config.autoBranch === false || isCloudSession(team.env)) branch = await currentBranch(team.root);
    else {
      const baseBranch = await defaultBranch(team.root, team.remote, config);
      const started = await startTaskBranch(team.root, team.remote, baseBranch, `${me.user}/${slug}`);
      ({ branch } = started);
      branchCreated = started.created;
    }
  } else {
    // Claimed on the default branch, then moved to a task branch: follow it, so
    // the claim releases when that branch's PR merges.
    const base = await defaultBranch(team.root, team.remote, config);
    const here = await currentBranch(team.root);
    if ((!branch || branch === base) && here && here !== base) branch = here;
  }

  const next = {
    id,
    user: me.user,
    slug,
    task: task ?? existing?.task ?? slug,
    paths,
    branch,
    issue: opts.issue ?? existing?.issue ?? base.issue ?? null,
    keep: opts.keep ?? existing?.keep ?? false,
    supersedes: supersedes ?? existing?.supersedes,
    handoff: opts.handoff?.id ?? existing?.handoff,
    started: existing?.started ?? at,
    updated: at,
    device: deviceLabel(team.env),
    clone: cloneId(await localDir(team.root)),
    leftOff: existing?.leftOff,
    notes: [existing?.notes, opts.notes].filter(Boolean).join('\n\n'),
  };
  await writeClaim(dir, next);
  const verb = existing ? 'update' : supersedes ? `take over ${supersedes}` : 'claim';
  await commitAndPush(dir, team.remote, [claimRel(id)], `multiplayer: ${me.user} ${verb} ${slug}`);

  const overlaps = await findOverlaps(team, paths, {
    excludeIds: supersedes ? [supersedes] : [],
    prCache: await readPrCache(team.root),
  });
  return { claim: next, status: existing ? 'updated' : supersedes ? 'took-over' : 'created', overlaps, branchCreated };
}

/** Release my claims by id, logging an outcome line per claim to history/<me>.md. One commit. */
export async function release(team, items) {
  const { dir, me } = team;
  if (items.length === 0) return [];
  const day = now(team.env).toISOString().slice(0, 10);
  const historyFile = path.join(dir, historyRel(me.user));
  await mkdir(path.dirname(historyFile), { recursive: true });
  if (!existsSync(historyFile)) await writeFile(historyFile, `# ${me.user}: released claims\n\n`);
  for (const { claim: c, outcome } of items) {
    if (c.user !== me.user) throw new Error(`"${c.id}" belongs to ${c.user}; only its owner can release it.`);
    await rm(path.join(dir, claimRel(c.id)), { force: true });
    await appendFile(historyFile, `- ${day} · **${c.slug}** — ${c.task}${outcome ? ` — ${outcome}` : ''}\n`);
  }
  const rels = [...items.map(({ claim: c }) => claimRel(c.id)), historyRel(me.user)];
  const names = items.map(({ claim: c }) => c.slug).join(', ');
  await commitAndPush(dir, team.remote, rels, `multiplayer: ${me.user} release ${names}`);
  return items.map(({ claim: c }) => c);
}

/** Record "where I left off" on my active claims for `branch`. Returns the updated claims. */
export async function snapshot(team, { branch, leftOff }) {
  const { dir, me } = team;
  const mine = activeClaims(await listClaims(team.dir)).filter((c) => c.user === me.user && c.branch === branch);
  if (mine.length === 0) return [];
  const at = now(team.env).toISOString();
  for (const c of mine) await writeClaim(dir, { ...c, updated: at, leftOff: { at, ...leftOff } });
  await commitAndPush(dir, team.remote, mine.map((c) => claimRel(c.id)), `multiplayer: ${me.user} snapshot`, {
    timeout: team.timeout,
  });
  return mine;
}
