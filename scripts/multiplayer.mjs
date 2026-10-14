#!/usr/bin/env node
// multiplayer CLI entry. Usage: multiplayer.mjs <subcommand> [args...]
//
// Hook subcommands (`hook <event>`) must fail open: any error exits 0 with no
// output so a broken plugin never breaks a Claude Code session.

import { parseArgs } from 'node:util';
import { renderBriefing } from './lib/briefing.mjs';
import { activeClaims, claim, listClaims, release } from './lib/claims.mjs';
import { decide, handoff, listEntries, note } from './lib/entries.mjs';
import { isAttached, stateDir } from './lib/git.mjs';
import { prs } from './lib/gh.mjs';
import { postToolUse, preToolUse, sessionEnd, sessionStart, subagentStop } from './lib/hooks.mjs';
import { identity } from './lib/identity.mjs';
import { init, locate } from './lib/init.mjs';
import { listMembers } from './lib/state.mjs';
import { activeSessions, setWorker, workerRole } from './lib/sessions.mjs';
import { collectWorktree, createWorktree } from './lib/parallel.mjs';
import { openTeam } from './lib/team.mjs';
import { now, splitList } from './lib/util.mjs';
import { currentBranchOrNull, defaultBranch, fastForwardLocal, fetchDefault, mergeDefault } from './lib/workflow.mjs';

const HOOKS = {
  'session-start': sessionStart,
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  'session-end': sessionEnd,
  'subagent-stop': subagentStop,
};

const COMMANDS = {
  hook: runHook,
  init: runInit,
  claim: runClaim,
  release: runRelease,
  status: runStatus,
  decide: runDecide,
  note: runNote,
  handoff: runHandoff,
  update: runUpdate,
  worker: runWorker,
  worktree: runWorktree,
  collect: runCollect,
  // Background refresh started by the PreToolUse hook: pull state, refresh the
  // PR cache, and fetch the default branch (refs only; never touches files).
  refresh: async () => {
    const team = await openTeam(process.cwd(), { timeout: 10_000 });
    const base = await defaultBranch(team.root, team.remote, team.config);
    await Promise.all([
      prs(team.root, { refresh: true }),
      fetchDefault(team.root, team.remote, base, { timeout: 10_000 }).catch(() => {}),
    ]);
  },
  whoami: async () => {
    const { root } = await locate(process.cwd());
    const me = await identity(root);
    console.log(me.user);
  },
  members: async () => {
    const { root } = await locate(process.cwd());
    if (!isAttached(root)) throw new Error('Not set up here. Run `multiplayer init` first.');
    for (const m of await listMembers(stateDir(root))) {
      console.log(`${m.user}${m.active === false ? ' (inactive)' : ''}${m.email ? ` <${m.email}>` : ''}`);
    }
  },
  version: async () => {
    console.log('multiplayer 0.0.1');
  },
};

async function runInit(args) {
  const create = args.includes('--create');
  const result = await init({ cwd: process.cwd(), create });
  const verb = { created: 'Created the team', joined: 'Joined the team', member: 'Already on the team' }[result.status];
  const team = result.members.map((m) => m.user).join(', ');
  console.log(`${verb} as "${result.user}". Members (${result.members.length}): ${team}.`);
}

async function runClaim(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      task: { type: 'string' },
      paths: { type: 'string', multiple: true },
      issue: { type: 'string' },
      slug: { type: 'string' },
      notes: { type: 'string' },
      takeover: { type: 'string' },
      keep: { type: 'boolean' },
      'no-keep': { type: 'boolean' },
      'no-branch': { type: 'boolean' },
    },
  });
  const team = await openTeam(process.cwd());
  if (await workerRole(team.root)) {
    throw new Error('This is a worker session: your lead claims work. Report what you need to your lead instead.');
  }
  // Another session shares this checkout: don't switch its branch underneath it.
  const sharing = (await activeSessions(team.root)).filter((s) => s.worktree === team.root).length > 1;
  const result = await claim(team, {
    task: values.task,
    paths: splitList(values.paths ?? []),
    issue: values.issue ? Number(String(values.issue).replace(/^#/, '')) : undefined,
    slug: values.slug,
    notes: values.notes,
    takeover: values.takeover,
    keep: values.keep ? true : values['no-keep'] ? false : undefined,
    noBranch: values['no-branch'] || sharing,
  });
  const c = result.claim;
  if (sharing && !values['no-branch']) {
    console.log('Another agent session is active in this folder, so no task branch was started (it would switch the branch under it).');
  }
  const verb = { created: 'Claimed', updated: 'Updated claim', 'took-over': 'Took over' }[result.status];
  console.log(
    `${verb} "${c.slug}" for ${c.user}: ${c.task} [${c.paths.join(', ')}] on ${c.branch || '(no branch)'}` +
      `${c.keep ? ' (kept open after merge)' : ''}${c.supersedes ? ` (supersedes ${c.supersedes})` : ''}.`,
  );
  if (result.branchCreated) console.log(`Started branch ${c.branch} from the latest default branch; work and commit there.`);
  for (const o of result.overlaps) {
    console.log(`⚠️ Overlaps ${o.claim.user}'s claim "${o.claim.slug}" (${o.claim.task}) on ${o.paths.join(', ')}.`);
  }
  for (const { pr, owner, files } of result.overlaps.prs ?? []) {
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? `, +${files.length - 3} more` : '');
    console.log(`⚠️ Overlaps ${owner}'s open PR #${pr.number}${pr.title ? ` (${pr.title})` : ''}, which changes ${shown}.`);
  }
}

async function runRelease(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { outcome: { type: 'string' }, all: { type: 'boolean' } },
  });
  const team = await openTeam(process.cwd());
  const mine = activeClaims(await listClaims(team.dir)).filter((c) => c.user === team.me.user);
  let chosen;
  if (values.all) chosen = mine;
  else if (positionals.length) {
    chosen = positionals.map((slug) => {
      const c = mine.find((m) => m.slug === slug || m.id === slug);
      if (!c) throw new Error(`You have no claim "${slug}". Yours: ${mine.map((m) => m.slug).join(', ') || 'none'}.`);
      return c;
    });
  } else if (mine.length === 1) chosen = mine;
  else if (mine.length === 0) throw new Error('You have no active claims.');
  else throw new Error(`Which claim? Yours: ${mine.map((m) => m.slug).join(', ')}. Pass a slug or --all.`);
  const released = await release(team, chosen.map((c) => ({ claim: c, outcome: values.outcome })));
  console.log(`Released ${released.map((c) => `"${c.slug}"`).join(', ')}.`);
}

// Long text (decision and handoff bodies) comes from --body or stdin.
async function bodyFrom(values) {
  if (values.body !== undefined) return values.body;
  return process.stdin.isTTY ? '' : readStdin();
}

async function runDecide(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { title: { type: 'string' }, body: { type: 'string' }, supersedes: { type: 'string' } },
  });
  const team = await openTeam(process.cwd());
  const d = await decide(team, { title: values.title, body: await bodyFrom(values), supersedes: values.supersedes });
  console.log(`Recorded decision "${d.title}" [${d.id}]${d.supersedes ? `, replacing ${d.supersedes}` : ''}.`);
}

async function runNote(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { body: { type: 'string' } } });
  const team = await openTeam(process.cwd());
  const text = positionals.length ? positionals.join(' ') : await bodyFrom(values);
  const n = await note(team, { text });
  console.log(`Posted a note to the team: ${n.title}`);
}

async function runHandoff(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { to: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, claim: { type: 'string' } },
  });
  const team = await openTeam(process.cwd());
  const r = await handoff(team, { to: values.to, title: values.title, body: await bodyFrom(values), claim: values.claim });
  const h = r.handoff;
  console.log(
    `Handed off "${h.title}" to ${h.to.join(', ')}` +
      `${r.claim ? `, with your claim "${r.claim.slug}"` : ''}${h.branch ? ` on branch ${h.branch}${r.pushed ? ' (pushed)' : ''}` : ''}. ` +
      `${h.to.join(', ')}'s next session picks it up; your claim stays active until then.`,
  );
}

async function runStatus(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const team = await openTeam(process.cwd());
  const [decisions, notes, handoffs] = await Promise.all(
    ['decision', 'note', 'handoff'].map((k) => listEntries(team.dir, k)),
  );
  const lines = renderBriefing({
    me: team.me.user,
    members: team.members,
    decisions,
    notes,
    handoffs,
    claims: await listClaims(team.dir),
    config: team.config,
    prCache: await prs(team.root),
    at: now(),
    filterUser: positionals[0],
    cap: Infinity,
    rules: false,
  });
  console.log(lines.join('\n'));
}

// Mark a worktree's sessions as workers under a lead (PLAN §2.9). With a task
// and paths, also claim that work for the person, on the worktree's branch.
async function runWorker(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      dir: { type: 'string' },
      task: { type: 'string' },
      paths: { type: 'string', multiple: true },
      off: { type: 'boolean' },
    },
  });
  const cwd = values.dir ?? process.cwd();
  const team = await openTeam(cwd);
  if (values.off) {
    await setWorker(team.root, null);
    console.log(`Sessions in ${team.root} are no longer workers.`);
    return;
  }
  const paths = splitList(values.paths ?? []);
  await setWorker(team.root, { lead: team.me.user, task: values.task ?? null, paths });
  let claimed = '';
  if (values.task && paths.length) {
    const r = await claim(team, { task: values.task, paths, noBranch: true });
    claimed = ` Claimed "${r.claim.slug}" [${r.claim.paths.join(', ')}] for ${team.me.user} on ${r.claim.branch || '(no branch)'}.`;
    for (const o of r.overlaps) claimed += `\n⚠️ Overlaps ${o.claim.user}'s claim "${o.claim.slug}" on ${o.paths.join(', ')}.`;
  }
  console.log(
    `Sessions in ${team.root} are now workers${paths.length ? ` assigned to ${paths.join(', ')}` : ''}: ` +
      `they edit files and leave git, PRs, and claims to the lead.${claimed}`,
  );
}

// Start another agent in its own worktree (PLAN §2.9).
async function runWorktree(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      task: { type: 'string' },
      paths: { type: 'string', multiple: true },
      worker: { type: 'boolean' },
      dir: { type: 'string' },
    },
  });
  const team = await openTeam(process.cwd());
  const r = await createWorktree(team, {
    task: values.task ?? positionals.join(' '),
    paths: splitList(values.paths ?? []),
    worker: values.worker,
    dir: values.dir,
  });
  console.log(`Created worktree ${r.dir} on branch ${r.branch}${r.worker ? ' (forked from your current commit)' : ' (from the latest default branch)'}.`);
  if (r.worker) {
    console.log(`Its sessions are workers under you${r.leadClaim ? `, covered by your claim "${r.leadClaim.slug}"` : ''}: they edit and leave git to you.`);
    if (!r.leadClaim) console.log('⚠️ You have no claim on this branch: claim the whole task first so teammates can see it.');
    if (r.leadDirty.length) console.log(`⚠️ Your uncommitted changes (${r.leadDirty.join(', ')}) are not in the worker's copy; commit before starting more workers.`);
    console.log(`When the worker is done: node <plugin>/scripts/multiplayer.mjs collect ${JSON.stringify(r.dir)}`);
  } else if (r.claim) {
    console.log(`Claimed "${r.claim.slug}" [${r.claim.paths.join(', ')}] for ${r.claim.user} on ${r.claim.branch}.`);
  }
  console.log(`Start the agent with: ${r.startCommand}`);
}

// Fold a worker worktree's changes back into the lead's branch.
async function runCollect(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { message: { type: 'string' } } });
  if (!positionals[0]) throw new Error('Which worktree? Pass its folder or branch.');
  const team = await openTeam(process.cwd());
  const r = await collectWorktree(team, positionals[0], { message: values.message });
  if (r.status === 'conflict') {
    console.log(
      `Merging ${r.branch} has conflicts in: ${r.files.join(', ')}. Resolve them, \`git add\` the files, and \`git commit --no-edit\`; ` +
        `then run collect again to remove the worktree.`,
    );
    process.exitCode = 2;
    return;
  }
  console.log(
    r.status === 'merged'
      ? `Merged ${r.commits} commit${r.commits === 1 ? '' : 's'} from ${r.branch} and removed worktree ${r.dir}.`
      : `Nothing new on ${r.branch}; removed worktree ${r.dir}.`,
  );
}

// Bring the current branch up to date with the default branch by merging
// (PLAN §2.8). Conflicts are left in place for the agent to resolve.
async function runUpdate() {
  const { root, remote } = await locate(process.cwd());
  const config = isAttached(root) ? (await openTeam(root, { sync: false })).config : {};
  const base = await defaultBranch(root, remote, config);
  await fetchDefault(root, remote, base);
  const ff = await fastForwardLocal(root, remote, base);
  const branch = await currentBranchOrNull(root);
  if (branch === base) {
    console.log(ff === 'skipped' ? `Could not fast-forward ${base} (local commits or uncommitted changes in the way).` : `${base} is up to date.`);
    return;
  }
  const r = await mergeDefault(root, remote, base, { onConflict: 'leave' });
  const messages = {
    merged: `Merged ${r.behind} new commit${r.behind === 1 ? '' : 's'} from ${base} into ${branch}.`,
    'up-to-date': `${branch} already has everything from ${base}.`,
    dirty: `Not updated: commit your changes first (${(r.files ?? []).join(', ')}), then run update again.`,
    skipped: `Not updated: ${r.reason}.`,
    conflict:
      `Merging ${base} into ${branch} has conflicts in: ${(r.files ?? []).join(', ')}.\n` +
      'The merge is in progress. Resolve each file (keep both sides\' intent; ask the user only when both sides changed the same logic), ' +
      'then `git add` the files and `git commit --no-edit`. To back out instead: `git merge --abort`.',
  };
  console.log(messages[r.status]);
  if (r.status === 'conflict') process.exitCode = 2;
}

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function runHook([event]) {
  try {
    const handler = HOOKS[event];
    if (!handler) return;
    const raw = await readStdin();
    const input = raw.trim() ? JSON.parse(raw) : {};
    const output = await handler(input);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch {
    // Fail open: swallow everything.
  }
  process.exitCode = 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const fn = COMMANDS[cmd];
  if (!fn) {
    console.error(`multiplayer: unknown command "${cmd ?? ''}". Commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  try {
    await fn(rest);
  } catch (err) {
    console.error(`multiplayer: ${err.message}`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2));
