import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';

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
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const branchOf = (m) => m.git('branch', '--show-current');

const ADR = '## Context\nTotals drift between client and server.\n## Decision\nCompute totals on the server.\n## Consequences\nClients display server totals only.\n## Alternatives\nShared library — rejected, two runtimes.\n';

test('decisions reach every teammate once, and can be superseded', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await bob.hook('session-start');

  const r = await ok(alice.run(['decide', '--title', 'Compute cart totals on the server'], { input: ADR }));
  assert.match(r.stdout, /Recorded decision "Compute cart totals on the server" \[\d{8}-\d{6}--alice--compute-cart-totals-on-the-server\]/);
  const id = r.stdout.match(/\[(.+?)\]/)[1];
  assert.match(readFileSync(path.join(alice.cwd, '.multiplayer', 'decisions', `${id}.md`), 'utf8'), /## Alternatives/);

  const b1 = await bob.hook('session-start');
  assert.match(context(b1), /New team decisions[^\n]*\n- Compute cart totals on the server — alice/);
  const b2 = await bob.hook('session-start');
  assert.doesNotMatch(context(b2), /Compute cart totals/); // only new ones

  const a = await alice.hook('session-start');
  assert.doesNotMatch(context(a), /New team decisions/); // not my own

  await ok(alice.run(['decide', '--title', 'Compute totals in a shared module', '--supersedes', id], { input: ADR }));
  const s = await ok(carol.run(['status']));
  assert.match(s.stdout, /Compute totals in a shared module — alice.*\(replaces an earlier decision\)/);
  assert.doesNotMatch(s.stdout, /Compute cart totals on the server/);

  const bad = await alice.run(['decide', '--title', 'X', '--supersedes', 'nope'], { input: ADR });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /No decision "nope"/);
});

test('notes reach teammates and age out', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await ok(alice.run(['note', 'Staging DB is down; use local fixtures']));
  await ok(carol.run(['note'], { input: 'Flaky test: checkout.spec.ts\nRetry once before debugging.\n' }));

  const b = await bob.hook('session-start');
  assert.match(context(b), /Team notes:\n- carol \([^)]*\): Flaky test: checkout.spec.ts\n- alice \([^)]*\): Staging DB is down/);
  assert.doesNotMatch(context(await alice.hook('session-start')), /Staging DB/);

  team.setNow(new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString());
  assert.doesNotMatch(context(await bob.hook('session-start')), /Team notes/);
});

test('a handoff moves the claim and branch to the recipient', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  await ok(alice.run(['claim', '--task', 'Redo checkout', '--paths', 'src/checkout/**']));
  await writeFile(path.join(alice.cwd, 'checkout.txt'), 'wip\n');
  await alice.git('add', '.');
  await alice.git('commit', '-q', '-m', 'Checkout WIP');

  const notes = '## What changed\nNew checkout layout.\n## Next steps\n1. Wire up payments\n## Gotchas\nRun with STRIPE_TEST_MODE=1\n';
  const r = await ok(alice.run(['handoff', '--to', 'bob'], { input: notes }));
  assert.match(r.stdout, /Handed off "Redo checkout" to bob, with your claim "redo-checkout" on branch alice\/redo-checkout \(pushed\)/);
  assert.match(await alice.git('ls-remote', '--heads', 'origin', 'alice/redo-checkout'), /alice\/redo-checkout/);

  // Teammates see the pending handoff; the recipient's next session accepts it.
  const c = await carol.hook('session-start');
  assert.match(context(c), /redo-checkout: Redo checkout[^\n]*handing off to bob/);
  assert.doesNotMatch(context(c), /📨/);

  const b = await bob.hook('session-start');
  assert.match(b.json.systemMessage, /accepted alice's handoff "redo-checkout"/);
  assert.match(context(b), /switched to alice's branch alice\/redo-checkout/);
  assert.match(context(b), /📨 Handoff from alice[^\n]*: Redo checkout — branch alice\/redo-checkout\n    ## What changed\n    New checkout layout\./);
  assert.match(context(b), /Your claims:\n- redo-checkout: Redo checkout \[src\/checkout\/\*\*\] \(alice\/redo-checkout[^\n]*handed over by alice/);
  assert.equal(await branchOf(bob), 'alice/redo-checkout');
  assert.ok(existsSync(path.join(bob.cwd, 'checkout.txt')));

  assert.doesNotMatch(context(await bob.hook('session-start')), /📨/); // read once

  const a = await alice.hook('session-start');
  assert.match(a.json.systemMessage, /bob accepted your handoff of "redo-checkout"/);
  assert.match(readFileSync(path.join(alice.cwd, '.multiplayer', 'history', 'alice.md'), 'utf8'), /handed off to bob/);

  // Warnings now point at bob.
  await carol.git('-C', '.multiplayer', 'pull', '-q', '--rebase');
  const warn = await carol.hook('pre-tool-use', {
    session_id: 'c1',
    tool_name: 'Edit',
    tool_input: { file_path: path.join(carol.cwd, 'src/checkout/x.ts') },
  });
  assert.match(context(warn), /bob \(claim "redo-checkout"/);
  assert.doesNotMatch(context(warn), /alice \(claim/);
});

test('a handoff waits for a busy recipient instead of switching branches', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(bob.run(['claim', '--task', 'Bob own work', '--paths', 'b/**']));
  await ok(alice.run(['claim', '--task', 'Feature', '--paths', 'f/**']));
  const r = await ok(alice.run(['handoff', '--to', 'bob', '--body', '## Next steps\n1. Finish it']));
  assert.match(r.stdout, /on branch alice\/feature/);

  const b = await bob.hook('session-start');
  assert.match(context(b), /alice's work is on branch alice\/feature; switch to it when ready \(not switched: you're on bob\/bob-own-work\)/);
  assert.equal(await branchOf(bob), 'bob/bob-own-work');
  assert.match(context(b), /- feature: Feature/);
});

test('handoffs are validated', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Feature', '--paths', 'f/**']));

  const unknown = await alice.run(['handoff', '--to', 'zed', '--body', 'x']);
  assert.match(unknown.stderr, /"zed" isn't on the team. Teammates: bob/);
  const self = await alice.run(['handoff', '--to', 'alice', '--body', 'x']);
  assert.match(self.stderr, /can't hand work to yourself/);
  const empty = await alice.run(['handoff', '--to', 'bob', '--body', '']);
  assert.match(empty.stderr, /needs notes/);

  await writeFile(path.join(alice.cwd, 'README.md'), 'dirty\n');
  const dirty = await alice.run(['handoff', '--to', 'bob', '--body', 'x']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Commit your changes before handing off \(README.md\)/);
});

test('read state is per clone', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const bob2 = await team.addClone('bob', { dir: 'bob-laptop' });
  await ok(bob2.run(['init']));
  await ok(alice.run(['claim', '--task', 'Feature', '--paths', 'f/**']));
  await ok(alice.run(['handoff', '--to', 'bob', '--body', '## Next steps\n1. Ship it']));

  assert.match(context(await bob.hook('session-start')), /📨 Handoff from alice/);
  const other = await bob2.hook('session-start');
  assert.match(context(other), /📨 Handoff from alice/); // still unread on the laptop
  assert.doesNotMatch(other.json?.systemMessage ?? '', /couldn't accept/); // already accepted elsewhere
});

test('the briefing keeps handoffs first and stays within 40 lines', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;
  for (let i = 0; i < 12; i++) await ok(carol.run(['decide', '--title', `Decision ${i}`, '--body', 'b']));
  for (let i = 0; i < 12; i++) await ok(carol.run(['note', `Note ${i}`]));
  for (let i = 0; i < 12; i++) await ok(bob.run(['claim', '--task', `Task ${i}`, '--paths', `t${i}/**`, '--no-branch']));
  await ok(bob.run(['handoff', '--to', 'alice', '--claim', 'task-0', '--body', '## Next steps\n1. Do it']));

  const ctx = context(await alice.hook('session-start'));
  const lines = ctx.split('\n');
  assert.ok(lines.length <= 40, `briefing has ${lines.length} lines`);
  assert.match(lines[1] + lines[2], /📨 Handoff from bob/);
  assert.match(ctx, /New team decisions/);
  assert.match(ctx, /\+\d+ more (decisions|notes|claims|teammate claims)/);
  assert.match(ctx, /How to work with your team/);
});
