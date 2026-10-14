// Hook handlers. Each returns a hook output object or null. The CLI wrapper
// makes every handler fail open (PLAN §2.5).

import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderBriefing } from './briefing.mjs';
import { activeClaims, claim, covers, isStale, listClaims, mergedPr, release, snapshot, supersededBy } from './claims.mjs';
import { listEntries } from './entries.mjs';
import {
  endSession,
  forgetAgent,
  heartbeat,
  otherEditors,
  peersInFolder,
  recordEdit,
  registerSession,
  workerRole,
} from './sessions.mjs';
import { STATE_DIR, currentBranch, git, isAttached, localDir, remoteHasStateBranch, stateDir } from './git.mjs';
import { prView, prs, readPrCache } from './gh.mjs';
import { identity } from './identity.mjs';
import { InitError, init, locate } from './init.mjs';
import { readConfig } from './state.mjs';
import { openTeam } from './team.mjs';
import { matchesAny } from './glob.mjs';
import { ago, now } from './util.mjs';
import {
  checkoutHandedBranch,
  cleanupMergedBranch,
  currentBranchOrNull,
  defaultBranch,
  fastForwardLocal,
  fetchDefault,
  incomingFiles,
  mergeDefault,
} from './workflow.mjs';

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
  if (joined.status === 'joined') {
    notices.push(`joined team as ${team.me.user} (${team.members.length} members)`);
    events.push(WELCOME);
  }

  // Parallel agents (PLAN §2.9): workers leave git and team actions to their
  // lead; unmanaged sessions sharing this folder pause the automatic git steps.
  const role = await workerRole(root, input, env);
  const peers = role ? [] : await peersInFolder(root, input.session_id);
  await registerSession(root, input.session_id, { role: role ? 'worker' : 'lead' });
  const gitPaused = peers.length > 0;
  if (gitPaused) {
    events.push(
      `${plural(peers.length, 'other agent session')} ${peers.length === 1 ? 'is' : 'are'} active in this folder, so automatic git steps ` +
        '(branch updates, switching, cleanup) are paused until ' + (peers.length === 1 ? 'it ends' : 'they end') +
        '. You share one checkout: coordinate commits and branch changes with the user.',
    );
  }

  // Auto-release (PLAN §2.7): my claims whose PR merged, or that a teammate took over.
  let claims = await listClaims(team.dir);
  const toRelease = [];
  for (const c of role ? [] : claims.filter((c) => c.user === team.me.user)) {
    const taker = supersededBy(claims, c.id);
    const pr = mergedPr(c, prCache);
    if (taker?.handoff) toRelease.push({ claim: c, outcome: `handed off to ${taker.user}`, event: `${taker.user} accepted your handoff of "${c.slug}".` });
    else if (taker) toRelease.push({ claim: c, outcome: `taken over by ${taker.user}`, event: `${taker.user} took over your stale claim "${c.slug}".` });
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

  // Accept handoffs addressed to me (PLAN §4): take over the claim and, if
  // it's safe, switch to the handed-over branch.
  const handoffs = await listEntries(team.dir, 'handoff');
  const read = await readLocal(root, 'read.json', { handoffs: [] });
  const accepted = new Set(claims.map((c) => c.handoff).filter(Boolean));
  let switchedBranch = false;
  for (const h of role ? [] : handoffs.filter((h) => h.to?.includes(team.me.user) && !read.handoffs.includes(h.id))) {
    const target = h.claim && activeClaims(claims).find((c) => c.id === h.claim);
    if (target && !accepted.has(h.id)) {
      try {
        const r = await claim({ ...team, timeout }, {
          takeover: h.claim,
          handoff: h,
          notes: `Handed over by ${h.user}: see .multiplayer/${h.file}`,
        });
        notices.push(`accepted ${h.user}'s handoff "${r.claim.slug}".`);
      } catch (err) {
        notices.push(`couldn't accept ${h.user}'s handoff: ${err.message}`);
      }
    } else if (!h.claim) notices.push(`${h.user} sent you a handoff: ${h.title}.`);
    if (h.branch && team.config.autoUpdate !== false && !switchedBranch && !gitPaused) {
      const base = await defaultBranch(root, remote, team.config);
      const r = await checkoutHandedBranch(root, remote, base, h.branch, { timeout });
      if (r.status === 'switched') {
        switchedBranch = true;
        events.push(`switched to ${h.user}'s branch ${h.branch} to continue their work.`);
      } else events.push(`${h.user}'s work is on branch ${h.branch}; switch to it when ready (not switched: ${r.reason}).`);
    }
  }
  claims = await listClaims(team.dir);

  if (team.config.autoUpdate !== false && !role && !gitPaused) {
    for (const e of await gitAutopilot(team, toRelease, prCache, timeout)) {
      events.push(e);
      notices.push(e);
    }
  }

  const [decisions, notes] = await Promise.all([listEntries(team.dir, 'decision'), listEntries(team.dir, 'note')]);
  const lastSeen = await readLocal(root, 'last-seen.json', null);
  const lines = renderBriefing({
    me: team.me.user,
    members: team.members,
    claims,
    decisions,
    notes,
    handoffs,
    readHandoffs: read.handoffs,
    config: team.config,
    prCache,
    at,
    lastSeen: lastSeen?.at,
    events,
    role,
  });
  await writeLocal(root, 'last-seen.json', { at: at.toISOString() });
  const shownToMe = handoffs.filter((h) => h.to?.includes(team.me.user)).map((h) => h.id);
  await writeLocal(root, 'read.json', { handoffs: [...new Set([...read.handoffs, ...shownToMe])] });
  return output('SessionStart', lines.join('\n'), notices.length ? `multiplayer: ${notices.join(' ')}` : undefined);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

const WELCOME =
  "welcome to the team! Teammates' claims, decisions, and notes now appear here at each session start. " +
  'Things the user can simply say: "what is the team working on?", "hand this to <name>", ' +
  '"record that we decided …", "tell the team …". Mention this to the user once.';

// Per-worktree record of the default-branch tip we've already told the agent about.
async function incomingSeen(root) {
  return (await readLocal(root, 'incoming-seen.json', {}))[root];
}
async function setIncomingSeen(root, tip) {
  const all = await readLocal(root, 'incoming-seen.json', {});
  await writeLocal(root, 'incoming-seen.json', { ...all, [root]: tip });
}

/**
 * Session-start git upkeep (PLAN §2.8), before the agent has read anything:
 * clean up a merged task branch, fast-forward the default branch, and merge it
 * into the current task branch when that can't lose work. Returns event lines.
 */
async function gitAutopilot(team, released, prCache, timeout) {
  const { root, remote, config } = team;
  const base = await defaultBranch(root, remote, config);
  await fetchDefault(root, remote, base, { timeout }).catch(() => {});
  const events = [];

  const branch = await currentBranchOrNull(root);
  const merged = released.map((r) => r.claim).find((c) => c.branch && c.branch === branch);
  if (merged) {
    const pr = prCache?.merged?.find((p) => p.headRefName === branch);
    const r = await cleanupMergedBranch(root, remote, base, branch, pr?.headRefOid, { timeout });
    if (r.status === 'cleaned') events.push(`switched to ${base} and deleted the merged branch ${branch}.`);
    else events.push(`kept branch ${branch} after its PR merged: ${r.reason}.`);
  }

  await fastForwardLocal(root, remote, base);
  const r = await mergeDefault(root, remote, base, { onConflict: 'abort' });
  const current = await currentBranchOrNull(root);
  if (r.status === 'merged') events.push(`merged the latest ${base} into ${current} (${plural(r.behind, 'new commit')}).`);
  else if (r.status === 'conflict') {
    events.push(
      `${base} has ${plural(r.behind, 'new commit')} that conflict with ${current} in ${r.files.join(', ')}. ` +
        'Nothing was changed. Commit your work, then use the multiplayer:update skill and resolve the conflicts.',
    );
  } else if (r.status === 'dirty') {
    events.push(
      `${current} is ${plural(r.behind, 'commit')} behind ${base} and wasn't updated because of uncommitted changes. ` +
        'At your next checkpoint, commit and use the multiplayer:update skill.',
    );
  }
  const incoming = await incomingFiles(root, remote, base);
  await setIncomingSeen(root, incoming.tip);
  return events;
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

// Commands a worker should leave to its lead (PLAN §2.9).
const LEAD_ONLY_COMMAND =
  /\bgit\s+(commit|merge|rebase|push|pull|switch|checkout|reset|branch|stash|cherry-pick|revert)\b|\bgh\s+pr\s+(create|merge)\b|multiplayer\.mjs\s+(claim|release|update|handoff|init|decide)\b/;
const LEAD_ONLY_SKILL = /^multiplayer:(claim|release|update|handoff|init|decide)$/;

/** Warn a worker that's about to do its lead's job (git, claims, PRs). Never blocks. */
async function workerCommandCheck(input, env) {
  const command = input.tool_name === 'Bash' ? input.tool_input?.command ?? '' : '';
  const skill = input.tool_name === 'Skill' ? input.tool_input?.skill ?? input.tool_input?.name ?? '' : '';
  if (!LEAD_ONLY_COMMAND.test(command) && !LEAD_ONLY_SKILL.test(skill)) return null;
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  if (!(await workerRole(located.root, input, env))) return null;
  return output(
    'PreToolUse',
    'multiplayer: you are a worker agent. Leave git (commits, branches, merges, pushes), PRs, claims, decisions, and handoffs to your lead: ' +
      'finish your edits and report what you changed. Only proceed if your lead explicitly asked you to do this.',
  );
}

export async function preToolUse(input, { env = process.env } = {}) {
  if (input.tool_name === 'Bash' || input.tool_name === 'Skill') return workerCommandCheck(input, env);
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) return null;
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  const { root } = located;
  await heartbeat(root, input.session_id);
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
  const role = await workerRole(root, input, env);
  const active = activeClaims(claims).filter((c) => !mergedPr(c, prCache));
  const actor = [input.session_id, input.agent_id].filter(Boolean).join('--') || 'none';
  const seenFile = `session-${actor.replace(/[^\w-]/g, '')}.json`;
  const seen = await readLocal(root, seenFile, { warned: [], nudged: [], siblings: [] });
  seen.siblings ??= [];
  const messages = [];
  const askWho = role ? 'your lead' : 'the user';

  // My other agents (subagents, parallel sessions, other worktrees) on the same file.
  const siblings = await otherEditors(root, input, rel);
  await recordEdit(root, input, rel);
  if (siblings.length && !seen.siblings.includes(rel)) {
    const who = siblings
      .map((e) =>
        e.agentId
          ? `a ${e.agentType ? `${e.agentType} ` : ''}subagent${e.session === input.session_id ? ' in this session' : ''}`
          : e.worktree === root
            ? 'another session in this folder'
            : `a session in worktree ${path.basename(e.worktree)}`,
      )
      .join(' and ');
    messages.push(
      `⚠️ multiplayer: ${who} also edited ${rel} recently. Make sure you're not overwriting each other's work; check with ${askWho} if unsure.`,
    );
    seen.siblings.push(rel);
  }

  const theirs = active.filter((c) => c.user !== me.user && covers(c, rel));
  if (theirs.length && !seen.warned.includes(rel)) {
    const who = theirs
      .map((c) => `${c.user} (claim "${c.slug}": ${c.task}, updated ${ago(c.updated ?? c.started, at)}${isStale(c, config, at) ? ', stale' : ''})`)
      .join(' and ');
    messages.push(`⚠️ multiplayer: ${who} ${theirs.length > 1 ? 'are' : 'is'} working on ${rel}. Confirm with ${askWho} before proceeding.`);
    seen.warned.push(rel);
  }

  const mine = active.some((c) => c.user === me.user && covers(c, rel));
  if (role?.paths?.length && !matchesAny(role.paths, rel) && !seen.nudged.includes(areaOf(rel))) {
    messages.push(`multiplayer: ${rel} is outside your assigned files (${role.paths.join(', ')}). Check with your lead before editing it.`);
    seen.nudged.push(areaOf(rel));
  } else if (!role && !mine && !seen.nudged.includes(areaOf(rel))) {
    messages.push(
      `multiplayer: none of your claims covers ${rel}. Before continuing, claim this work with the multiplayer:claim skill (narrow paths), or extend your existing claim to cover it.`,
    );
    seen.nudged.push(areaOf(rel));
  }

  // New commits on the default branch touching files I've claimed (fetched by
  // the background refresh). Once per new tip.
  const mineActive = active.filter((c) => c.user === me.user);
  if (mineActive.length && !role) {
    const base = await defaultBranch(root, located.remote, config);
    const branch = await currentBranchOrNull(root);
    if (branch && branch !== base) {
      const incoming = await incomingFiles(root, located.remote, base);
      const lastTip = await incomingSeen(root);
      const hits = incoming.files.filter((f) => mineActive.some((c) => matchesAny(c.paths, f)));
      if (incoming.tip && incoming.tip !== lastTip && hits.length) {
        const shown = hits.slice(0, 3).join(', ') + (hits.length > 3 ? `, +${hits.length - 3} more` : '');
        messages.push(
          `multiplayer: ${base} has new changes to files in your claims (${shown}). ` +
            'At your next checkpoint, commit your work and use the multiplayer:update skill to merge them in.',
        );
        await setIncomingSeen(root, incoming.tip);
      }
    }
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
  const parts = [];
  if (mine.length) {
    await release({ ...team, timeout: HOOK_NET_TIMEOUT_MS }, mine.map((c) => ({ claim: c, outcome: `merged in #${pr.number}` })));
    parts.push(`released ${mine.map((c) => `"${c.slug}"`).join(', ')} (PR #${pr.number} merged)`);
  }
  const busyFolder = (await workerRole(root, input, env)) || (await peersInFolder(root, input.session_id)).length;
  if (team.config.autoUpdate !== false && !busyFolder) {
    const base = await defaultBranch(root, team.remote, team.config);
    const r = await cleanupMergedBranch(root, team.remote, base, pr.headRefName, pr.headRefOid, {
      timeout: HOOK_NET_TIMEOUT_MS,
    });
    if (r.status === 'cleaned') parts.push(`switched to ${base} and deleted the merged branch ${pr.headRefName}`);
    else if (r.reason !== 'not checked out') parts.push(`kept branch ${pr.headRefName} (${r.reason})`);
  }
  if (!parts.length) return null;
  const msg = `multiplayer: ${parts.join('; ')}`;
  return output('PostToolUse', `${msg}. Tell the user in one line.`, msg);
}

// ----------------------------------------------------------------- SessionEnd

export async function sessionEnd(input, { env = process.env } = {}) {
  const located = await locateOrNull(input, env);
  if (!located || !isAttached(located.root)) return null;
  const { root } = located;
  await endSession(root, input.session_id); // lifts the shared-folder pause for others
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

// --------------------------------------------------------------- SubagentStop

/** A finished subagent no longer counts as a concurrent editor. */
export async function subagentStop(input, { env = process.env } = {}) {
  const located = await locateOrNull(input, env);
  if (located && isAttached(located.root)) await forgetAgent(located.root, input);
  return null;
}
