#!/usr/bin/env node
// Stand-in for the GitHub CLI. Serves PRs from the JSON file named by
// FAKE_GH_FIXTURE: { "merged": [...], "open": [...] }. Exits 1 if the fixture
// is missing, like an unauthenticated gh.
import { readFileSync } from 'node:fs';

let fixture;
try {
  fixture = JSON.parse(readFileSync(process.env.FAKE_GH_FIXTURE, 'utf8'));
} catch {
  process.exit(1);
}
const args = process.argv.slice(2);
const all = [
  ...(fixture.merged ?? []).map((p) => ({ state: 'MERGED', ...p })),
  ...(fixture.open ?? []).map((p) => ({ state: 'OPEN', ...p })),
];

if (args[0] === 'pr' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1];
  process.stdout.write(JSON.stringify(state === 'merged' ? fixture.merged ?? [] : fixture.open ?? []));
} else if (args[0] === 'pr' && args[1] === 'view') {
  const ref = args[2] && !args[2].startsWith('-') ? args[2] : null;
  const pr = all.find((p) => String(p.number) === ref || p.headRefName === ref || p.url === ref);
  if (!pr) process.exit(1);
  process.stdout.write(JSON.stringify(pr));
} else {
  process.exit(1);
}
