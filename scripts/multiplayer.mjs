#!/usr/bin/env node
// multiplayer CLI entry. Usage: multiplayer.mjs <subcommand> [args...]
//
// Hook subcommands (`hook <event>`) must fail open: any error exits 0 with no
// output so a broken plugin never breaks a Claude Code session.

import { parseArgs } from 'node:util';
import { renderBriefing } from './lib/briefing.mjs';
import { activeClaims, claim, listClaims, release } from './lib/claims.mjs';
import { isAttached, stateDir } from './lib/git.mjs';
import { prs } from './lib/gh.mjs';
import { postToolUse, preToolUse, sessionEnd, sessionStart } from './lib/hooks.mjs';
import { identity } from './lib/identity.mjs';
import { init, locate } from './lib/init.mjs';
import { listMembers } from './lib/state.mjs';
import { openTeam } from './lib/team.mjs';
import { now, splitList } from './lib/util.mjs';

const HOOKS = {
  'session-start': sessionStart,
  'pre-tool-use': preToolUse,
  'post-tool-use': postToolUse,
  'session-end': sessionEnd,
};

const COMMANDS = {
  hook: runHook,
  init: runInit,
  claim: runClaim,
  release: runRelease,
  status: runStatus,
  // Background refresh started by the PreToolUse hook: pull state, refresh the PR cache.
  refresh: async () => {
    const team = await openTeam(process.cwd(), { timeout: 10_000 });
    await prs(team.root, { refresh: true });
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
    },
  });
  const team = await openTeam(process.cwd());
  const result = await claim(team, {
    task: values.task,
    paths: splitList(values.paths ?? []),
    issue: values.issue ? Number(String(values.issue).replace(/^#/, '')) : undefined,
    slug: values.slug,
    notes: values.notes,
    takeover: values.takeover,
    keep: values.keep ? true : values['no-keep'] ? false : undefined,
  });
  const c = result.claim;
  const verb = { created: 'Claimed', updated: 'Updated claim', 'took-over': 'Took over' }[result.status];
  console.log(
    `${verb} "${c.slug}" for ${c.user}: ${c.task} [${c.paths.join(', ')}] on ${c.branch || '(no branch)'}` +
      `${c.keep ? ' (kept open after merge)' : ''}${c.supersedes ? ` (supersedes ${c.supersedes})` : ''}.`,
  );
  for (const o of result.overlaps) {
    console.log(`⚠️ Overlaps ${o.claim.user}'s claim "${o.claim.slug}" (${o.claim.task}) on ${o.paths.join(', ')}.`);
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

async function runStatus(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const team = await openTeam(process.cwd());
  const lines = renderBriefing({
    me: team.me.user,
    members: team.members,
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
