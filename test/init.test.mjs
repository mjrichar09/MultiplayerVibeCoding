import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';
import { parseFrontmatter, formatFrontmatter } from '../scripts/lib/state.mjs';
import { slugify } from '../scripts/lib/identity.mjs';

const stateFiles = async (member, sub) => {
  await member.git('-C', '.multiplayer', 'pull', '--quiet', '--rebase');
  const dir = path.join(member.cwd, '.multiplayer', sub);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

test('creator sets up the team; others join in any order', async (t) => {
  const team = await makeTeam(['alice', 'bob', 'carol']);
  t.after(team.cleanup);
  const { alice, bob, carol } = team.members;

  const notSetUp = await bob.run(['init']);
  assert.equal(notSetUp.status, 1);
  assert.match(notSetUp.stderr, /isn't set up/);

  const created = await alice.run(['init', '--create']);
  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Created the team as "alice"/);

  const c = await carol.run(['init']);
  assert.match(c.stdout, /Joined the team as "carol"/);
  const b = await bob.run(['init']);
  assert.match(b.stdout, /Joined the team as "bob"/);
  assert.match(b.stdout, /Members \(3\): alice, bob, carol/);

  assert.deepEqual(await stateFiles(alice, 'members'), ['alice.json', 'bob.json', 'carol.json']);
  const config = JSON.parse(readFileSync(path.join(alice.cwd, '.multiplayer', 'multiplayer.config.json'), 'utf8'));
  assert.equal(config.staleClaimDays, 3);
  assert.equal(config.createdBy, 'alice');
});

test('init is idempotent', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await alice.run(['init', '--create']);
  const again = await alice.run(['init', '--create']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Already on the team/);
  const log = await alice.git('-C', '.multiplayer', 'log', '--oneline');
  assert.equal(log.split('\n').length, 2); // create + join, nothing more
});

test('the state worktree stays out of the main tree', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await alice.run(['init', '--create']);
  assert.equal(await alice.git('status', '--porcelain'), '');
  assert.equal(await alice.git('branch', '--show-current'), 'main');
  assert.equal(readFileSync(path.join(alice.cwd, '.multiplayer', '.gitignore'), 'utf8'), '.local/\n');
});

test('many members joining concurrently all land without conflicts', async (t) => {
  const names = ['alice', 'bob', 'carol', 'dan', 'erin', 'frank'];
  const team = await makeTeam(names);
  t.after(team.cleanup);
  const [creator, ...joiners] = names.map((n) => team.members[n]);
  await creator.run(['init', '--create']);

  const results = await Promise.all(joiners.map((m) => m.run(['init'])));
  for (const r of results) assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(await stateFiles(creator, 'members'), names.map((n) => `${n}.json`).sort());
});

test('two members creating at the same time end up on one team', async (t) => {
  const team = await makeTeam(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;

  const [a, b] = await Promise.all([alice.run(['init', '--create']), bob.run(['init', '--create'])]);
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const statuses = [a.stdout, b.stdout].map((s) => (/Created/.test(s) ? 'created' : 'joined')).sort();
  assert.deepEqual(statuses, ['created', 'joined']);
  assert.deepEqual(await stateFiles(alice, 'members'), ['alice.json', 'bob.json']);
  assert.deepEqual(await stateFiles(bob, 'members'), ['alice.json', 'bob.json']);
});

test('a second person with the same username is refused', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  await team.members.alice.run(['init', '--create']);
  const impostor = await team.addClone('alice', { email: 'other-alice@example.com', dir: 'alice2' });

  const r = await impostor.run(['init']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already belongs to alice@example.com.*MULTIPLAYER_USER/);

  const renamed = await impostor.run(['init'], { extraEnv: { MULTIPLAYER_USER: 'Alice B' } });
  assert.equal(renamed.status, 0, renamed.stderr);
  assert.match(renamed.stdout, /as "alice-b"/);
});

test('session start joins automatically when the team exists', async (t) => {
  const team = await makeTeam(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await alice.run(['init', '--create']);

  const first = await bob.hook('session-start');
  assert.equal(first.status, 0);
  assert.match(first.json.systemMessage, /joined team as bob \(2 members\)/);
  assert.match(first.json.hookSpecificOutput.additionalContext, /joined this repo's team as "bob"/);
  assert.equal(first.json.hookSpecificOutput.hookEventName, 'SessionStart');

  const second = await bob.hook('session-start');
  assert.equal(second.json.systemMessage, undefined);
  assert.match(second.json.hookSpecificOutput.additionalContext, /you are "bob".*Team: alice, bob/);
});

test('session start never creates a team, and offers setup only once', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;

  const first = await alice.hook('session-start');
  assert.match(first.json.hookSpecificOutput.additionalContext, /not set up.*Only if the user asks/);
  const second = await alice.hook('session-start');
  assert.equal(second.stdout, '');
  assert.equal(existsSync(path.join(alice.cwd, '.multiplayer')), false);
  const remoteBranches = await alice.git('ls-remote', '--heads', 'origin');
  assert.doesNotMatch(remoteBranches, /multiplayer-state/);
});

test('session start fails open when the remote is unreachable', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await alice.git('remote', 'set-url', 'origin', path.join(team.base, 'missing.git'));
  const r = await alice.hook('session-start');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('frontmatter round-trips', () => {
  const data = { task: 'redo: "checkout"', paths: ['src/**', 'a b.ts'], keep: false, n: 3 };
  const parsed = parseFrontmatter(formatFrontmatter(data, '## Notes\nhello'));
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, '## Notes\nhello\n');
});

test('usernames are slugified', () => {
  assert.equal(slugify('José  Núñez'), 'jose-nunez');
  assert.equal(slugify('  --Bob--  '), 'bob');
});
