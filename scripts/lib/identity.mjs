// Who am I? MULTIPLAYER_USER wins; otherwise git's user.name, slugified (PLAN §2.3).

import { git } from './git.mjs';

export function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function gitConfig(root, key) {
  try {
    return await git(['config', '--get', key], { cwd: root });
  } catch {
    return '';
  }
}

export class IdentityError extends Error {}

/**
 * A git identity shared by many people, like the one Claude Code cloud
 * sessions commit as ("Claude <noreply@anthropic.com>"). It can't tell
 * teammates apart, so it's never used as a username or for collision checks.
 */
export const isSharedIdentity = (name, email) =>
  /^(claude|claude code)$/i.test(name ?? '') || /noreply@anthropic\.com$/i.test(email ?? '');

export async function identity(root, env = process.env) {
  const gitName = await gitConfig(root, 'user.name');
  const gitEmail = await gitConfig(root, 'user.email');
  const shared = isSharedIdentity(gitName, gitEmail);
  if (shared && !env.MULTIPLAYER_USER) {
    throw new IdentityError(
      'This session commits as a shared identity ("' + gitName + '"), e.g. a Claude Code cloud session, so multiplayer ' +
        "can't tell who you are. Set MULTIPLAYER_USER to your team username in this environment's settings " +
        '(cloud: the environment\'s environment variables), then start a new session.',
    );
  }
  const user = slugify(env.MULTIPLAYER_USER || gitName);
  if (!user) {
    throw new IdentityError('Cannot determine your username: set MULTIPLAYER_USER or `git config user.name`.');
  }
  return { user, name: shared ? user : gitName || user, email: shared ? '' : gitEmail };
}
