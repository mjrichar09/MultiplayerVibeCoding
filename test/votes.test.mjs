import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam } from './helpers/team.mjs';
import { tally } from '../scripts/lib/votes.mjs';

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
const json = (v) => JSON.stringify(v);

const DECIDE = {
  kind: 'decide',
  title: 'Up-front decisions',
  questions: [
    { id: 'engine', text: 'Which engine?', options: [{ label: 'Godot' }, { label: 'Unity' }] },
    { id: 'art', text: 'Art style?', options: [{ label: 'Low poly' }, { label: 'Pixel' }] },
    { id: 'name', text: 'Working title?', options: [{ label: 'Tailwhip Tag' }, { label: 'Scoot' }] },
  ],
};

test('a decision check stays sealed until the last ballot, then counts itself', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const opened = await ok(alice.run(['vote', 'open'], { input: json(DECIDE) }));
  const id = /\[(.+)\]/.exec(opened.stdout)[1];
  assert.match(opened.stdout, /Voters: alice, bob\./);

  const first = await ok(
    alice.run(['vote', 'cast', id], {
      input: json({ answers: { engine: { choice: 'Godot' }, art: { choice: 'Low poly' }, name: { choice: 'Other', other: 'Tailwhip' } }, note: 'Keen to start' }),
    }),
  );
  assert.match(first.stdout, /Still waiting on bob\./);

  // Bob can see the questions but not Alice's answers.
  const shown = JSON.parse((await ok(bob.run(['vote', 'show', id]))).stdout);
  assert.deepEqual(Object.keys(shown.ballots), []);
  assert.deepEqual(shown.waitingOn, ['bob']);
  assert.match(context(await bob.hook('session-start')), /Decision check: "Up-front decisions" \(alice\) — waiting on you/);

  const last = await ok(
    bob.run(['vote', 'cast', id], { input: json({ answers: { engine: { choice: 'Godot' }, art: { choice: 'Pixel' }, name: { choice: 'Tailwhip Tag' } } }) }),
  );
  assert.match(last.stdout, /That was the last ballot, so the vote is counted/);
  const counted = JSON.parse(last.stdout.slice(last.stdout.indexOf('{')));
  assert.deepEqual(
    counted.results.questions.map((q) => [q.id, q.status]),
    [
      ['engine', 'agreed'],
      ['art', 'differ'],
      ['name', 'review'],
    ],
  );
  assert.deepEqual(Object.keys(counted.ballots), ['alice', 'bob']); // unsealed once counted
  assert.match(context(await alice.hook('session-start')), /counted — 1 agreed, 2 to talk out; record the outcome/);

  await ok(alice.run(['vote', 'close', id, '--decision', 'd1', '--outcome', 'Godot; art and title talked out']));
  assert.equal((await ok(bob.run(['vote', 'list']))).stdout.trim(), 'No open votes.');
});

test('ballots are checked, and only voters can vote', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, carol } = team.members;
  const opened = await ok(alice.run(['vote', 'open'], { input: json({ ...DECIDE, voters: ['alice', 'bob'] }) }));
  const id = /\[(.+)\]/.exec(opened.stdout)[1];
  assert.match((await carol.run(['vote', 'cast', id], { input: '{}' })).stderr, /not a voter/);
  assert.match((await alice.run(['vote', 'cast', id], { input: json({ answers: { engine: { choice: 'Godot' } } }) })).stderr, /No answer for art/);
  assert.match(
    (await alice.run(['vote', 'cast', id], { input: json({ answers: { engine: { choice: 'Rust' }, art: { choice: 'Pixel' }, name: { choice: 'Scoot' } } }) })).stderr,
    /"Rust" isn't an option/,
  );
  assert.match((await alice.run(['vote', 'open'], { input: json({ kind: 'decide', title: 'x', voters: ['zed'], questions: DECIDE.questions }) })).stderr, /Not on the team: zed/);
});

test('an escalation tops every teammate\'s briefing and shows on the team board', async (t) => {
  const team = await setup(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(
    alice.run(['escalate'], {
      input: json({ title: 'Ship the demo Friday or next week?', questions: [{ id: 'q1', text: 'When do we ship the demo?', options: [{ label: 'Friday' }, { label: 'Next week' }] }] }),
    }),
  );
  const brief = context(await bob.hook('session-start'));
  assert.match(brief.split('\n').slice(0, 4).join('\n'), /🔔 Decision needed: "Ship the demo Friday or next week\?" \(alice\) — waiting on you and alice, carol\. Ask the user to answer it now/);

  const board = JSON.parse((await ok(bob.run(['board', '--json']))).stdout);
  assert.deepEqual(board.votes.map((v) => [v.urgent, v.waitingOn]), [[true, ['alice', 'bob', 'carol']]]);
  await bob.git('fetch', '-q', 'origin', 'multiplayer-state');
  assert.match(await bob.git('show', 'origin/multiplayer-state:README.md'), /## Open votes\n\n- 🔔 Decision needed: Ship the demo Friday or next week\? \(alice\) — waiting on alice, bob, carol/);
});

test('pitches reach teammates\' briefings', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['pitch'], { input: 'Night market\nA cosy trading game set in a floating night market. See mockups/night.svg.' }));
  assert.match(context(await bob.hook('session-start')), /New pitches:\n- "Night market" — alice/);
  const all = JSON.parse((await ok(bob.run(['pitches', '--json']))).stdout);
  assert.equal(all[0].body, 'A cosy trading game set in a floating night market. See mockups/night.svg.');
  assert.match((await alice.run(['pitch'], { input: 'Just a name' })).stderr, /more than a name/);
});

// ---------------------------------------------------------------- pick tally

const pickVote = (ballots) => ({
  kind: 'pick',
  voters: Object.keys(ballots),
  waitingOn: [],
  options: ['A', 'B', 'C', 'D'].map((name, i) => ({ id: String(i + 1), name })),
  ballots: Object.fromEntries(Object.entries(ballots).map(([u, b]) => [u, { user: u, ...b }])),
});

test('a pick vote scores feelings plus ranks and shortlists the top two', () => {
  const r = tally(
    pickVote({
      alice: { feelings: { 1: 'love', 2: 'like', 3: 'unsure', 4: 'no' }, top: ['1', '2', '3'], veto: null },
      bob: { feelings: { 1: 'like', 2: 'love', 3: 'like', 4: 'unsure' }, top: ['2', '1', '3'], veto: null },
    }),
  );
  // A and B both score 10 (feelings 3+2, ranks 3+2): tied, but both make the top two.
  assert.deepEqual(r.shortlist.sort(), ['1', '2']);
  assert.equal(r.rows.find((x) => x.id === '3').total, 1 + 1 + 2 + 1);
  assert.deepEqual(r.tiedAtCutoff, []);
});

test('a tie for second place goes to the team', () => {
  const r = tally(
    pickVote({
      alice: { feelings: { 1: 'love', 2: 'like', 3: 'like', 4: 'no' }, top: ['1', '2', '3'], veto: null },
      bob: { feelings: { 1: 'love', 2: 'like', 3: 'like', 4: 'no' }, top: ['1', '3', '2'], veto: null },
    }),
  );
  assert.equal(r.shortlist[0], '1');
  assert.deepEqual(r.tiedAtCutoff.sort(), ['2', '3']);
  assert.ok(r.rows.find((x) => x.id === '1').unanimousFirst);
});

test('a veto drops an option unless someone else ranked it first', () => {
  const r = tally(
    pickVote({
      alice: { feelings: { 1: 'love', 2: 'like', 3: 'no', 4: 'like' }, top: ['1', '2', '4'], veto: '3' },
      bob: { feelings: { 1: 'no', 2: 'like', 3: 'love', 4: 'like' }, top: ['3', '2', '4'], veto: '1' },
      carol: { feelings: { 1: 'like', 2: 'love', 3: 'like', 4: 'unsure' }, top: ['2', '4', '1'], veto: '4' },
    }),
  );
  const row = (id) => r.rows.find((x) => x.id === id);
  assert.equal(row('1').vetoState, 'disputed'); // bob vetoed it, alice ranked it first
  assert.equal(row('3').vetoState, 'disputed');
  assert.equal(row('4').vetoState, 'out');
  assert.ok(!r.shortlist.includes('4'));
  assert.equal(r.shortlist[0], '2');
});
