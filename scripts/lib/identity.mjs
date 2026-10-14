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

export async function identity(root, env = process.env) {
  const name = await gitConfig(root, 'user.name');
  const email = await gitConfig(root, 'user.email');
  const user = slugify(env.MULTIPLAYER_USER || name);
  if (!user) {
    throw new Error('Cannot determine your username: set MULTIPLAYER_USER or `git config user.name`.');
  }
  return { user, name: name || user, email };
}
