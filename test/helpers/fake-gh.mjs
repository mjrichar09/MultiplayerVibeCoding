#!/usr/bin/env node
// Stand-in for the GitHub CLI. Serves PRs from the JSON file named by
// FAKE_GH_FIXTURE: { "merged": [...], "open": [...] }. Exits 1 if the fixture
// is missing, like an unauthenticated gh.
import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv[2] === '--version') process.exit(0);
if (process.argv[2] === 'auth') process.exit(process.env.FAKE_GH_UNAUTH ? 1 : 0);
if (process.env.FAKE_GH_UNAUTH) process.exit(4);
if (process.env.FAKE_GH_NO_GRAPHQL && process.argv[2] === 'pr') {
  process.stderr.write('HTTP 403: GitHub GraphQL is not available from Claude Code sessions\n');
  process.exit(1);
}
if (process.env.FAKE_GH_GARBAGE) {
  process.stdout.write('this is not json');
  process.exit(0);
}
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
} else if (args[0] === 'pr' && args[1] === 'checks') {
  const ref = args[2] && !args[2].startsWith('-') ? args[2] : 'current';
  const checks = fixture.checks?.[ref];
  if (!checks) {
    process.stderr.write(`no checks reported on the '${ref}' branch\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(checks));
  if (checks.some((c) => c.bucket === 'fail')) process.exit(1);
  if (checks.some((c) => c.bucket === 'pending')) process.exit(8);
} else if (args[0] === 'repo' && args[1] === 'view') {
  if (!fixture.repo) process.exit(1);
  process.stdout.write(JSON.stringify(fixture.repo));
} else if (args[0] === 'api') {
  const put = args.includes('PUT');
  const url = args.find((a) => a.startsWith('repos/'));
  if (put) {
    if (fixture.protectError) {
      process.stderr.write(fixture.protectError);
      process.exit(1);
    }
    const input = readFileSync(args[args.indexOf('--input') + 1], 'utf8');
    writeFileSync(`${process.env.FAKE_GH_FIXTURE}.protection.json`, JSON.stringify({ url, body: JSON.parse(input) }));
    process.stdout.write('{}');
  } else if (url && /^repos\/[^/]+\/[^/]+$/.test(url)) {
    if (!fixture.repo) process.exit(1);
    const perm = fixture.repo.viewerPermission;
    process.stdout.write(JSON.stringify({ full_name: fixture.repo.nameWithOwner, permissions: { admin: perm === 'ADMIN', push: perm !== 'READ' } }));
  } else if (url?.endsWith('/protection')) {
    if (!fixture.protected) process.exit(1);
    process.stdout.write('{}');
  } else if (url?.includes('/check-runs')) {
    process.stdout.write(JSON.stringify({ check_runs: (fixture.mainChecks ?? []).map((name) => ({ name })) }));
  } else if (url?.endsWith('/status')) {
    process.stdout.write(JSON.stringify({ statuses: (fixture.mainStatuses ?? []).map((context) => ({ context })) }));
  } else if (url === undefined && args[1] === 'user') {
    const login = process.env.FAKE_GH_USER ?? fixture.user;
    if (!login) process.exit(1);
    process.stdout.write(JSON.stringify({ login }));
  } else process.exit(1);
} else if (args[0] === 'pr' && args[1] === 'view') {
  const ref = args[2] && !args[2].startsWith('-') ? args[2] : null;
  const pr = all.find((p) => String(p.number) === ref || p.headRefName === ref || p.url === ref);
  if (!pr) process.exit(1);
  process.stdout.write(JSON.stringify(pr));
} else {
  process.exit(1);
}
