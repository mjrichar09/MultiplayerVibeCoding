import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const read = (m, f) => readFileSync(path.join(m.cwd, f), 'utf8');
const ADR = (gist) => `## Context\nWhy.\n## Decision\n${gist}\n## Consequences\nSo.\n## Alternatives\nNone.\n`;

test('scaffold adds the team files on a setup branch', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  const r = await ok(alice.run(['scaffold']));
  assert.match(r.stdout, /CLAUDE.md: created\n\.claude\/settings.json: created\n\.github\/PULL_REQUEST_TEMPLATE.md: created\nCommitted on alice\/multiplayer-setup \(a new branch\)/);
  assert.equal(await alice.git('branch', '--show-current'), 'alice/multiplayer-setup');
  assert.equal(await alice.git('status', '--porcelain'), '');
  assert.equal(await alice.git('ls-tree', '--name-only', 'main', 'CLAUDE.md'), ''); // main untouched

  const md = read(alice, 'CLAUDE.md');
  assert.match(md, /^# alice\n/);
  assert.match(md, /## How we work \(multiplayer\)[\s\S]*started from the latest `main`/);
  assert.match(md, /## Team decisions\n<!-- multiplayer:decisions:start[^>]*-->\n_No team decisions recorded yet._\n<!-- multiplayer:decisions:end -->/);

  const settings = JSON.parse(read(alice, '.claude/settings.json'));
  assert.equal(settings.enabledPlugins['multiplayer@multiplayer-vibe-coding'], true);
  assert.deepEqual(settings.extraKnownMarketplaces['multiplayer-vibe-coding'].source, { source: 'github', repo: 'mjrichar09/MultiplayerVibeCoding' });
  const skills = readdirSync(path.join(import.meta.dirname, '..', 'skills'));
  for (const s of skills) assert.ok(settings.permissions.allow.includes(`Skill(multiplayer:${s})`), s);
  assert.ok(settings.permissions.allow.includes('Bash(multiplayer *)'));
  for (const rule of ['Bash(git push --force*)', 'Bash(git push * main)', 'Bash(git rebase *)', 'Read(.env)']) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
  assert.match(read(alice, '.github/PULL_REQUEST_TEMPLATE.md'), /## How to test/);
});

test('scaffold never overwrites: it extends CLAUDE.md, merges settings, keeps a PR template', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await mkdir(path.join(alice.cwd, '.claude'), { recursive: true });
  await mkdir(path.join(alice.cwd, '.github'), { recursive: true });
  await writeFile(path.join(alice.cwd, 'CLAUDE.md'), '# Shop\n\nUse pnpm.\n');
  await writeFile(
    path.join(alice.cwd, '.claude', 'settings.json'),
    JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(pnpm *)'] }, enabledPlugins: { 'multiplayer@multiplayer-vibe-coding': false } }),
  );
  await writeFile(path.join(alice.cwd, '.github', 'pull_request_template.md'), 'ours\n');
  await alice.git('add', '.');
  await alice.git('commit', '-q', '-m', 'existing files');

  const r = await ok(alice.run(['scaffold']));
  assert.match(r.stdout, /CLAUDE.md: added the multiplayer sections/);
  assert.match(r.stdout, /\.claude\/settings.json: merged in the multiplayer settings/);
  assert.match(r.stdout, /\.github\/pull_request_template.md: unchanged/);
  assert.match(read(alice, 'CLAUDE.md'), /^# Shop\n\nUse pnpm\.\n\n## How we work \(multiplayer\)/);
  const settings = JSON.parse(read(alice, '.claude/settings.json'));
  assert.equal(settings.model, 'opus');
  assert.equal(settings.enabledPlugins['multiplayer@multiplayer-vibe-coding'], false); // the team's choice wins
  assert.ok(settings.permissions.allow.includes('Bash(pnpm *)'));
  assert.ok(settings.permissions.allow.includes('Bash(multiplayer *)'));
  assert.equal(read(alice, '.github/pull_request_template.md'), 'ours\n');

  const again = await ok(alice.run(['scaffold']));
  assert.match(again.stdout, /Nothing to add/);
});

test('scaffold skips a settings file that is not valid JSON', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await mkdir(path.join(alice.cwd, '.claude'), { recursive: true });
  await writeFile(path.join(alice.cwd, '.claude', 'settings.json'), '{ nope');
  const r = await ok(alice.run(['scaffold']));
  assert.match(r.stdout, /\.claude\/settings.json: skipped \(not valid JSON/);
  assert.equal(read(alice, '.claude/settings.json'), '{ nope');
});

test('the briefing flags decisions missing from CLAUDE.md, and sync adds and retires them', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['scaffold']));
  await ok(bob.run(['decide', '--title', 'Money in integer cents'], { input: ADR('All money is integer cents.') }));
  const r1 = await ok(bob.run(['decide', '--title', 'Totals on the server'], { input: ADR('Compute totals server-side.') }));
  const oldId = r1.stdout.match(/\[(.+?)\]/)[1];

  assert.match(context(await alice.hook('session-start')), /CLAUDE.md is missing 2 team decisions \("Money in integer cents", "Totals on the server"\).*multiplayer:sync/);
  const s = await ok(alice.run(['sync']));
  assert.match(s.stdout, /Synced CLAUDE.md \(added "Money in integer cents", "Totals on the server"\) and committed it on alice\/multiplayer-setup/);
  const md = read(alice, 'CLAUDE.md');
  assert.match(md, /- \*\*Money in integer cents\*\*: All money is integer cents\. \(bob, \d{4}-\d\d-\d\d; `\.multiplayer\/decisions\/.*--bob--money-in-integer-cents\.md`\)/);
  assert.equal(await alice.git('log', '-1', '--format=%s'), 'multiplayer: sync CLAUDE.md with team decisions');
  assert.doesNotMatch(context(await alice.hook('session-start')), /CLAUDE.md is missing/);
  assert.match((await ok(alice.run(['sync']))).stdout, /already lists every current team decision/);

  await ok(bob.run(['decide', '--title', 'Totals in a shared module', '--supersedes', oldId], { input: ADR('Shared module.') }));
  const s2 = await ok(alice.run(['sync']));
  assert.match(s2.stdout, /added "Totals in a shared module"; removed 1 replaced decision/);
  assert.doesNotMatch(read(alice, 'CLAUDE.md'), /Totals on the server/);
});

test('sync on the default branch starts its own branch', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['decide', '--title', 'Use pnpm'], { input: ADR('pnpm only.') }));
  const r = await ok(alice.run(['sync']));
  assert.match(r.stdout, /committed it on alice\/sync-claude-md \(a new branch: push it and open a PR\)/);
  assert.match(read(alice, 'CLAUDE.md'), /## Team decisions[\s\S]*Use pnpm/);
});

test('update settles a conflict that is only in the Team decisions section', async (t) => {
  const team = await setup(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  // The team files land on main.
  await ok(alice.run(['scaffold']));
  await alice.git('push', '-q', 'origin', 'HEAD:main');
  await alice.git('switch', '-q', 'main');
  await alice.git('pull', '-q', '--ff-only', 'origin', 'main');

  await ok(alice.run(['claim', '--task', 'Alice work', '--paths', 'a/**']));
  await ok(alice.run(['decide', '--title', 'Decision A'], { input: ADR('A.') }));
  await ok(alice.run(['sync']));

  await bob.git('pull', '-q', 'origin', 'main');
  await bob.git('switch', '-q', '-c', 'bob/docs');
  await ok(bob.run(['decide', '--title', 'Decision B'], { input: ADR('B.') }));
  await ok(bob.run(['sync']));
  await bob.git('push', '-q', 'origin', 'HEAD:main');

  const u = await ok(alice.run(['update']));
  assert.match(u.stdout, /Merged 1 new commit from main into alice\/alice-work/);
  const md = read(alice, 'CLAUDE.md');
  assert.match(md, /Decision A[\s\S]*Decision B/);
  assert.doesNotMatch(md, /<<<<<<<|=======|>>>>>>>/);
  assert.equal(existsSync(path.join(alice.cwd, '.git', 'MERGE_HEAD')), false);
});
