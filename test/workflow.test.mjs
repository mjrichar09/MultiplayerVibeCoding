import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';

async function setup(names = ['alice', 'bob']) {
  const team = await makeTeam(names);
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

async function commit(m, file, content, message) {
  await mkdir(path.dirname(path.join(m.cwd, file)), { recursive: true });
  await writeFile(path.join(m.cwd, file), content);
  await m.git('add', file);
  await m.git('commit', '-q', '-m', message);
}

/** A teammate lands a change on main (as a merged PR would). */
async function landOnMain(m, file, content, message) {
  await m.git('switch', '-q', 'main');
  await m.git('pull', '-q', '--ff-only', 'origin', 'main');
  await commit(m, file, content, message);
  await m.git('push', '-q', 'origin', 'HEAD:main');
}

/** Fetch main, retrying while the plugin's background refresh holds the ref lock. */
async function fetchMain(m) {
  for (let i = 0; ; i++) {
    try {
      return await m.git('fetch', '-q', 'origin', 'main');
    } catch (err) {
      if (i > 20 || !/cannot lock ref|\.lock/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

const branchOf = (m) => m.git('branch', '--show-current');
const log = (m, ref = 'HEAD') => m.git('log', '--format=%s', ref);
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const mergeInProgress = (m) => existsSync(path.join(m.cwd, '.git', 'MERGE_HEAD'));

test('claiming on main starts a task branch from the latest main', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');

  const r = await ok(alice.run(['claim', '--task', 'Redo checkout', '--paths', 'src/checkout/**']));
  assert.match(r.stdout, /Started branch alice\/redo-checkout from the latest default branch/);
  assert.match(r.stdout, /on alice\/redo-checkout/);
  assert.equal(await branchOf(alice), 'alice/redo-checkout');
  assert.match(await log(alice), /Bob lands b.ts/);
  assert.match(await log(alice, 'main'), /Bob lands b.ts/); // local main fast-forwarded too
  const upstream = await alice.git('config', '--get', 'branch.alice/redo-checkout.merge').catch(() => '');
  assert.equal(upstream, ''); // not tracking main
});

test('uncommitted work on main moves to the new task branch', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await writeFile(path.join(alice.cwd, 'README.md'), '# changed\n');
  await ok(alice.run(['claim', '--task', 'Docs tweak', '--paths', 'README.md']));
  assert.equal(await branchOf(alice), 'alice/docs-tweak');
  assert.match(await alice.git('status', '--porcelain'), /M README.md/);
});

test('claiming on a feature branch, or with --no-branch, keeps the current branch', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Stay on main', '--paths', 'x/**', '--no-branch']));
  assert.equal(await branchOf(alice), 'main');
  await alice.git('switch', '-q', '-c', 'my-feature');
  const r = await ok(alice.run(['claim', '--task', 'Feature work', '--paths', 'y/**']));
  assert.doesNotMatch(r.stdout, /Started branch/);
  assert.equal(await branchOf(alice), 'my-feature');
});

test('session start merges new main into a clean task branch', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Feature', '--paths', 'src/**']));
  await commit(alice, 'src/a.ts', 'a\n', 'Alice adds a.ts');
  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');

  const r = await alice.hook('session-start');
  assert.match(r.json.systemMessage, /merged the latest main into alice\/feature \(1 new commit\)/);
  assert.match(context(r), /Just now: merged the latest main/);
  assert.equal(await branchOf(alice), 'alice/feature');
  const subjects = await log(alice);
  assert.match(subjects, /Bob lands b.ts/);
  assert.match(subjects, /Alice adds a.ts/);
  assert.equal(await alice.git('status', '--porcelain'), '');
});

test('a conflicting update changes nothing and tells the agent', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Readme', '--paths', 'README.md']));
  await commit(alice, 'README.md', '# alice\n', 'Alice edits readme');
  const before = await alice.git('rev-parse', 'HEAD');
  await landOnMain(bob, 'README.md', '# bob\n', 'Bob edits readme');

  const r = await alice.hook('session-start');
  assert.match(r.json.systemMessage, /main has 1 new commit that conflict with alice\/readme in README.md\. Nothing was changed/);
  assert.equal(await alice.git('rev-parse', 'HEAD'), before);
  assert.equal(mergeInProgress(alice), false);
  assert.equal(await alice.git('status', '--porcelain'), '');
});

test('uncommitted changes postpone the update', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Wip', '--paths', 'src/**']));
  await commit(alice, 'src/a.ts', 'a\n', 'Alice adds a.ts');
  await writeFile(path.join(alice.cwd, 'src', 'a.ts'), 'a2\n');
  const before = await alice.git('rev-parse', 'HEAD');
  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');

  const r = await alice.hook('session-start');
  assert.match(r.json.systemMessage, /alice\/wip is 1 commit behind main and wasn't updated because of uncommitted changes/);
  assert.equal(await alice.git('rev-parse', 'HEAD'), before);
  assert.match(await alice.git('status', '--porcelain'), /M src\/a.ts/);
});

test('local main fast-forwards only when it has nothing of its own', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await ok(alice.run(['claim', '--task', 'One', '--paths', 'a/**']));
  // Carol has an unpushed commit on her local main.
  await commit(carol, 'c.txt', 'c\n', 'Carol local-only');
  await ok(carol.run(['claim', '--task', 'Two', '--paths', 'c/**', '--no-branch']));
  await carol.git('switch', '-q', '-c', 'carol/other');
  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');

  await alice.hook('session-start');
  assert.equal(await alice.git('rev-parse', 'main'), await alice.git('rev-parse', 'origin/main'));

  const carolMain = await carol.git('rev-parse', 'main');
  await carol.hook('session-start');
  assert.equal(await carol.git('rev-parse', 'main'), carolMain);
  assert.match(await log(carol, 'main'), /Carol local-only/);
});

test('mid-session, new main commits touching my claim prompt an update once', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Payments', '--paths', 'src/pay/**']));
  await alice.hook('session-start');
  const edit = (file) =>
    alice.hook('pre-tool-use', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(alice.cwd, file) } });

  await landOnMain(bob, 'docs/x.md', 'x\n', 'Unrelated docs');
  await fetchMain(alice);
  assert.equal((await edit('src/pay/a.ts')).stdout, '');

  await landOnMain(bob, 'src/pay/refund.ts', 'r\n', 'Bob changes refunds');
  await fetchMain(alice);
  const r = await edit('src/pay/a.ts');
  assert.match(context(r), /main has new changes to files in your claims \(src\/pay\/refund.ts\).*multiplayer:update/);
  assert.equal((await edit('src/pay/b.ts')).stdout, '');
});

test('update merges cleanly, or leaves conflicts in place for the agent', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Readme', '--paths', 'README.md,lib/**']));
  await commit(alice, 'README.md', '# alice\n', 'Alice edits readme');

  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');
  const clean = await ok(alice.run(['update']));
  assert.match(clean.stdout, /Merged 1 new commit from main into alice\/readme/);

  await landOnMain(bob, 'README.md', '# bob\n', 'Bob edits readme');
  const conflict = await alice.run(['update']);
  assert.equal(conflict.status, 2);
  assert.match(conflict.stdout, /conflicts in: README.md/);
  assert.match(conflict.stdout, /git merge --abort/);
  assert.equal(mergeInProgress(alice), true);
});

async function squashMergeOnGitHub(team, branch) {
  // Stand-in for GitHub's squash merge of a pushed branch.
  const gh = team.members.gh ?? (team.members.gh = await team.addClone('github-bot'));
  await gh.git('switch', '-q', 'main');
  await gh.git('pull', '-q', '--ff-only', 'origin', 'main');
  await gh.git('fetch', '-q', 'origin', branch);
  await gh.git('merge', '-q', '--squash', 'FETCH_HEAD');
  await gh.git('commit', '-q', '-m', `Squash ${branch}`);
  await gh.git('push', '-q', 'origin', 'HEAD:main');
}

test('after merging my PR, the agent lands back on an updated main', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feat', '--paths', 'src/**']));
  await commit(alice, 'src/f.ts', 'f\n', 'Alice adds f.ts');
  await alice.git('push', '-q', '-u', 'origin', 'alice/feat');
  const tip = await alice.git('rev-parse', 'HEAD');
  await squashMergeOnGitHub(team, 'alice/feat');
  await team.setPrs({ merged: [{ number: 5, headRefName: 'alice/feat', headRefOid: tip }] });

  const r = await alice.hook('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --squash' } });
  assert.match(r.json.systemMessage, /released "feat" \(PR #5 merged\); switched to main and deleted the merged branch alice\/feat/);
  assert.equal(await branchOf(alice), 'main');
  assert.match(await log(alice), /Squash alice\/feat/);
  assert.equal(await alice.git('branch', '--list', 'alice/feat'), '');
});

test('a merged branch with unpushed commits is kept', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feat', '--paths', 'src/**']));
  await commit(alice, 'src/f.ts', 'f\n', 'Alice adds f.ts');
  await alice.git('push', '-q', '-u', 'origin', 'alice/feat');
  const tip = await alice.git('rev-parse', 'HEAD');
  await commit(alice, 'src/g.ts', 'g\n', 'Alice adds g.ts after pushing');
  await squashMergeOnGitHub(team, 'alice/feat');
  await team.setPrs({ merged: [{ number: 5, headRefName: 'alice/feat', headRefOid: tip }] });

  const r = await alice.hook('post-tool-use', { tool_name: 'Bash', tool_input: { command: 'gh pr merge 5' } });
  assert.match(r.json.systemMessage, /kept branch alice\/feat \(it has commits that were not part of the merged PR\)/);
  assert.equal(await branchOf(alice), 'alice/feat');
});

test('a PR merged on GitHub is cleaned up at the next session start', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Web', '--paths', 'src/**']));
  await commit(alice, 'src/w.ts', 'w\n', 'Alice adds w.ts');
  await alice.git('push', '-q', '-u', 'origin', 'alice/web');
  const tip = await alice.git('rev-parse', 'HEAD');
  await squashMergeOnGitHub(team, 'alice/web');
  await team.setPrs({
    merged: [{ number: 9, headRefName: 'alice/web', headRefOid: tip, mergedAt: new Date(Date.now() + 1000).toISOString() }],
  });

  const r = await alice.hook('session-start');
  assert.match(r.json.systemMessage, /released your claim "web" \(PR #9 merged\)/);
  assert.match(r.json.systemMessage, /switched to main and deleted the merged branch alice\/web/);
  assert.equal(await branchOf(alice), 'main');
  assert.match(await log(alice), /Squash alice\/web/);
});

// ---------------------------------------------------------------- merge

const recorded = (team, suffix) => {
  try {
    return JSON.parse(readFileSync(`${team.env.FAKE_GH_FIXTURE}.${suffix}.json`, 'utf8'));
  } catch {
    return [];
  }
};

test('multiplayer merge squash-merges a green PR, then releases the claim and lands on main', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feat', '--paths', 'src/**']));
  await commit(alice, 'src/f.ts', 'f\n', 'Alice adds f.ts');
  await alice.git('push', '-q', '-u', 'origin', 'alice/feat');
  const tip = await alice.git('rev-parse', 'HEAD');
  await team.setPrs({ open: [{ number: 5, title: 'Feat', headRefName: 'alice/feat', headRefOid: tip }], checks: { 5: [{ name: 'test', bucket: 'pass' }] } });
  await squashMergeOnGitHub(team, 'alice/feat'); // what GitHub does when it accepts the merge

  const r = await ok(alice.run(['merge']));
  assert.match(r.stdout, /Merged PR #5 \("Feat"\)\./);
  assert.match(r.stdout, /released "feat" \(PR #5 merged\); switched to main and deleted the merged branch alice\/feat/);
  assert.deepEqual(recorded(team, 'merges'), [{ url: 'repos/acme/app/pulls/5/merge', merge_method: 'squash', sha: tip }]);
  assert.deepEqual(recorded(team, 'deleted'), ['repos/acme/app/git/refs/heads/alice/feat']);
  assert.equal(await branchOf(alice), 'main');
});

test('multiplayer merge refuses red, running, or missing checks and unpushed work', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feat', '--paths', 'src/**']));
  await commit(alice, 'src/f.ts', 'f\n', 'Alice adds f.ts');
  await alice.git('push', '-q', '-u', 'origin', 'alice/feat');
  const tip = await alice.git('rev-parse', 'HEAD');
  const pr = { number: 5, headRefName: 'alice/feat', headRefOid: tip };
  const tryMerge = async (fixture, args = ['merge', '5']) => {
    await team.setPrs({ open: [pr], ...fixture });
    return alice.run(args);
  };

  const red = await tryMerge({ checks: { 5: [{ name: 'test', bucket: 'fail' }] } });
  assert.notEqual(red.status, 0);
  assert.match(red.stderr, /Not merging PR #5: failing checks: test/);
  assert.match((await tryMerge({ checks: { 5: [{ name: 'test', bucket: 'pending' }] } })).stderr, /still running \(test\)/);
  assert.match((await tryMerge({ checks: {} })).stderr, /PR #5 has no checks.*--tested/);
  assert.equal(recorded(team, 'merges').length, 0);

  assert.match(
    (await tryMerge({ checks: { 5: [{ name: 'test', bucket: 'pass' }] }, mergeError: 'At least 1 approving review is required' })).stderr,
    /GitHub refused to merge PR #5: At least 1 approving review is required/,
  );

  await commit(alice, 'src/g.ts', 'g\n', 'Not pushed yet');
  assert.match((await tryMerge({ checks: { 5: [{ name: 'test', bucket: 'pass' }] } })).stderr, /doesn't match PR #5 on GitHub\. Push/);

  await alice.git('reset', '-q', '--hard', tip);
  await ok(tryMerge({ checks: {} }, ['merge', '5', '--tested']));
  assert.equal(recorded(team, 'merges').length, 1);
});
