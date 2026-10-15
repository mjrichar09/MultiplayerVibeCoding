import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTeam } from './helpers/team.mjs';

test('doctor reports a healthy setup, with suggestions for optional parts', async (t) => {
  const team = await makeTeam(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await alice.run(['init', '--create']);
  await bob.run(['init']);
  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE' } });

  const GH = { MULTIPLAYER_GITHUB_REPO: 'acme/app' };
  const r = await bob.run(['doctor'], { extraEnv: GH });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /✓ Node.js: v\d+/);
  assert.match(r.stdout, /✓ Your username: bob \(from git user.name\)/);
  assert.match(r.stdout, /✓ Team: 2 members: alice, bob/);
  assert.match(r.stdout, /✓ Sharing claims: can push multiplayer-state/);
  assert.match(r.stdout, /✓ Default branch: main/);
  assert.match(r.stdout, /✓ GitHub CLI: signed in; acme\/app \(write access\)/);
  assert.match(r.stdout, /⚠️ Branch protection: off for main[^\n]*\n    → Recommended: a repo admin runs `multiplayer protect`/);
  assert.match(r.stdout, /Working, with 1 suggestion\./);

  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'ADMIN' }, protected: true });
  assert.match((await bob.run(['doctor'], { extraEnv: GH })).stdout, /✓ Branch protection: on for main[\s\S]*Everything looks good\./);
});

test('doctor explains what is missing', async (t) => {
  const team = await makeTeam(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;

  const notSetUp = await alice.run(['doctor'], { extraEnv: { MULTIPLAYER_GH: '/nonexistent/gh' } });
  assert.match(notSetUp.stdout, /⚠️ Team state: no multiplayer-state branch[^\n]*\n    → Ask Claude to "set up multiplayer for this repo"/);
  assert.match(notSetUp.stdout, /⚠️ GitHub CLI: gh is not installed/);

  await alice.run(['init', '--create']);
  assert.match((await bob.run(['doctor'])).stdout, /⚠️ Team state: the team exists but this copy has not joined yet/);
  assert.match((await bob.run(['doctor'], { extraEnv: { FAKE_GH_UNAUTH: '1', MULTIPLAYER_GITHUB_REPO: 'acme/app' } })).stdout, /⚠️ GitHub CLI: gh is not signed in/);

  await team.setPrs({ repo: { nameWithOwner: 'acme/app', viewerPermission: 'WRITE' } });

  await bob.git('config', 'user.name', 'Claude');
  await bob.git('config', 'user.email', 'noreply@anthropic.com');
  const cloud = await bob.run(['doctor'], { extraEnv: { CLAUDE_CODE_REMOTE: 'true' } });
  assert.equal(cloud.status, 1);
  assert.match(cloud.stdout, /✗ Your username: .*shared identity[\s\S]*→ Add MULTIPLAYER_USER to the cloud environment's environment variables\./);
  assert.match(cloud.stdout, /1 problem to fix\./);
});
