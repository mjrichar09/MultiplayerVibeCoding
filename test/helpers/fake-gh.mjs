#!/usr/bin/env node
// Stand-in for the GitHub CLI's REST API (`gh api …`), serving the JSON
// fixture named by FAKE_GH_FIXTURE:
//   { merged: [pr], open: [pr], checks: { <pr number>: [{ name, bucket }] },
//     repo: { nameWithOwner, viewerPermission }, mainChecks: [name],
//     mainStatuses: [context], protected, protectError, user }
// where pr = { number, title, headRefName, headRefOid?, author?, mergedAt?,
// isDraft?, files?: [{ path }], mergeCommit?: { oid } }.
// Exits 1 when the fixture is missing, like a signed-out gh.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
if (args[0] === 'auth') process.exit(process.env.FAKE_GH_UNAUTH ? 1 : 0);
if (process.env.FAKE_GH_UNAUTH) process.exit(4);
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
const out = (data) => process.stdout.write(JSON.stringify(data));
if (args[0] !== 'api') process.exit(1); // the plugin only uses the REST API

const now = new Date().toISOString();
const sha = (p) => p.headRefOid ?? `sha${p.number}`;
const rest = (p, merged) => ({
  number: p.number,
  title: p.title ?? `PR ${p.number}`,
  state: merged ? 'closed' : 'open',
  draft: Boolean(p.isDraft),
  head: { ref: p.headRefName, sha: sha(p) },
  user: { login: p.author?.login ?? 'someone' },
  merged_at: merged ? p.mergedAt ?? now : null,
  merge_commit_sha: merged ? p.mergeCommit?.oid ?? null : null,
  html_url: `https://github.com/acme/app/pull/${p.number}`,
  updated_at: now,
});
const merged = (fixture.merged ?? []).map((p) => ({ p, rest: rest(p, true) }));
const open = (fixture.open ?? []).map((p) => ({ p, rest: rest(p, false) }));
const all = [...open, ...merged];

const put = args.includes('PUT');
const endpoint = args.find((a) => a.startsWith('repos/') || a === 'user');
const [route, query = ''] = (endpoint ?? '').split('?');
const params = new URLSearchParams(query);
const parts = route.split('/'); // repos, owner, repo, ...rest

if (route === 'user') {
  const login = process.env.FAKE_GH_USER ?? fixture.user;
  if (!login) process.exit(1);
  out({ login });
} else if (put && route.endsWith('/protection')) {
  if (fixture.protectError) {
    process.stderr.write(fixture.protectError);
    process.exit(1);
  }
  const input = readFileSync(args[args.indexOf('--input') + 1], 'utf8');
  writeFileSync(`${process.env.FAKE_GH_FIXTURE}.protection.json`, JSON.stringify({ url: route, body: JSON.parse(input) }));
  out({});
} else if (parts.length === 3) {
  if (!fixture.repo) process.exit(1);
  const perm = fixture.repo.viewerPermission;
  out({ full_name: fixture.repo.nameWithOwner, permissions: { admin: perm === 'ADMIN', push: perm !== 'READ' } });
} else if (parts[3] === 'branches' && route.endsWith('/protection')) {
  if (!fixture.protected) process.exit(1);
  out({});
} else if (parts[3] === 'pulls' && parts.length === 4) {
  const head = params.get('head');
  if (head) out(all.filter(({ p }) => `${parts[1]}:${p.headRefName}` === head).map((x) => x.rest));
  else out((params.get('state') === 'open' ? open : params.get('state') === 'closed' ? merged : all).map((x) => x.rest));
} else if (parts[3] === 'pulls' && parts.length === 5) {
  const found = all.find(({ p }) => String(p.number) === parts[4]);
  if (!found) process.exit(1);
  out(found.rest);
} else if (parts[3] === 'pulls' && parts[5] === 'files') {
  const found = all.find(({ p }) => String(p.number) === parts[4]);
  out((found?.p.files ?? []).map((f) => ({ filename: f.path ?? f })));
} else if (parts[3] === 'commits' && parts[5] === 'check-runs') {
  const ref = parts[4];
  let checks;
  if (ref === 'main') checks = (fixture.mainChecks ?? []).map((name) => ({ name, bucket: 'pass' }));
  else {
    const pr = all.find(({ p }) => sha(p) === ref);
    checks = pr ? fixture.checks?.[pr.p.number] ?? [] : [];
  }
  const toRun = ({ name, bucket }) =>
    bucket === 'pending'
      ? { name, status: 'in_progress', conclusion: null }
      : { name, status: 'completed', conclusion: { pass: 'success', fail: 'failure', skipping: 'skipped', cancel: 'cancelled' }[bucket] };
  out({ check_runs: checks.map(toRun) });
} else if (parts[3] === 'commits' && parts[5] === 'status') {
  out({ statuses: parts[4] === 'main' ? (fixture.mainStatuses ?? []).map((context) => ({ context, state: 'success' })) : [] });
} else {
  process.exit(1);
}
