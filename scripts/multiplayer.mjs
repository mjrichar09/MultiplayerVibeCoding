#!/usr/bin/env node
// multiplayer CLI entry. Usage: multiplayer.mjs <subcommand> [args...]
//
// Hook subcommands (`hook <event>`) must fail open: any error exits 0 with no
// output so a broken plugin never breaks a Claude Code session.

import { sessionStart } from './lib/hooks.mjs';
import { identity } from './lib/identity.mjs';
import { init, locate } from './lib/init.mjs';
import { listMembers } from './lib/state.mjs';
import { isAttached, stateDir } from './lib/git.mjs';

const HOOKS = {
  'session-start': sessionStart,
  // Phase 0: no-op. Phase 4 adds the overlap warning here.
  'pre-tool-use': async (_input) => null,
};

const COMMANDS = {
  hook: runHook,
  init: runInit,
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
