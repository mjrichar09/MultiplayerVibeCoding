// Hook handlers. Each returns a hook output object or null. The CLI wrapper
// makes every handler fail open (PLAN §2.5).

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBriefing } from './briefing.mjs';
import { activeClaims, covers, isStale, listClaims, mergedPr, release, snapshot, supersededBy } from './claims.mjs';
import { STATE_DIR, currentBranch, git, isAttached, localDir, remoteHasStateBranch, stateDir } from './git.mjs';
import { prView, prs, readPrCache } from './gh.mjs';
import { identity } from './identity.mjs';
import { InitError, init, locate } from './init.mjs';
import { readConfig } from './state.mjs';
import { openTeam } from './team.mjs';
import { ago, now } from './util.mjs';

// Network operations in hooks get a hard per-call timeout so a slow remote
// can't stall the session.
export const HOOK_NET_TIMEOUT_MS = 3_000;

const output = (event, context, userMessage) => ({
  ...(userMessage ? { systemMessage: userMessage } : {}),
  hookSpecificOutput: { hookEventName: event, additionalContext: context },
});

// Per-member, never-shared state inside the worktree (.local/ is gitignored there).
async function readLocal(root, name, fallback) {
  try {
    return JSON.parse(await readFile(path.join(stateDir(root), '.local', name), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeLocal(root, name, data) {
  const file = path.join(stateDir(root), '.local', name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

async function locateOrNull(input, env) {
  try {
    return await locate(input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd());
  } catch (err) {
    if (err instanceof InitError) return null; // not a repo / no remote: nothing to coordinate
    throw err;
  }
}

// ---------------------------------------------------------------- SessionStart

export async function sessionStart(input, { env = process.env } = {}) {
  const located = await locateOrNull(input, env);
  if (!located) return null;
  const { root, remote } = located;
  const timeout = HOOK_NET_TIMEOUT_MS;

  // Opt-in per repo: never create the shared branch unasked (PLAN §2.7).
  if (!isAttached(root) && !(await remoteHasStateBranch(root, remote, { timeout }))) {
    const marker = path.join(await localDir(root), 'setup-offered');
    if (existsSync(marker)) return null;
    await writeFile(marker, `${new Date().toISOString()}\n`);
    return output(
      'SessionStart',
      'multiplayer: this repository is not set up for team coordination. ' +
        'Only if the user asks to set it up, use the multiplayer:init skill. Do not set it up unasked.',
    );
  }

  const joined = await init({ cwd: root, env, timeout });
  const team = await openTeam(root, { env, sync: false });
  const prCache = await prs(root, { env });
  const at = now(env);
  const events = [];
  const notices = [];
  if (joined.status === 'joined') notices.push(`joined team as ${team.me.user} (${team.members.length} members)`);

  // Auto-release (PLAN §2.7): my claims whose PR merged, or that a teammate took over.
  let claims = await listClaims(team.dir);
  const toRelease = [];
  for (const c of claims.filter((c) => c.user === team.me.user)) {
    const taker = supersededBy(claims, c.id);
    const pr = mergedPr(c, prCache);
    if (taker) toRelease.push({ claim: c, outcome: `taken over by ${taker.user}`, event: `${taker.user} took over your stale claim "${c.slug}".` });
    else if (pr && !c.keep) toRelease.push({ claim: c, outcome: `merged in #${pr.number}`, event: `released your claim "${c.slug}" (PR #${pr.number} merged).` });
  }
  if (toRelease.length) {
    try {
      await release({ ...team, timeout }, toRelease);
    } catch {
      // Committed locally; the push is retried at the next session start.
    }
    claims = await listClaims(team.dir);
    for (const r of toRelease) {
      events.push(r.event);
      notices.push(r.event);
    }
  }

  const lastSeen = await readLocal(root, 'last-seen.json', null);
  const lines = renderBriefing({
    me: team.me.user,
    members: team.members,
    claims,
    config: team.config,
    prCache,
    at,
    lastSeen: lastSeen?.at,
    events,
  });
  await writeLocal(root, 'last-seen.json', { at: at.toISOString() });
  return output('SessionStart', lines.join('\n'), notices.length ? `multiplayer: ${notices.join(' ')}` : undefined);
}

// ----------------------------------------------------------------- PreToolUse

export const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

/**
 * Kick off a detached background pull + PR-cache refresh if the last one is
 * older than REFRESH_INTERVAL_MS, so teammates' new claims show up mid-session
 * without making this hook wait on the network.
 */
async function maybeRefreshInBackground(root, env) {
  const last = await readLocal(root, 'last-refresh.json', { at: 0 });
  if (Date.now() - last.at < REFRESH_INTERVAL_MS) return;
  await writeLocal(root, 'last-refresh.json', { at: Date.now() });
  const cli = fileURLToPath(new URL('../multiplayer.mjs', import.meta.url));
  const child = spawn(process.execPath, [cli, 'refresh'], { cwd: root, env, detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

/** Real path of `file`, resolving symlinks through its nearest existing ancestor. */
function realish(file) {
  let dir = file;
  const rest = [];
  while (!existsSync(dir) && path.dirname(dir) !== dir) {
    rest.unshift(path.basename(dir));
    dir = path.dirname(dir);
  }
  try {
    return path.join(realpathSync(dir), ...rest);
  } catch {
    return file;
  }
}

/** Directory used to throttle "claim this" nudges: one per directory per session. */
const areaOf = (rel) => path.posix.dirname(rel);

export async function preToolUse(input, { env = process.env } = {}) {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) return null;
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  const { root } = located;
  const rel = path
    .relative(realish(root), realish(path.resolve(input.cwd || root, target)))
    .split(path.sep)
    .join('/');
  if (rel.startsWith('..') || rel === STATE_DIR || rel.startsWith(`${STATE_DIR}/`)) return null;

  // Local reads only: no pull, no gh call (PreToolUse budget < 1s).
  await maybeRefreshInBackground(root, env);
  const dir = stateDir(root);
  const [me, config, claims, prCache] = await Promise.all([
    identity(root, env),
    readConfig(dir),
    listClaims(dir),
    readPrCache(root),
  ]);
  const at = now(env);
  const active = activeClaims(claims).filter((c) => !mergedPr(c, prCache));
  const seenFile = `session-${String(input.session_id || 'none').replace(/[^\w-]/g, '')}.json`;
  const seen = await readLocal(root, seenFile, { warned: [], nudged: [] });
  const messages = [];

  const theirs = active.filter((c) => c.user !== me.user && covers(c, rel));
  if (theirs.length && !seen.warned.includes(rel)) {
    const who = theirs
      .map((c) => `${c.user} (claim "${c.slug}": ${c.task}, updated ${ago(c.updated ?? c.started, at)}${isStale(c, config, at) ? ', stale' : ''})`)
      .join(' and ');
    messages.push(`⚠️ multiplayer: ${who} ${theirs.length > 1 ? 'are' : 'is'} working on ${rel}. Confirm with the user before proceeding.`);
    seen.warned.push(rel);
  }

  const mine = active.some((c) => c.user === me.user && covers(c, rel));
  if (!mine && !seen.nudged.includes(areaOf(rel))) {
    messages.push(
      `multiplayer: none of your claims covers ${rel}. Before continuing, claim this work with the multiplayer:claim skill (narrow paths), or extend your existing claim to cover it.`,
    );
    seen.nudged.push(areaOf(rel));
  }

  if (!messages.length) return null;
  await writeLocal(root, seenFile, seen);
  return output('PreToolUse', messages.join('\n'));
}

// ---------------------------------------------------------------- PostToolUse

const FLAGS_WITH_VALUES = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit']);

/** Parse `gh pr merge [ref] [flags]` out of a shell command. Returns { ref, repo } or null. */
export function parseGhMerge(command) {
  const m = /\bgh\s+pr\s+merge\b([^;&|\n]*)/.exec(command ?? '');
  if (!m) return null;
  const tokens = m[1].trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/^['"]|['"]$/g, ''));
  let ref;
  let repo;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      const [flag, value] = t.split('=');
      const v = value ?? (FLAGS_WITH_VALUES.has(flag) ? tokens[++i] : undefined);
      if (flag === '-R' || flag === '--repo') repo = v;
    } else if (ref === undefined) ref = t;
  }
  return { ref, repo };
}

function mergeTarget(input) {
  if (input.tool_name === 'Bash') return parseGhMerge(input.tool_input?.command);
  if (/merge_pull_request$/.test(input.tool_name ?? '')) {
    const { owner, repo, pullNumber, pull_number: pn } = input.tool_input ?? {};
    const ref = pullNumber ?? pn;
    if (!ref) return null;
    return { ref: String(ref), repo: owner && repo ? `${owner}/${repo}` : undefined };
  }
  return null;
}

export async function postToolUse(input, { env = process.env } = {}) {
  const target = mergeTarget(input);
  if (!target) return null;
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  const { root } = located;

  const pr = await prView(root, target.ref, { repo: target.repo, env });
  if (pr?.state !== 'MERGED' || !pr.headRefName) return null;
  await rm(path.join(await localDir(root), 'gh-cache.json'), { force: true });

  const team = await openTeam(root, { env, timeout: HOOK_NET_TIMEOUT_MS });
  const mine = activeClaims(await listClaims(team.dir)).filter(
    (c) => c.user === team.me.user && c.branch === pr.headRefName && !c.keep,
  );
  if (!mine.length) return null;
  await release({ ...team, timeout: HOOK_NET_TIMEOUT_MS }, mine.map((c) => ({ claim: c, outcome: `merged in #${pr.number}` })));
  const names = mine.map((c) => `"${c.slug}"`).join(', ');
  const msg = `multiplayer: released ${names} (PR #${pr.number} merged)`;
  return output('PostToolUse', `${msg}. Tell the user in one line.`, msg);
}

// ----------------------------------------------------------------- SessionEnd

export async function sessionEnd(input, { env = process.env } = {}) {
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  const { root } = located;
  const branch = await currentBranch(root);
  if (!branch) return null;

  const team = await openTeam(root, { env, sync: false });
  const mine = activeClaims(await listClaims(team.dir)).filter((c) => c.user === team.me.user && c.branch === branch);
  if (!mine.length) return null;

  const since = mine.map((c) => c.started).sort()[0];
  const log = await git(['log', '-5', `--since=${since}`, '--format=%h %s'], { cwd: root }).catch(() => '');
  const status = await git(['status', '--porcelain', '--untracked-files=all'], { cwd: root }).catch(() => '');
  const uncommitted = status
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .filter((f) => !f.startsWith(`${STATE_DIR}/`));
  const leftOff = {
    branch,
    commits: log ? log.split('\n') : [],
    uncommitted: uncommitted.slice(0, 15),
    ...(uncommitted.length > 15 ? { moreUncommitted: uncommitted.length - 15 } : {}),
  };
  try {
    await snapshot({ ...team, timeout: HOOK_NET_TIMEOUT_MS }, { branch, leftOff });
  } catch {
    // Push failed (offline?). The commit stays local and is pushed at next session start.
  }
  return null;
}
