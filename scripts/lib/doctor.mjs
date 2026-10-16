// `multiplayer doctor`: check everything the plugin depends on and say how to
// fix what's missing (PLAN Phase 6). Never changes anything.

import { execFile } from 'node:child_process';
import { STATE_BRANCH, git, isAttached, remoteHasStateBranch, repoRoot, defaultRemote, stateDir } from './git.mjs';
import { identity } from './identity.mjs';
import { listMembers, readConfig } from './state.mjs';
import { isCloudSession } from './util.mjs';
import { defaultBranch } from './workflow.mjs';
import { parseGithubRepo } from './gh.mjs';

function run(cmd, args, { cwd, env = process.env, timeout = 8_000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, timeout, windowsHide: true }, (err, stdout, stderr) =>
      resolve({ ok: !err, missing: err?.code === 'ENOENT', stdout: String(stdout).trim(), stderr: String(stderr).trim() }),
    );
  });
}

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

/** Returns [{ status: 'ok' | 'warn' | 'fail', check, detail, fix }]. */
export async function doctor(cwd, { env = process.env } = {}) {
  const results = [];
  const add = (status, check, detail, fix) => results.push({ status, check, detail, fix });

  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) add(OK, 'Node.js', `v${process.versions.node}`);
  else add(FAIL, 'Node.js', `v${process.versions.node}`, 'Install Node.js 18 or newer.');

  const gitVersion = await run('git', ['--version']);
  if (!gitVersion.ok) {
    add(FAIL, 'git', 'not found', 'Install git.');
    return results;
  }
  add(OK, 'git', gitVersion.stdout.replace('git version ', ''));

  const root = await repoRoot(cwd);
  if (!root) {
    add(FAIL, 'Repository', 'not inside a git repository', 'Open Claude Code in your project folder.');
    return results;
  }
  const remote = await defaultRemote(root);
  if (!remote) {
    add(FAIL, 'Remote', 'this repository has no remote', 'Push it to GitHub (or another git host) so teammates can share it.');
    return results;
  }
  const url = await git(['remote', 'get-url', remote], { cwd: root }).catch(() => '?');
  add(OK, 'Remote', `${remote} → ${url}`);

  let me = null;
  try {
    me = await identity(root, env);
    add(OK, 'Your username', `${me.user}${env.MULTIPLAYER_USER ? ' (from MULTIPLAYER_USER)' : ' (from git user.name)'}`);
  } catch (err) {
    add(FAIL, 'Your username', err.message, isCloudSession(env) ? "Add MULTIPLAYER_USER to the cloud environment's environment variables." : 'Set MULTIPLAYER_USER or `git config user.name`.');
  }

  const reachable = await remoteHasStateBranch(root, remote, { timeout: 10_000 }).then(
    (has) => ({ ok: true, has }),
    (err) => ({ ok: false, err }),
  );
  if (!reachable.ok) {
    add(FAIL, 'Team state', `can't reach ${remote}: ${reachable.err.message.split('\n')[0]}`, 'Check your network and that you can `git fetch` this repository.');
  } else if (!reachable.has) {
    add(WARN, 'Team state', `no ${STATE_BRANCH} branch on ${remote}: multiplayer isn't set up for this repo yet`, 'Ask Claude to "set up multiplayer for this repo" (one person, once).');
  } else if (!isAttached(root)) {
    add(WARN, 'Team state', 'the team exists but this copy has not joined yet', 'Start a new Claude Code session here; it joins automatically.');
  } else {
    const dir = stateDir(root);
    const members = await listMembers(dir);
    const joined = me && members.some((m) => m.user === me.user);
    add(joined ? OK : WARN, 'Team', `${members.length} member${members.length === 1 ? '' : 's'}: ${members.map((m) => m.user).join(', ')}`, joined ? undefined : 'Start a new session to register yourself.');
    const push = await run('git', ['push', '--dry-run', '--quiet', remote, `HEAD:refs/heads/${STATE_BRANCH}`], { cwd: dir, env });
    if (push.ok || /up to date|Everything up-to-date/i.test(push.stderr)) add(OK, 'Sharing claims', `can push ${STATE_BRANCH}`);
    else {
      add(
        FAIL,
        'Sharing claims',
        `can't push ${STATE_BRANCH}: ${push.stderr.split('\n')[0]}`,
        isCloudSession(env)
          ? `This cloud environment may only allow pushes to the session's own branch. Allow pushes to ${STATE_BRANCH}, or use multiplayer from a local session.`
          : 'Make sure you have write access to the repository.',
      );
    }
    const config = await readConfig(dir);
    add(OK, 'Default branch', await defaultBranch(root, remote, config));
  }

  const ghBin = env.MULTIPLAYER_GH || 'gh';
  // GitHub's REST API, like the rest of the plugin (works in cloud sessions too).
  const nwo = env.MULTIPLAYER_GITHUB_REPO || parseGithubRepo(url);
  const installed = await run(ghBin, ['--version'], { cwd: root, env });
  const repo = installed.missing
    ? { missing: true }
    : nwo
      ? await run(ghBin, ['api', `repos/${nwo}`], { cwd: root, env })
      : { ok: false };
  let info = null;
  try {
    info = JSON.parse(repo.stdout);
  } catch {
    // not reachable
  }
  if (repo.missing) {
    add(WARN, 'GitHub CLI', 'gh is not installed', 'Optional: install gh and run `gh auth login` for PR-overlap warnings, merge checks, release-on-merge, and `protect`.');
  } else if (!nwo) {
    add(WARN, 'GitHub CLI', "this repository isn't on GitHub", 'PR-based features are off; everything else works.');
  } else if (!info?.full_name) {
    const auth = await run(ghBin, ['auth', 'status'], { cwd: root, env });
    if (!auth.ok) add(WARN, 'GitHub CLI', 'gh is not signed in', 'Run `gh auth login` to enable the PR-based features.');
    else add(WARN, 'GitHub CLI', `signed in, but ${nwo} isn't reachable`, 'PR-based features are off; everything else works.');
  } else {
    const access = info.permissions?.admin ? 'admin' : info.permissions?.push ? 'write' : 'read';
    add(OK, 'GitHub CLI', `signed in; ${info.full_name} (${access} access)`);
    const base = await defaultBranch(root, remote, {});
    const prot = await run(ghBin, ['api', `repos/${info.full_name}/branches/${base}/protection`], { cwd: root, env });
    if (prot.ok) add(OK, 'Branch protection', `on for ${base}`);
    else add(WARN, 'Branch protection', `off for ${base} (or not visible to you)`, 'Recommended: a repo admin runs `multiplayer protect` so failing checks cannot merge.');
  }

  if (isCloudSession(env)) add(OK, 'Session type', 'cloud session: work happens on the branch the environment assigns');
  return results;
}

export function formatDoctor(results) {
  const icon = { ok: '✓', warn: '⚠️', fail: '✗' };
  const lines = results.map((r) => `${icon[r.status]} ${r.check}: ${r.detail}${r.fix ? `\n    → ${r.fix}` : ''}`);
  const fails = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('', fails ? `${fails} problem${fails === 1 ? '' : 's'} to fix.` : warns ? `Working, with ${warns} suggestion${warns === 1 ? '' : 's'}.` : 'Everything looks good.');
  return lines.join('\n');
}
