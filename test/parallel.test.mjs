import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CLI, makeTeam, sh } from './helpers/team.mjs';

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

/** A handle for running the CLI and hooks from any directory (e.g. a worktree). */
function at(team, cwd) {
  const env = team.env;
  return {
    cwd,
    git: async (...args) => {
      const r = await sh('git', args, { cwd, env });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    },
    run: (args, { input, extraEnv } = {}) => sh(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extraEnv }, input }),
    hook: async (event, extra = {}, { extraEnv } = {}) => {
      const r = await sh(process.execPath, [CLI, 'hook', event], {
        cwd,
        env: { ...env, ...extraEnv },
        input: JSON.stringify({ hook_event_name: event, cwd, ...extra }),
      });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    },
    edit: function (file, extra = {}) {
      return this.hook('pre-tool-use', { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: path.join(cwd, file) }, ...extra });
    },
  };
}

async function landOnMain(m, file, content, message) {
  await m.git('switch', '-q', 'main');
  await m.git('pull', '-q', '--ff-only', 'origin', 'main');
  await mkdir(path.dirname(path.join(m.cwd, file)), { recursive: true });
  await writeFile(path.join(m.cwd, file), content);
  await m.git('add', file);
  await m.git('commit', '-q', '-m', message);
  await m.git('push', '-q', 'origin', 'HEAD:main');
}

// ------------------------------------------------------------ worktrees

test('every worktree of a clone shares one team state and keeps its own branch', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const wtPath = path.join(team.base, 'alice-wt');
  await alice.git('worktree', 'add', '-q', '-b', 'alice/api', wtPath);
  const wt = at(team, wtPath);

  const init = await ok(wt.run(['init']));
  assert.match(init.stdout, /Already on the team as "alice"/);
  assert.equal(existsSync(path.join(wtPath, '.multiplayer')), false); // shared, not duplicated

  const r = await ok(wt.run(['claim', '--task', 'Payments API', '--paths', 'src/api/**']));
  assert.match(r.stdout, /on alice\/api/);
  assert.equal(await wt.git('branch', '--show-current'), 'alice/api');
  assert.equal(await alice.git('branch', '--show-current'), 'main'); // main checkout untouched
  assert.ok(existsSync(path.join(alice.cwd, '.multiplayer', 'claims', 'alice--payments-api.md')));

  const s = await wt.hook('session-start');
  assert.match(context(s), /Your claims:\n- payments-api/);
  assert.match(context(await bob.hook('session-start')), /alice \(1\):\n  - payments-api/);
});

test('a team can be created and joined from linked worktrees of a bare repository', async (t) => {
  const team = await makeTeam(['alice']);
  t.after(team.cleanup);
  const bare = path.join(team.base, 'alice-bare.git');
  await team.members.alice.git('clone', '-q', '--bare', team.remote, bare);
  const b = at(team, bare);
  await b.git('config', 'user.name', 'Alice');
  await b.git('config', 'user.email', 'alice@example.com');
  await b.git('worktree', 'add', '-q', path.join(team.base, 'w1'), 'main');
  await b.git('worktree', 'add', '-q', '-b', 'w2', path.join(team.base, 'w2'), 'main');
  const w1 = at(team, path.join(team.base, 'w1'));
  const w2 = at(team, path.join(team.base, 'w2'));

  await ok(w1.run(['init', '--create']));
  assert.ok(existsSync(path.join(bare, 'multiplayer', 'state', 'members', 'alice.json')));
  const again = await ok(w2.run(['init']));
  assert.match(again.stdout, /Already on the team/);
  await ok(w2.run(['claim', '--task', 'From w2', '--paths', 'x/**']));
  assert.match((await ok(w1.run(['status']))).stdout, /from-w2/);
});

// ------------------------------------------------------------- subagents

test('subagents are workers: no claim nudges, and git or claims draw a warning', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(bob.run(['claim', '--task', 'Bob api', '--paths', 'src/api/**']));
  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/checkout/**']));
  await alice.git('-C', '.multiplayer', 'pull', '-q', '--rebase');
  const a = at(team, alice.cwd);
  const sub = { agent_id: 'agent-1', agent_type: 'general-purpose' };

  assert.equal((await a.edit('lib/unclaimed.ts', sub)).stdout, ''); // no nudge for a worker
  assert.match(context(await a.edit('lib/unclaimed.ts', { session_id: 'main' })), /none of your claims covers/);
  assert.match(context(await a.edit('src/api/x.ts', sub)), /bob \(claim "bob-api".*Confirm with your lead/);

  const bash = (command, extra = {}) =>
    a.hook('pre-tool-use', { session_id: 's1', tool_name: 'Bash', tool_input: { command }, ...extra });
  assert.match(context(await bash('git commit -am "wip"', sub)), /you are a worker agent.*Leave git/);
  assert.match(context(await bash('git add . && git push origin HEAD', sub)), /worker agent/);
  assert.equal((await bash('npm test', sub)).stdout, '');
  assert.equal((await bash('git commit -am "wip"')).stdout, ''); // the lead itself is fine
  const skill = await a.hook('pre-tool-use', { session_id: 's1', tool_name: 'Skill', tool_input: { skill: 'multiplayer:claim' }, ...sub });
  assert.match(context(skill), /worker agent/);
});

test('subagents editing the same file are warned; a finished subagent no longer counts', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  await ok(alice.run(['claim', '--task', 'Big task', '--paths', 'src/**']));
  const a = at(team, alice.cwd);
  const agent = (id) => ({ agent_id: id, agent_type: 'general-purpose' });

  assert.equal((await a.edit('src/shared.ts', agent('A'))).stdout, '');
  const b = await a.edit('src/shared.ts', agent('B'));
  assert.match(context(b), /a general-purpose subagent in this session also edited src\/shared.ts/);
  assert.equal((await a.edit('src/other.ts', agent('B'))).stdout, '');

  await a.hook('subagent-stop', { session_id: 's1', ...agent('A') });
  await a.hook('subagent-stop', { session_id: 's1', ...agent('B') });
  assert.equal((await a.edit('src/shared.ts', agent('C'))).stdout, '');
});

// ------------------------------------------------------- worker sessions

test('worker sessions (e.g. Orca worktrees) edit their assignment and leave git to the lead', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  const wtPath = path.join(team.base, 'orca-1');
  await alice.git('worktree', 'add', '-q', '-b', 'alice/orca-1', wtPath);
  const w = at(team, wtPath);

  const r = await ok(alice.run(['worker', '--dir', wtPath, '--task', 'Payments API', '--paths', 'src/api/**']));
  assert.match(r.stdout, /now workers assigned to src\/api\/\*\*.*Claimed "payments-api" \[src\/api\/\*\*\] for alice on alice\/orca-1/s);

  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');
  const before = await w.git('rev-parse', 'HEAD');
  const s = await w.hook('session-start', { session_id: 'w1' });
  assert.match(context(s), /You are a worker agent under alice's lead session/);
  assert.match(context(s), /Edit only the files you were assigned \(src\/api\/\*\*\)/);
  assert.doesNotMatch(context(s), /How to work with your team/);
  assert.equal(await w.git('rev-parse', 'HEAD'), before); // no automatic merge for workers

  const e = { session_id: 'w1' };
  assert.equal((await w.edit('src/api/pay.ts', e)).stdout, '');
  assert.match(context(await w.edit('docs/readme.md', e)), /outside your assigned files \(src\/api\/\*\*\)\. Check with your lead/);
  const claim = await w.run(['claim', '--task', 'x', '--paths', 'x/**']);
  assert.equal(claim.status, 1);
  assert.match(claim.stderr, /worker session: your lead claims work/);

  await ok(w.run(['worker', '--off']));
  assert.match(context(await w.hook('session-start', { session_id: 'w1' })), /How to work with your team/);
});

test('my agents in different worktrees are warned when they edit the same file', async (t) => {
  const team = await setup(['alice']);
  t.after(team.cleanup);
  const { alice } = team.members;
  const w1 = at(team, path.join(team.base, 'wt-1'));
  const w2 = at(team, path.join(team.base, 'wt-2'));
  await alice.git('worktree', 'add', '-q', '-b', 'alice/one', w1.cwd);
  await alice.git('worktree', 'add', '-q', '-b', 'alice/two', w2.cwd);
  await ok(w1.run(['claim', '--task', 'One', '--paths', 'src/**']));
  await ok(w2.run(['claim', '--task', 'Two', '--paths', 'src/**']));

  assert.equal((await w1.edit('src/app.ts', { session_id: 'one' })).stdout, '');
  assert.match(context(await w2.edit('src/app.ts', { session_id: 'two' })), /a session in worktree wt-1 also edited src\/app.ts/);
});

// ---------------------------------------------------- shared-folder fallback

test('sessions sharing a folder pause automatic git steps until the others end', async (t) => {
  const team = await setup();
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['claim', '--task', 'Feature', '--paths', 'src/**']));
  const a = at(team, alice.cwd);
  await a.hook('session-start', { session_id: 's1' });
  await landOnMain(bob, 'lib/b.ts', 'b\n', 'Bob lands b.ts');
  const before = await a.git('rev-parse', 'HEAD');

  const s2 = await a.hook('session-start', { session_id: 's2' });
  assert.match(context(s2), /1 other agent session is active in this folder, so automatic git steps .* are paused until it ends/);
  assert.equal(await a.git('rev-parse', 'HEAD'), before);

  // Claiming doesn't switch the shared checkout's branch.
  const c = await ok(a.run(['claim', '--task', 'Second', '--paths', 'lib/**']));
  assert.match(c.stdout, /no task branch was started/);
  assert.equal(await a.git('branch', '--show-current'), 'alice/feature');

  // Both sessions edit the same file: warned.
  await a.edit('src/x.ts', { session_id: 's1' });
  assert.match(context(await a.edit('src/x.ts', { session_id: 's2' })), /another session in this folder also edited src\/x.ts/);

  // s1 ends: the next session start updates normally.
  await a.hook('session-end', { session_id: 's1' });
  await a.hook('session-end', { session_id: 's2' });
  const s3 = await a.hook('session-start', { session_id: 's3' });
  assert.doesNotMatch(context(s3), /paused/);
  assert.match(s3.json.systemMessage, /merged the latest main into alice\/feature/);
});

// --------------------------------------------------- handoff suggestions

test('a quiet claim suggests finishing, releasing, or handing off; newcomers get a welcome', async (t) => {
  const team = await makeTeam(['alice', 'bob']);
  t.after(team.cleanup);
  const { alice, bob } = team.members;
  await ok(alice.run(['init', '--create']));
  const welcome = await bob.hook('session-start');
  assert.match(context(welcome), /Just now: welcome to the team!.*"hand this to <name>"/);
  assert.doesNotMatch(context(await bob.hook('session-start')), /welcome to the team/);

  await ok(alice.run(['claim', '--task', 'Checkout', '--paths', 'src/**']));
  team.setNow(new Date(Date.now() + 2.2 * 24 * 3600 * 1000).toISOString());
  assert.match(context(await alice.hook('session-start')), /- checkout: Checkout[^\n]*no activity for 2d: finish it, release it, or offer a handoff/);
  team.setNow(new Date(Date.now() + 4 * 24 * 3600 * 1000).toISOString());
  assert.match(context(await alice.hook('session-start')), /STALE, no activity for 4d: finish it, release it, or offer a handoff/);
  assert.match(context(await alice.hook('session-start')), /offer a handoff to a fitting teammate/);
});
