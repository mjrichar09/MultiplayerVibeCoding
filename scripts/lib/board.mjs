// The team board (PLAN §2.10): who is working on what, for the always-visible
// panel in Claude Code (`multiplayer board --json`) and as README.md on the
// multiplayer-state branch, which GitHub shows as a page.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activeClaims, isStale, listClaims, mergedPr } from './claims.mjs';
import { listEntries } from './entries.mjs';
import { listVotes } from './votes.mjs';
import { setBoardWriter } from './git.mjs';
import { listMembers, readConfig } from './state.mjs';
import { DAY_MS } from './util.mjs';

export const BOARD_FILE = 'README.md';

/**
 * The board as data: every active member with their open claims, recent team
 * notes, and handoffs not yet picked up. `prCache` (optional) flags claims
 * whose PR already merged.
 */
export async function boardData(dir, { at = new Date(), prCache = null } = {}) {
  const [config, members, claims, notes, handoffs, votes] = await Promise.all([
    readConfig(dir),
    listMembers(dir),
    listClaims(dir),
    listEntries(dir, 'note'),
    listEntries(dir, 'handoff'),
    listVotes(dir),
  ]);
  const active = activeClaims(claims);
  const accepted = new Set(active.map((c) => c.handoff).filter(Boolean));
  const people = members
    .filter((m) => m.active !== false)
    .map((m) => ({
      user: m.user,
      claims: active
        .filter((c) => c.user === m.user)
        .sort((a, b) => String(b.updated ?? b.started).localeCompare(String(a.updated ?? a.started)))
        .map((c) => ({
          slug: c.slug,
          task: c.task,
          paths: c.paths ?? [],
          branch: c.branch ?? null,
          device: c.device ?? null,
          started: c.started,
          updated: c.updated ?? c.started,
          stale: isStale(c, config, at),
          mergedPr: mergedPr(c, prCache)?.number ?? null,
        })),
    }))
    .sort((a, b) => b.claims.length - a.claims.length || a.user.localeCompare(b.user));
  const noteDays = config.noteDays ?? 3;
  return {
    members: people,
    notes: notes
      .filter((n) => at - new Date(n.created) < noteDays * DAY_MS)
      .reverse()
      .map((n) => ({ user: n.user, title: n.title ?? n.body.split('\n')[0], created: n.created })),
    // Unsettled votes, never their ballots.
    votes: votes
      .filter((v) => v.state !== 'closed')
      .map((v) => ({ id: v.id, title: v.title, kind: v.kind, urgent: v.urgent, by: v.by, state: v.state, waitingOn: v.waitingOn })),
    handoffs: handoffs
      .filter((h) => !accepted.has(h.id) && at - new Date(h.created) < 14 * DAY_MS)
      .reverse()
      .map((h) => ({ from: h.user, to: h.to ?? [], title: h.title, created: h.created })),
  };
}

const day = (iso) => String(iso ?? '').slice(0, 10);
const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');

/** The board as Markdown, for README.md on the state branch. Timeless: dates, not "2h ago". */
export function boardMarkdown(data) {
  const lines = [
    '# Team board',
    '',
    'Who is working on what, kept up to date by the [multiplayer](https://github.com/mjrichar09/MultiplayerVibeCoding) plugin each time someone claims, releases, or posts. This branch holds the team\'s shared state: never merge it into your main branch.',
    '',
  ];
  const working = data.members.filter((m) => m.claims.length);
  const idle = data.members.filter((m) => !m.claims.length);
  if (working.length) {
    lines.push('| Who | Task | Files | Branch | Since | Last active |', '|---|---|---|---|---|---|');
    for (const m of working) {
      const devices = new Set(m.claims.map((c) => c.device)).size > 1; // only worth saying when it differs
      for (const c of m.claims) {
        const flags = [c.stale && '⚠️ stale', c.mergedPr && `PR #${c.mergedPr} merged`, devices && c.device && `on ${c.device}`].filter(Boolean);
        const files = c.paths.slice(0, 4).map((p) => `\`${cell(p)}\``).join(', ') + (c.paths.length > 4 ? `, +${c.paths.length - 4}` : '');
        lines.push(
          `| **${cell(m.user)}** | ${cell(c.task)}${flags.length ? ` (${flags.join(', ')})` : ''} | ${files} | ${c.branch ? `\`${cell(c.branch)}\`` : ''} | ${day(c.started)} | ${day(c.updated)} |`,
        );
      }
    }
  } else lines.push('Nobody has claimed any work right now.');
  if (idle.length) lines.push('', `Not working on anything claimed: ${idle.map((m) => m.user).join(', ')}.`);
  if (data.votes?.length) {
    lines.push('', '## Open votes', '');
    for (const v of data.votes) {
      const what = v.urgent ? '🔔 Decision needed' : v.kind === 'pick' ? 'Pick vote' : 'Decision check';
      const where = v.state === 'open' ? `waiting on ${v.waitingOn.join(', ')}` : 'counted, outcome to record';
      lines.push(`- ${what}: ${cell(v.title)} (${v.by}) — ${where}`);
    }
  }
  if (data.handoffs.length) {
    lines.push('', '## Handoffs waiting to be picked up', '');
    for (const h of data.handoffs) lines.push(`- ${h.from} → ${h.to.join(', ')}: ${cell(h.title)} (${day(h.created)})`);
  }
  if (data.notes.length) {
    lines.push('', '## Recent team notes', '');
    for (const n of data.notes) lines.push(`- ${n.user}: ${cell(n.title)} (${day(n.created)})`);
  }
  return `${lines.join('\n')}\n`;
}

/** Rewrite README.md in the state worktree from its current state; true if it changed. */
export async function writeBoard(dir) {
  const file = path.join(dir, BOARD_FILE);
  const text = boardMarkdown(await boardData(dir));
  const old = await readFile(file, 'utf8').catch(() => null);
  if (old === text) return false;
  await writeFile(file, text);
  return true;
}

setBoardWriter(writeBoard);
