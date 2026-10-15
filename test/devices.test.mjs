import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { makeTeam } from './helpers/team.mjs';
import { parseFrontmatter } from '../scripts/lib/state.mjs';

const ok = async (p) => {
  const r = await p;
  assert.equal(r.status, 0, r.stderr);
  return r;
};
const context = (r) => r.json?.hookSpecificOutput?.additionalContext ?? '';
const CLOUD = { CLAUDE_CODE_REMOTE: 'true' };

async function cloudClone(team, dir, extraGitConfig = true) {
  const c = await team.addClone('claude', { email: 'noreply@anthropic.com', dir });
  if (extraGitConfig) await c.git('config', 'user.name', 'Claude');
  return c;
}

test('a cloud session committing as "Claude" is not mistaken for a teammate', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  await ok(team.members.alice.run(['init', '--create']));
  const cloud = await cloudClone(team, 'cloud-1');

  const s = await cloud.hook('session-start', {}, { extraEnv: CLOUD });
  assert.match(context(s), /multiplayer is paused in this session: .*shared identity \("Claude"\).*Set MULTIPLAYER_USER/);
  assert.equal((await cloud.hook('session-start', {}, { extraEnv: CLOUD })).stdout, ''); // said once
  const members = await ok(team.members.alice.run(['members']));
  assert.doesNotMatch(members.stdout, /claude/);

  const r = await cloud.run(['claim', '--task', 'x', '--paths', 'x/**'], { extraEnv: CLOUD });
  assert.match(r.stderr, /shared identity|no multiplayer team here yet/);
  assert.notEqual(r.status, 0);
});

test('with MULTIPLAYER_USER set, a cloud session works as that member on its assigned branch', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['init', '--create']));
  const cloud = await cloudClone(team, 'cloud-2');
  await cloud.git('switch', '-q', '-c', 'claude/assigned-branch');
  const env = { ...CLOUD, MULTIPLAYER_USER: 'alice' };

  const s = await cloud.hook('session-start', {}, { extraEnv: env });
  assert.match(context(s), /you are alice/);
  const r = await ok(cloud.run(['claim', '--task', 'Cloud task', '--paths', 'cloud/**'], { extraEnv: env }));
  assert.match(r.stdout, /Claimed "cloud-task" for alice: .* on claude\/assigned-branch/);
  assert.doesNotMatch(r.stdout, /Started branch/);
  const members = await ok(alice.run(['members']));
  assert.equal(members.stdout.trim(), 'alice <alice@example.com>'); // same member, no collision
});

test('my sessions on different machines warn each other about the same files', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['init', '--create']));
  const laptop = await team.addClone('alice', { dir: 'alice-laptop' });
  await ok(laptop.run(['init']));

  await ok(alice.run(['claim', '--task', 'Desk work', '--paths', 'src/**'], { extraEnv: { MULTIPLAYER_DEVICE: 'desktop' } }));
  const claimFile = path.join(alice.cwd, '.multiplayer', 'claims', 'alice--desk-work.md');
  assert.equal(parseFrontmatter(readFileSync(claimFile, 'utf8')).data.device, 'desktop');

  await laptop.git('-C', '.multiplayer', 'pull', '-q', '--rebase');
  const edit = (m, file, session) =>
    m.hook('pre-tool-use', { session_id: session, tool_name: 'Edit', tool_input: { file_path: path.join(m.cwd, file) } });
  const w = await edit(laptop, 'src/app.ts', 'l1');
  assert.match(context(w), /src\/app.ts is in your own claim "desk-work" from your session on desktop \(branch alice\/desk-work/);
  assert.doesNotMatch(context(w), /none of your claims covers/);
  assert.doesNotMatch(context(await edit(laptop, 'src/app.ts', 'l1')), /your own claim/); // once per file
  assert.equal((await edit(alice, 'src/app.ts', 'd1')).stdout, ''); // same machine: no warning

  assert.match(context(await laptop.hook('session-start')), /desk-work: Desk work[^\n]*from your session on desktop/);
});
