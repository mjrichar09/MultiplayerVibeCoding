#!/usr/bin/env node
// crew CLI entry. Usage: crew.mjs <subcommand> [args...]
//
// Hook subcommands (`hook <event>`) must fail open: any error exits 0 with no
// output so a broken plugin never breaks a Claude Code session.

const HOOKS = {
  // Phase 0: no-op. Phase 2 renders the team briefing here.
  'session-start': async (_input) => null,
  // Phase 0: no-op. Phase 4 adds the overlap warning here.
  'pre-tool-use': async (_input) => null,
};

const COMMANDS = {
  hook: runHook,
  version: async () => {
    console.log('crew 0.0.1');
  },
};

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
    console.error(`crew: unknown command "${cmd ?? ''}". Commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  await fn(rest);
}

main(process.argv.slice(2));
