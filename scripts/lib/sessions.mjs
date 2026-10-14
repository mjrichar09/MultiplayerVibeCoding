// Parallel agents on one clone (PLAN §2.9): which sessions are active, which
// sessions/subagents are workers, and which files each of them has edited.
// Everything here is local to the clone (.multiplayer/.local/), one file per
// actor so concurrent hooks never overwrite each other.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gitLayout, stateDir } from './git.mjs';

export const ACTIVE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;

const localPath = (root, ...parts) => path.join(stateDir(root), '.local', ...parts);
const safe = (s) => String(s ?? 'none').replace(/[^\w.-]/g, '_');

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data));
}

async function readAll(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    const data = await readJson(path.join(dir, f));
    if (data) out.push(data);
  }
  return out;
}

// ------------------------------------------------------------------ roles

const workerMarker = (root) => path.join(gitLayout(root).gitDir, 'multiplayer-worker.json');

/** Mark (or unmark) this worktree's sessions as workers under a lead. */
export async function setWorker(root, info) {
  if (info === null) return rm(workerMarker(root), { force: true });
  return writeJson(workerMarker(root), { ...info, since: new Date().toISOString() });
}

/**
 * Is this hook/CLI call made by a worker? Subagents are workers automatically
 * (their hook input carries agent_id); separate sessions are workers when
 * MULTIPLAYER_ROLE=worker or their worktree was marked with `multiplayer worker`.
 * Returns null or { kind: 'subagent' | 'session', ...markerInfo }.
 */
export async function workerRole(root, input = {}, env = process.env) {
  if (input.agent_id) return { kind: 'subagent', agentId: input.agent_id, agentType: input.agent_type };
  const marker = await readJson(workerMarker(root));
  if (marker) return { kind: 'session', ...marker };
  if (env.MULTIPLAYER_ROLE === 'worker') return { kind: 'session' };
  return null;
}

// --------------------------------------------------------------- sessions

const sessionFile = (root, id) => localPath(root, 'sessions', `${safe(id)}.json`);

export async function registerSession(root, id, extra = {}) {
  if (!id) return;
  const now = Date.now();
  await writeJson(sessionFile(root, id), { id, worktree: root, started: now, heartbeat: now, ...extra });
}

/** Refresh my heartbeat (at most once a minute). */
export async function heartbeat(root, id) {
  if (!id) return;
  const file = sessionFile(root, id);
  const current = await readJson(file);
  if (current && Date.now() - current.heartbeat < HEARTBEAT_MS) return;
  await writeJson(file, { id, worktree: root, started: current?.started ?? Date.now(), ...current, heartbeat: Date.now() });
}

export async function endSession(root, id) {
  if (!id) return;
  await rm(sessionFile(root, id), { force: true });
  await rm(localPath(root, 'edits', `${safe(id)}.json`), { force: true });
}

export async function activeSessions(root) {
  const cutoff = Date.now() - ACTIVE_MS;
  return (await readAll(localPath(root, 'sessions'))).filter((s) => s.heartbeat >= cutoff);
}

/** Other active sessions sharing this working folder (same checkout, same branch). */
export async function peersInFolder(root, myId) {
  return (await activeSessions(root)).filter((s) => s.worktree === root && s.id !== myId);
}

// ------------------------------------------------------------------ edits

const actorKey = (input) => safe(input.agent_id ? `${input.session_id}--${input.agent_id}` : input.session_id);

/** Remember that this session or subagent edited `rel`. */
export async function recordEdit(root, input, rel) {
  const file = localPath(root, 'edits', `${actorKey(input)}.json`);
  const current = (await readJson(file)) ?? { files: [] };
  if (current.files.includes(rel) && Date.now() - (current.at ?? 0) < HEARTBEAT_MS) return;
  await writeJson(file, {
    session: input.session_id,
    agentId: input.agent_id ?? null,
    agentType: input.agent_type ?? null,
    worktree: root,
    files: [...new Set([...current.files, rel])],
    at: Date.now(),
  });
}

/** Other recently active actors in this clone that edited `rel`. */
export async function otherEditors(root, input, rel) {
  const me = actorKey(input);
  const cutoff = Date.now() - ACTIVE_MS;
  const dir = localPath(root, 'edits');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of await readdir(dir)) {
    if (f === `${me}.json`) continue;
    const e = await readJson(path.join(dir, f));
    if (e && e.at >= cutoff && e.files.includes(rel)) out.push(e);
  }
  return out;
}

export async function forgetAgent(root, input) {
  if (!input.agent_id) return;
  await rm(localPath(root, 'edits', `${actorKey(input)}.json`), { force: true });
}
