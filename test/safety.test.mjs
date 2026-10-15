import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';

async function setup(names = ['alice', 'bob']) {
  const team = await makeTeam(names);
  await team.setPrs({ open: [], merged: [] });
  const [first, ...rest] = names.map((n) => team.members[n]);
  assert.equal((await first.run(['init', '--create'])).status, 0);
  for (const m of rest) assert.equal((await m.run(['init'])).status, 0);
  return team;
}

const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';

// --------------------------------------------------------------- merge guard

test('agents are warned before merging a PR whose checks are not green', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await team.setPrs({
    open: [1, 2, 3, 4].map((number) => ({ number, title: `PR ${number}`, headRefName: `bob/pr-${number}` })),
    merged: [],
    checks: {
      1: [{ name: 'test', bucket: 'fail' }, { name: 'lint', bucket: 'pass' }],
      2: [{ name: 'test', bucket: 'pending' }],
      3: [{ name: 'test', bucket: 'pass' }, { name: 'docs', bucket: 'skipping' }],
    },
  });
  const merge = (command) => alice.hook('pre-tool-use', { session_id: 's', tool_name: 'Bash', tool_input: { command } });

  const red = await merge('gh pr merge 1 --squash');
  assert.equal(red.json.hookSpecificOutput.permissionDecision, undefined); // warns, never blocks
  assert.match(context(red), /⚠️ multiplayer: don't merge PR #1: failing checks: test\./);
  assert.match(context(await merge('gh pr merge 2 --squash')), /checks on PR #2 are still running \(test\).*--auto/);
  assert.equal((await merge('gh pr merge 3 --squash')).stdout, '');
  assert.match(context(await merge('gh pr merge 4 --squash')), /PR #4 has no checks/);
  assert.equal((await merge('gh pr merge 1 --squash --auto')).stdout, ''); // GitHub enforces required checks
  assert.equal((await merge('git status')).stdout, '');

  const mcp = await alice.hook('pre-tool-use', {
    session_id: 's',
    tool_name: 'mcp__github__merge_pull_request',
    tool_input: { owner: 'acme', repo: 'app', pullNumber: 1 },
  });
  assert.match(context(mcp), /don't merge PR #1/);

  const noGh = await alice.hook('pre-tool-use', { session_id: 's', tool_name: 'Bash', tool_input: { command: 'gh pr merge 1' } }, { extraEnv: { MULTIPLAYER_GH: '/nonexistent' } });
  assert.equal(noGh.stdout, '');
});

test('the standing rules tell agents to merge only on green checks and how to revert', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const ctx = context(await team.members.alice.hook('session-start'));
  assert.match(ctx, /Once its checks pass, merge it with `multiplayer merge`/);
  assert.match(ctx, /multiplayer:revert/);
});

// ------------------------------------------------------------------ protect

const protection = (team) => JSON.parse(readFileSync(`${team.env.FAKE_GH_FIXTURE}.protection.json`, 'utf8'));

test('protect requires the default branch\'s checks and blocks force-pushes', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'ADMIN' }, mainChecks: ['test', 'lint'], mainStatuses: ['vercel'] });
  const r = await ok(alice.run(['protect']));
  assert.match(r.stdout, /Protected main on acme\/app: merging now requires these checks to pass: lint, test, vercel/);
  const p = protection(team);
  assert.equal(p.url, 'repos/acme/app/branches/main/protection');
  assert.deepEqual(p.body.required_status_checks, { strict: false, contexts: ['lint', 'test', 'vercel'] });
  assert.equal(p.body.allow_force_pushes, false);
  assert.equal(p.body.required_pull_request_reviews, null);

  await ok(alice.run(['protect', '--checks', 'ci/build']));
  assert.deepEqual(protection(team).body.required_status_checks.contexts, ['ci/build']);
});

test('protect explains what is missing instead of failing silently', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;

  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE' } });
  assert.match((await alice.run(['protect'])).stderr, /Only a repository admin can turn on branch protection for acme\/app/);

  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'ADMIN' }, mainChecks: [] });
  assert.match((await alice.run(['protect'])).stderr, /No checks have run on main yet.*Add CI/);

  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'ADMIN' }, mainChecks: ['test'], protectError: 'Upgrade to GitHub Pro or make this repository public to enable this feature.' });
  assert.match((await alice.run(['protect'])).stderr, /refused.*needs a paid GitHub plan/);

  assert.match((await alice.run(['protect'], { extraEnv: { MULTIPLAYER_GH: '/nonexistent' } })).stderr, /needs the GitHub CLI/);
});

// ------------------------------------------------------------------- revert

async function landOnMain(m, file, content, message) {
  await m.git('switch', '-q', 'main');
  await m.git('pull', '-q', '--ff-only', 'origin', 'main');
  await mkdir(path.dirname(path.join(m.cwd, file)), { recursive: true });
  await writeFile(path.join(m.cwd, file), content);
  await m.git('add', file);
  await m.git('commit', '-q', '-m', message);
  await m.git('push', '-q', 'origin', 'HEAD:main');
  return m.git('rev-parse', 'HEAD');
}

test('revert undoes a merged PR on a fresh branch and claims its files', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const sha = await landOnMain(bob, 'src/coupons.ts', 'coupons\n', 'Add coupon codes (#42)');
  await landOnMain(bob, 'docs/later.md', 'later\n', 'Unrelated later work');
  await team.setPrs({ merged: [{ number: 42, title: 'Add coupon codes', headRefName: 'bob/coupons', mergeCommit: { oid: sha } }] });
  await ok(alice.run(['claim', '--task', 'Own work', '--paths', 'x/**']));

  const r = await ok(alice.run(['revert', '42']));
  assert.match(r.stdout, /Reverted PR #42 \("Add coupon codes"\) on new branch alice\/revert-pr-42 \(claimed 1 file\)/);
  assert.match(r.stdout, /open a PR titled "Revert #42: Add coupon codes"/);
  assert.equal(await alice.git('branch', '--show-current'), 'alice/revert-pr-42');
  assert.equal(existsSync(path.join(alice.cwd, 'src', 'coupons.ts')), false);
  assert.ok(existsSync(path.join(alice.cwd, 'docs', 'later.md'))); // later work stays
  assert.match(await alice.git('log', '-1', '--format=%s'), /^Revert "Add coupon codes \(#42\)"/);
  assert.match((await ok(bob.run(['status']))).stdout, /revert-pr-42: Revert #42: Add coupon codes \[src\/coupons.ts\]/);
});

test('revert by commit id, and conflicts with later work are left for the agent', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const sha = await landOnMain(bob, 'src/coupons.ts', 'v1\n', 'Add coupons');
  await landOnMain(bob, 'src/coupons.ts', 'v2 built on v1\n', 'Extend coupons');

  const r = await alice.run(['revert', sha]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /Reverting [0-9a-f]{10} \("Add coupons"\) on alice\/revert-[0-9a-f]{7} conflicts with later changes in: src\/coupons.ts/);
  assert.match(r.stdout, /git revert --continue/);
  assert.ok(existsSync(path.join(alice.cwd, '.git', 'REVERT_HEAD')));
});

test('revert refuses unmerged PRs, unknown refs, and uncommitted work', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await team.setPrs({ open: [{ number: 7, title: 'WIP', headRefName: 'x' }], merged: [] });
  assert.match((await alice.run(['revert', '7'])).stderr, /PR #7 isn't merged/);
  assert.match((await alice.run(['revert', 'nope'])).stderr, /neither a PR number nor a commit/);
  await writeFile(path.join(alice.cwd, 'README.md'), 'dirty\n');
  assert.match((await alice.run(['revert', '7'])).stderr, /Commit your current work first \(README.md\)/);
});
