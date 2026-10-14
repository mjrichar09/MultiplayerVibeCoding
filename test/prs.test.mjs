import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const edit = (m, file, session = 's1', extraEnv) =>
  m.hook('pre-tool-use', { session_id: session, tool_name: 'Edit', tool_input: { file_path: path.join(m.cwd, file) } }, { extraEnv });
const openPr = (number, headRefName, files, extra = {}) => ({
  number,
  title: `PR ${number}`,
  headRefName,
  author: { login: `${headRefName.split('/')[0]}-gh` },
  files: files.map((p) => ({ path: p, additions: 1, deletions: 0 })),
  ...extra,
});

test('editing a file changed in a teammate\'s open PR warns, naming the PR', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Payments', '--paths', 'src/api/**']));
  await team.setPrs({ open: [openPr(7, 'bob/refunds', ['src/api/pay.ts', 'docs/x.md'], { title: 'Refunds' })] });
  await alice.hook('session-start'); // refreshes the PR cache

  const r = await edit(alice, 'src/api/pay.ts');
  assert.equal(r.json.hookSpecificOutput.permissionDecision, undefined);
  assert.match(context(r), /⚠️ multiplayer: bob \(open PR #7 "Refunds" changes it\) is working on src\/api\/pay.ts/);
  assert.equal((await edit(alice, 'src/api/pay.ts')).stdout, '');
  assert.equal((await edit(alice, 'src/api/other.ts')).stdout, '');
});

test('a teammate\'s claim and PR on the same file are reported together', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(bob.run(['claim', '--task', 'Refunds', '--paths', 'src/api/pay.ts']));
  await team.setPrs({ open: [openPr(7, 'bob/refunds', ['src/api/pay.ts'], { isDraft: true })] });
  await alice.hook('session-start');
  const r = await edit(alice, 'src/api/pay.ts');
  assert.match(context(r), /bob \(claim "refunds": Refunds, updated [^;]+; open draft PR #7 "PR 7" changes it\) is working on/);
});

test('PR owners are found by claim branch, branch prefix, or GitHub login', async (t) => {
  const team = await makeTeam(['alice', 'bob', 'carol', 'dan']);
  t.after(team.cleanup);
  await team.setPrs({ open: [], merged: [] });
  const { alice, bob, carol, dan } = team.members;
  await ok(alice.run(['init', '--create']));
  for (const m of [bob, carol]) await ok(m.run(['init']));
  await ok(dan.run(['init'], { extraEnv: { FAKE_GH_USER: 'Dan-GH' } }));
  assert.equal(JSON.parse(readFileSync(path.join(dan.cwd, '.multiplayer', 'members', 'dan.json'), 'utf8')).github, 'Dan-GH');

  await carol.git('switch', '-q', '-c', 'feature-x');
  await ok(carol.run(['claim', '--task', 'X', '--paths', 'x/**']));
  await team.setPrs({
    open: [
      openPr(1, 'feature-x', ['f/one.ts'], { author: { login: 'someone-else' } }),
      openPr(2, 'bob/thing', ['f/two.ts']),
      openPr(3, 'random-branch', ['f/three.ts'], { author: { login: 'dan-gh' } }),
      openPr(4, 'contrib', ['f/four.ts'], { author: { login: 'Stranger' } }),
      openPr(5, 'alice/mine', ['f/five.ts']),
    ],
  });
  await alice.hook('session-start');
  assert.match(context(await edit(alice, 'f/one.ts')), /carol \(open PR #1/);
  assert.match(context(await edit(alice, 'f/two.ts')), /bob \(open PR #2/);
  assert.match(context(await edit(alice, 'f/three.ts')), /dan \(open PR #3/);
  assert.match(context(await edit(alice, 'f/four.ts')), /@stranger \(open PR #4/);
  assert.doesNotMatch(context(await edit(alice, 'f/five.ts')), /PR #5/); // my own PR
});

test('the briefing lists teammates\' PRs that touch my claimed files', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Payments', '--paths', 'src/api/**']));
  await team.setPrs({
    open: [
      openPr(7, 'bob/refunds', ['src/api/pay.ts', 'src/api/a.ts', 'src/api/b.ts'], { title: 'Refunds' }),
      openPr(8, 'bob/docs', ['docs/x.md']),
    ],
  });
  const ctx = context(await alice.hook('session-start'));
  assert.match(ctx, /⚠️ Teammates' open PRs change files you've claimed[^\n]*\n- bob · PR #7 "Refunds": src\/api\/pay.ts, src\/api\/a.ts, \+1 more/);
  assert.doesNotMatch(ctx, /PR #8/);
});

test('claiming files that a teammate\'s open PR changes warns at claim time', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice } = team.members;
  await team.setPrs({ open: [openPr(7, 'bob/refunds', ['src/api/pay.ts'], { title: 'Refunds' })] });
  await alice.hook('session-start');
  const r = await ok(alice.run(['claim', '--task', 'Payments', '--paths', 'src/api/**']));
  assert.match(r.stdout, /⚠️ Overlaps bob's open PR #7 \(Refunds\), which changes src\/api\/pay.ts/);
});

test('PR data older than an hour is ignored', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice } = team.members;
  const cache = path.join(alice.cwd, '.git', 'multiplayer', 'gh-cache.json');
  const prs = { merged: [], open: [openPr(7, 'bob/refunds', ['src/api/pay.ts'])] };
  await mkdir(path.dirname(cache), { recursive: true });
  await mkdir(path.join(alice.cwd, '.multiplayer', '.local'), { recursive: true });
  await writeFile(cache, JSON.stringify({ fetchedAt: Date.now() - 2 * 60 * 60 * 1000, ...prs }));
  // Keep the background refresh from replacing the old cache during this test.
  await writeFile(path.join(alice.cwd, '.multiplayer', '.local', 'last-refresh.json'), JSON.stringify({ at: Date.now() }));
  assert.doesNotMatch(context(await edit(alice, 'src/api/pay.ts')), /PR #7/);
  await writeFile(cache, JSON.stringify({ fetchedAt: Date.now(), ...prs }));
  assert.match(context(await edit(alice, 'src/api/pay.ts', 's2')), /PR #7/);
});

test('without gh, or with broken gh output, everything still works', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice } = team.members;
  for (const extraEnv of [{ MULTIPLAYER_GH: '/nonexistent/gh' }, { FAKE_GH_GARBAGE: '1' }]) {
    const s = await alice.hook('session-start', {}, { extraEnv });
    assert.equal(s.status, 0);
    assert.match(context(s), /you are alice/);
    const c = await alice.run(['claim', '--task', `Work ${Object.keys(extraEnv)[0]}`, '--paths', 'w/**'], { extraEnv });
    assert.equal(c.status, 0, c.stderr);
    const e = await edit(alice, 'w/a.ts', 's1', extraEnv);
    assert.equal(e.status, 0);
    assert.equal((await alice.run(['status'], { extraEnv })).status, 0);
  }
});

test('GitHub repos are read from https and ssh remotes', async () => {
  const { parseGithubRepo } = await import('../scripts/lib/gh.mjs');
  assert.equal(parseGithubRepo('https://github.com/acme/app.git'), 'acme/app');
  assert.equal(parseGithubRepo('https://github.com/acme/app'), 'acme/app');
  assert.equal(parseGithubRepo('git@github.com:acme/my.app.git'), 'acme/my.app');
  assert.equal(parseGithubRepo('https://gitlab.com/acme/app.git'), null);
  assert.equal(parseGithubRepo('/tmp/remote.git'), null);
});

test('merging the current branch\'s PR (no number) releases its claim', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feat', '--paths', 'f/**']));
  await team.setPrs({ merged: [{ number: 9, headRefName: 'alice/feat' }] });
  const r = await alice.hook('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'gh pr merge --squash' } });
  assert.match(r.json.systemMessage, /released "feat" \(PR #9 merged\)/);
});
