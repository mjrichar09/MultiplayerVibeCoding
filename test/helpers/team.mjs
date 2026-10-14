// N-clone simulation harness: a bare "remote" plus one clone per member, with
// git config isolated from the machine running the tests.

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../../scripts/multiplayer.mjs', import.meta.url));
const FAKE_GH = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

export function sh(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    if (child.stdin) {
      child.stdin.on('error', () => {}); // the child may exit before reading its input
      child.stdin.end(input);
    }
  });
}

const gitIn = (cwd, env) => async (...args) => {
  const r = await sh('git', args, { cwd, env });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

export async function makeTeam(names = ['alice', 'bob', 'carol'], { seed = true } = {}) {
  const base = await mkdtemp(path.join(tmpdir(), 'multiplayer-test-'));
  const gitconfig = path.join(base, 'gitconfig');
  await writeFile(gitconfig, '[init]\n\tdefaultBranch = main\n');
  const env = {
    PATH: process.env.PATH,
    HOME: base,
    GIT_CONFIG_GLOBAL: gitconfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    MULTIPLAYER_GH: FAKE_GH,
    MULTIPLAYER_GH_TTL_MS: '0',
    FAKE_GH_FIXTURE: path.join(base, 'gh.json'),
  };
  const remote = path.join(base, 'remote.git');
  await gitIn(base, env)('init', '--quiet', '--bare', remote);

  // Seed the project with one commit on main, like a real repo.
  if (seed) await seedRemote(base, remote, env);

  const members = {};
  for (const name of names) members[name] = await addClone({ base, remote, env }, name);

  return {
    base,
    remote,
    env,
    members,
    addClone: (name, opts) => addClone({ base, remote, env }, name, opts),
    setPrs: (prs) => writeFile(env.FAKE_GH_FIXTURE, JSON.stringify(prs)),
    setNow: (iso) => (iso ? (env.MULTIPLAYER_NOW = iso) : delete env.MULTIPLAYER_NOW),
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

async function addClone({ base, remote, env }, name, { email = `${name}@example.com`, dir = name } = {}) {
  const cwd = path.join(base, dir);
  await gitIn(base, env)('clone', '--quiet', remote, cwd);
  const g = gitIn(cwd, env);
  await g('config', 'user.name', name[0].toUpperCase() + name.slice(1));
  await g('config', 'user.email', email);
  return {
    name,
    cwd,
    git: g,
    run: (args, { input, extraEnv } = {}) =>
      sh(process.execPath, [CLI, ...args], { cwd, env: { ...env, ...extraEnv }, input }),
    hook: async (event, extraInput = {}, { extraEnv } = {}) => {
      const r = await sh(process.execPath, [CLI, 'hook', event], {
        cwd,
        env: { ...env, ...extraEnv },
        input: JSON.stringify({ hook_event_name: event, cwd, ...extraInput }),
      });
      return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
    },
  };
}


async function seedRemote(base, remote, env) {
  const seed = path.join(base, 'seed');
  const g = gitIn(base, env);
  await g('clone', '--quiet', remote, seed);
  const gs = gitIn(seed, env);
  await gs('config', 'user.name', 'Seed');
  await gs('config', 'user.email', 'seed@example.com');
  await writeFile(path.join(seed, 'README.md'), '# project\n');
  await gs('add', '.');
  await gs('commit', '--quiet', '-m', 'init');
  await gs('push', '--quiet', 'origin', 'HEAD:main');
}
