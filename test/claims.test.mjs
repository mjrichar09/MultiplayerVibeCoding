import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';
import { parseFrontmatter } from '../scripts/lib/state.mjs';
import { parseGhMerge } from '../scripts/lib/hooks.mjs';

async function setup(names = ['alice', 'bob', 'carol']) {
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

const claimFile = (m, id) => path.join(m.cwd, '.multiplayer', 'claims', `${id}.md`);
const readClaim = (m, id) => parseFrontmatter(readFileSync(claimFile(m, id), 'utf8')).data;
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const edit = (m, file, session = 's1') =>
  m.hook('pre-tool-use', { session_id: session, tool_name: 'Edit', tool_input: { file_path: path.join(m.cwd, file) } });

test('claims show up in teammates\' briefings, grouped by person', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;

  await alice.git('checkout', '-q', '-b', 'feat/checkout');
  const r = await ok(alice.run(['claim', '--task', 'Redo checkout flow', '--paths', 'src/checkout/**,src/api/payments.ts', '--issue', '#142']));
  assert.match(r.stdout, /Claimed "redo-checkout-flow" for alice: Redo checkout flow \[src\/checkout\/\*\*, src\/api\/payments.ts\] on feat\/checkout/);
  await ok(bob.run(['claim', '--task', 'Fix refunds', '--paths', 'src/refunds/**']));
  await ok(bob.run(['claim', '--task', 'Update docs', '--paths', 'docs/']));

  const c = await carol.hook('session-start');
  const ctx = context(c);
  assert.match(ctx, /you are carol · teammates \(2\): alice, bob/);
  assert.match(ctx, /You have no active claims/);
  assert.match(ctx, /bob \(2\):\n  - update-docs: Update docs \[docs\/\*\*\][^\n]*\n  - fix-refunds/);
  assert.match(ctx, /alice \(1\):\n  - redo-checkout-flow: Redo checkout flow \[src\/checkout\/\*\*, src\/api\/payments.ts\] \(feat\/checkout, #142/);
  assert.match(ctx, /How to work with your team/);
});

test('claiming overlapping paths warns about every overlapping teammate', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/checkout/**']));
  await ok(bob.run(['claim', '--task', 'Cart totals', '--paths', 'src/checkout/cart.ts']));
  await ok(bob.run(['claim', '--task', 'Docs', '--paths', 'docs/**']));

  const r = await ok(carol.run(['claim', '--task', 'Checkout styles', '--paths', 'src/checkout/styles.css,src/**/*.ts']));
  assert.match(r.stdout, /⚠️ Overlaps alice's claim "checkout"/);
  assert.match(r.stdout, /⚠️ Overlaps bob's claim "cart-totals"/);
  assert.doesNotMatch(r.stdout, /docs/);
});

test('claiming again with the same slug extends the claim', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/checkout/**']));
  const r = await ok(alice.run(['claim', '--slug', 'checkout', '--paths', 'src/cart/totals.ts', '--keep']));
  assert.match(r.stdout, /Updated claim "checkout".*\[src\/checkout\/\*\*, src\/cart\/totals.ts\].*kept open after merge/);
  assert.equal(readClaim(alice, 'alice--checkout').keep, true);
});

test('release removes the claim and logs it to my history', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'One', '--paths', 'a/**']));
  await ok(alice.run(['claim', '--task', 'Two', '--paths', 'b/**']));

  const ambiguous = await alice.run(['release']);
  assert.equal(ambiguous.status, 1);
  assert.match(ambiguous.stderr, /Which claim\? Yours: one, two/);

  const r = await ok(alice.run(['release', 'one', '--outcome', 'done, no PR needed']));
  assert.match(r.stdout, /Released "one"/);
  assert.equal(existsSync(claimFile(alice, 'alice--one')), false);
  assert.match(readFileSync(path.join(alice.cwd, '.multiplayer', 'history', 'alice.md'), 'utf8'), /\*\*one\*\* — One — done, no PR needed/);

  const status = await ok(bob.run(['status']));
  assert.doesNotMatch(status.stdout, /- one:/);
  assert.match(status.stdout, /- two: Two/);
});

test('editing a teammate\'s claimed file warns once per file, naming every teammate', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/checkout/**']));
  await ok(bob.run(['claim', '--task', 'Payments', '--paths', 'src/checkout/pay.ts']));
  await ok(carol.run(['claim', '--task', 'Styles', '--paths', 'src/checkout/**']));
  await carol.git('-C', '.multiplayer', 'pull', '-q', '--rebase');

  const first = await edit(carol, 'src/checkout/pay.ts');
  assert.equal(first.status, 0);
  assert.equal(first.json.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(first.json.hookSpecificOutput.permissionDecision, undefined); // warn, never block
  assert.match(context(first), /⚠️ multiplayer: alice \(claim "checkout".*\) and bob \(claim "payments".*\) are working on src\/checkout\/pay.ts/);
  assert.doesNotMatch(context(first), /none of your claims/);

  const again = await edit(carol, 'src/checkout/pay.ts');
  assert.equal(again.stdout, '');
  const newSession = await edit(carol, 'src/checkout/pay.ts', 's2');
  assert.match(context(newSession), /alice/);
});

test('editing an unclaimed file nudges to claim, once per directory per session', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/checkout/**']));

  assert.equal((await edit(alice, 'src/checkout/a.ts')).stdout, '');
  assert.match(context(await edit(alice, 'src/api/x.ts')), /none of your claims covers src\/api\/x.ts.*multiplayer:claim/);
  assert.equal((await edit(alice, 'src/api/y.ts')).stdout, '');
  assert.match(context(await edit(alice, 'lib/z.ts')), /none of your claims covers lib\/z.ts/);
  assert.equal((await edit(alice, '.multiplayer/claims/x.md')).stdout, '');
  assert.equal((await edit(alice, '../elsewhere.ts')).stdout, '');
});

test('merging a PR with gh releases my claims on that branch, except kept ones', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await alice.git('checkout', '-q', '-b', 'feat/x');
  await ok(alice.run(['claim', '--task', 'Part one', '--paths', 'a/**']));
  await ok(alice.run(['claim', '--task', 'Big task', '--paths', 'b/**', '--keep']));
  await alice.git('checkout', '-q', '-b', 'feat/y');
  await ok(alice.run(['claim', '--task', 'Other', '--paths', 'c/**']));

  const merge = (command) => alice.hook('post-tool-use', { tool_name: 'Bash', tool_input: { command } });

  await team.setPrs({ open: [{ number: 12, headRefName: 'feat/x' }] });
  assert.equal((await merge('gh pr merge 12 --squash --auto')).stdout, ''); // not merged yet
  assert.equal((await merge('npm test')).stdout, '');

  await team.setPrs({ merged: [{ number: 12, headRefName: 'feat/x', mergedAt: new Date().toISOString() }] });
  const r = await merge('gh pr merge 12 --squash --delete-branch && git checkout main');
  assert.match(r.json.systemMessage, /released "part-one" \(PR #12 merged\)/);
  assert.equal(existsSync(claimFile(alice, 'alice--part-one')), false);
  assert.equal(existsSync(claimFile(alice, 'alice--big-task')), true);
  assert.equal(existsSync(claimFile(alice, 'alice--other')), true);

  const status = await ok(bob.run(['status']));
  assert.doesNotMatch(status.stdout, /part-one/);
  assert.match(readFileSync(path.join(alice.cwd, '.multiplayer', 'history', 'alice.md'), 'utf8'), /part-one.*merged in #12/);
});

test('merging through the GitHub MCP tool also releases', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await alice.git('checkout', '-q', '-b', 'feat/mcp');
  await ok(alice.run(['claim', '--task', 'Via MCP', '--paths', 'm/**']));
  await team.setPrs({ merged: [{ number: 7, headRefName: 'feat/mcp' }] });
  const r = await alice.hook('post-tool-use', {
    tool_name: 'mcp__github__merge_pull_request',
    tool_input: { owner: 'acme', repo: 'app', pullNumber: 7 },
  });
  assert.match(r.json.systemMessage, /released "via-mcp"/);
});

test('PRs merged outside Claude are released at the owner\'s next session start', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await alice.git('checkout', '-q', '-b', 'feat/web');
  await ok(alice.run(['claim', '--task', 'Web merge', '--paths', 'w/**']));
  await team.setPrs({ merged: [{ number: 31, headRefName: 'feat/web', mergedAt: new Date(Date.now() + 1000).toISOString() }] });

  // Bob sees it flagged (and it no longer counts as an overlap) before Alice releases it.
  const b = await bob.hook('session-start');
  assert.match(context(b), /web-merge: Web merge[^\n]*PR #31 merged/);
  await ok(bob.run(['claim', '--task', 'Mine', '--paths', 'w/**']));
  const noWarn = await edit(bob, 'w/file.ts');
  assert.equal(noWarn.stdout, '');

  const a = await alice.hook('session-start');
  assert.match(a.json.systemMessage, /released your claim "web-merge" \(PR #31 merged\)/);
  assert.match(context(a), /Just now: released your claim "web-merge"/);
  assert.equal(existsSync(claimFile(alice, 'alice--web-merge')), false);
});

test('an old merged PR from a reused branch name does not release a new claim', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await alice.git('checkout', '-q', '-b', 'fix');
  await team.setPrs({ merged: [{ number: 2, headRefName: 'fix', mergedAt: '2020-01-01T00:00:00Z' }] });
  await ok(alice.run(['claim', '--task', 'New fix', '--paths', 'f/**']));
  await alice.hook('session-start');
  assert.equal(existsSync(claimFile(alice, 'alice--new-fix')), true);
});

test('stale claims can be taken over; the owner is told and their claim retires', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { bob, carol } = team.members;
  await ok(bob.run(['claim', '--task', 'Auth rewrite', '--paths', 'src/auth/**']));

  const early = await carol.run(['claim', '--takeover', 'bob--auth-rewrite']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /isn't stale yet \(stale after 3 days/);

  team.setNow(new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString());
  const s = await carol.hook('session-start');
  assert.match(context(s), /auth-rewrite: Auth rewrite[^\n]*STALE, no activity for 4d/);

  const r = await ok(carol.run(['claim', '--takeover', 'bob--auth-rewrite']));
  assert.match(r.stdout, /Took over "auth-rewrite" for carol: Auth rewrite \[src\/auth\/\*\*\].*supersedes bob--auth-rewrite/);
  assert.doesNotMatch(r.stdout, /Overlaps bob/);

  // The superseded claim no longer triggers warnings; warnings point at carol.
  await team.members.alice.git('-C', '.multiplayer', 'pull', '-q', '--rebase');
  const warn = await edit(team.members.alice, 'src/auth/login.ts');
  assert.match(context(warn), /carol \(claim "auth-rewrite"/);
  assert.doesNotMatch(context(warn), /bob/);

  const b = await bob.hook('session-start');
  assert.match(b.json.systemMessage, /carol took over your stale claim "auth-rewrite"/);
  assert.equal(existsSync(claimFile(bob, 'bob--auth-rewrite')), false);
  assert.match(readFileSync(path.join(bob.cwd, '.multiplayer', 'history', 'bob.md'), 'utf8'), /taken over by carol/);
});

test('session end records where I left off on my claims for the current branch', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await alice.git('checkout', '-q', '-b', 'feat/snap');
  await ok(alice.run(['claim', '--task', 'Snap', '--paths', 'src/**']));
  await mkdir(path.join(alice.cwd, 'src'), { recursive: true });
  await writeFile(path.join(alice.cwd, 'src', 'done.ts'), 'x\n');
  await alice.git('add', '.');
  await alice.git('commit', '-q', '-m', 'Add done.ts');
  await writeFile(path.join(alice.cwd, 'src', 'wip.ts'), 'y\n');

  const r = await alice.hook('session-end', { reason: 'exit' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');

  await bob.git('-C', '.multiplayer', 'pull', '-q', '--rebase');
  const c = readClaim(bob, 'alice--snap');
  assert.equal(c.leftOff.branch, 'feat/snap');
  assert.match(c.leftOff.commits[0], /Add done.ts/);
  assert.deepEqual(c.leftOff.uncommitted, ['src/wip.ts']);
});

test('the briefing stays within 40 lines for a big team', async (t) => {
  const names = ['alice', 'bob', 'carol', 'dan', 'erin', 'frank', 'gina', 'hank', 'ivy', 'jack'];
  const team = await setup(names);
  t.after(team.cleanup);
  await Promise.all(
    names.slice(1).map(async (n) => {
      for (const i of [1, 2, 3]) await ok(team.members[n].run(['claim', '--task', `${n} task ${i}`, '--paths', `${n}/${i}/**`]));
    }),
  );
  const r = await team.members.alice.hook('session-start');
  const lines = context(r).split('\n');
  assert.ok(lines.length <= 40, `briefing has ${lines.length} lines`);
  assert.match(context(r), /\+\d+ more claims from .* use the multiplayer:status skill/);
  assert.match(context(r), /How to work with your team/);

  const all = await ok(team.members.alice.run(['status']));
  assert.equal((all.stdout.match(/ task \d/g) ?? []).length, 27);
});

test('gh merge commands are parsed', () => {
  assert.deepEqual(parseGhMerge('gh pr merge 12 --squash'), { ref: '12', repo: undefined });
  assert.deepEqual(parseGhMerge('gh pr merge --squash -R acme/app 5'), { ref: '5', repo: 'acme/app' });
  assert.deepEqual(parseGhMerge('cd x && gh pr merge --merge'), { ref: undefined, repo: undefined });
  assert.deepEqual(parseGhMerge('gh pr merge --subject "x" https://github.com/a/b/pull/3'), { ref: 'https://github.com/a/b/pull/3', repo: undefined });
  assert.equal(parseGhMerge('gh pr view 3'), null);
});

test('the edit hook refreshes team state in the background', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(bob.run(['claim', '--task', 'Late claim', '--paths', 'late/**']));

  // Alice's copy is behind: the first edit can't know about bob's claim yet...
  const first = await edit(alice, 'late/a.ts');
  assert.doesNotMatch(context(first), /bob/);
  // ...but it started a background pull, so a later edit does.
  const deadline = Date.now() + 10_000;
  while (!existsSync(claimFile(alice, 'bob--late-claim')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.match(context(await edit(alice, 'late/b.ts')), /bob \(claim "late-claim"/);
});
