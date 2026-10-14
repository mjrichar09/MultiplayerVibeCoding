// Reading and writing files in the state worktree. Markdown entries use YAML
// frontmatter whose values are written as JSON (a valid YAML subset), so they
// round-trip without a YAML dependency.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const CONFIG_FILE = 'multiplayer.config.json';

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  staleClaimDays: 3,
  noteDays: 3,
  autoBranch: true,
  autoUpdate: true,
});

export function formatFrontmatter(data, body = '') {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body ? `\n${body.replace(/\s*$/, '\n')}` : ''}`;
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const raw = kv[2].trim();
    try {
      data[kv[1]] = JSON.parse(raw);
    } catch {
      data[kv[1]] = raw.replace(/^['"]|['"]$/g, '');
    }
  }
  return { data, body: m[2].replace(/^\n/, '') };
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

export async function readConfig(dir) {
  const file = path.join(dir, CONFIG_FILE);
  const stored = existsSync(file) ? await readJson(file) : {};
  return { ...DEFAULT_CONFIG, ...stored };
}

export const memberPath = (dir, user) => path.join(dir, 'members', `${user}.json`);

export async function readMember(dir, user) {
  const file = memberPath(dir, user);
  return existsSync(file) ? readJson(file) : null;
}

export async function listMembers(dir) {
  const membersDir = path.join(dir, 'members');
  if (!existsSync(membersDir)) return [];
  const files = (await readdir(membersDir)).filter((f) => f.endsWith('.json')).sort();
  const members = [];
  for (const f of files) {
    try {
      members.push(await readJson(path.join(membersDir, f)));
    } catch {
      // Skip a malformed member file rather than failing every reader.
    }
  }
  return members;
}
