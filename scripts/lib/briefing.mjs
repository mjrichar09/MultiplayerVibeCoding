// The team briefing shown at session start and by `status` (PLAN §2.6):
// grouped per teammate, prioritized, and capped regardless of team size.

import { activeClaims, isStale, mergedPr } from './claims.mjs';
import { patternsOverlap } from './glob.mjs';
import { ago } from './util.mjs';

export const BRIEFING_LINE_CAP = 40;
const MAX_OVERLAP_LINES = 8;

export const STANDING_RULES = [
  'How to work with your team (multiplayer plugin):',
  '- Before your first edit on a new task, claim it with the multiplayer:claim skill, using narrow paths. Extend your claim if the work grows.',
  "- If a teammate's claim covers a file you need to change, tell the user before editing it.",
  '- Claims release automatically when their PR merges. If you abandon or finish work without a PR, release it with the multiplayer:release skill.',
  '- Git: commit at natural checkpoints. Work only on your task branch (claiming creates it). Never force-push, rebase, or commit directly to the default branch.',
  '- When a task is done: push, open a PR, and squash-merge it once approved. The claim releases and the branch cleans up automatically.',
  '- If told the default branch has new changes to your files, commit and use the multiplayer:update skill at your next checkpoint.',
  '- Mention each multiplayer action to the user in one line.',
];

const pathList = (paths, max = 3) =>
  `[${paths.slice(0, max).join(', ')}${paths.length > max ? `, +${paths.length - max}` : ''}]`;

function describe(c, ctx) {
  const flags = [];
  if (c.supersedes) flags.push(`took over ${c.supersedes.split('--')[0]}'s claim`);
  const pr = mergedPr(c, ctx.prCache);
  if (pr) flags.push(`PR #${pr.number} merged${c.keep ? ', kept open' : ''}`);
  if (isStale(c, ctx.config, ctx.at)) flags.push(`STALE, no activity ${ago(c.updated ?? c.started, ctx.at)}`);
  if (ctx.lastSeen && new Date(c.started) > new Date(ctx.lastSeen) && c.user !== ctx.me) flags.push('new');
  const where = [c.branch, c.issue ? `#${c.issue}` : null, `updated ${ago(c.updated ?? c.started, ctx.at)}`]
    .filter(Boolean)
    .join(', ');
  return `- ${c.slug}: ${c.task} ${pathList(c.paths)} (${where})${flags.length ? ` — ${flags.join('; ')}` : ''}`;
}

/**
 * Render the briefing. ctx: { me, members, claims, config, prCache, at,
 * lastSeen, events, cap, rules }. Returns an array of lines.
 */
export function renderBriefing(ctx) {
  const cap = ctx.cap ?? BRIEFING_LINE_CAP;
  const rules = ctx.rules === false ? [] : STANDING_RULES;
  const active = activeClaims(ctx.claims);
  const teammates = ctx.members.filter((m) => m.active !== false && m.user !== ctx.me).map((m) => m.user);

  const head = [`multiplayer · you are ${ctx.me} · teammates (${teammates.length}): ${teammates.join(', ') || 'none yet'}`];
  for (const e of ctx.events ?? []) head.push(`Just now: ${e}`);

  const mine = active.filter((c) => c.user === ctx.me);
  const others = active.filter((c) => c.user !== ctx.me && (!ctx.filterUser || c.user === ctx.filterUser));
  const myPaths = mine.flatMap((c) => c.paths);
  const overlapping = others.filter(
    (c) => !mergedPr(c, ctx.prCache) && c.paths.some((p) => myPaths.some((m) => patternsOverlap(m, p))),
  );

  const body = [];
  if (!ctx.filterUser) {
    body.push(mine.length ? 'Your claims:' : 'You have no active claims.');
    for (const c of mine) body.push(describe(c, ctx));
  }
  if (overlapping.length) {
    body.push('⚠️ Teammate claims overlapping yours — coordinate before editing shared files:');
    for (const c of overlapping.slice(0, MAX_OVERLAP_LINES)) body.push(`- ${c.user} · ${describe(c, ctx).slice(2)}`);
    if (overlapping.length > MAX_OVERLAP_LINES) body.push(`- +${overlapping.length - MAX_OVERLAP_LINES} more overlapping claims`);
  }

  // Remaining teammate claims, grouped per person, most recently active first.
  const shown = new Set(overlapping.map((c) => c.id));
  const byUser = new Map();
  for (const c of others.filter((c) => !shown.has(c.id))) {
    if (!byUser.has(c.user)) byUser.set(c.user, []);
    byUser.get(c.user).push(c);
  }
  const latest = (cs) => Math.max(...cs.map((c) => new Date(c.updated ?? c.started).getTime()));
  const groups = [...byUser.entries()]
    .map(([user, cs]) => [user, cs.sort((a, b) => latest([b]) - latest([a]))])
    .sort((a, b) => latest(b[1]) - latest(a[1]));

  const fixed = head.length + body.length + (rules.length ? rules.length + 1 : 0);
  let budget = cap - fixed - 1; // keep a line for "+N more"
  const groupLines = [];
  const hidden = new Map();
  if (groups.length) groupLines.push(ctx.filterUser ? `${ctx.filterUser}'s claims:` : "Teammates' claims:");
  budget -= groupLines.length;
  for (const [user, cs] of groups) {
    if (budget >= 2) {
      groupLines.push(`${user} (${cs.length}):`);
      budget -= 1;
      for (const c of cs) {
        if (budget >= 1) {
          groupLines.push(`  ${describe(c, ctx)}`);
          budget -= 1;
        } else hidden.set(user, (hidden.get(user) ?? 0) + 1);
      }
    } else hidden.set(user, (hidden.get(user) ?? 0) + cs.length);
  }
  if (hidden.size) {
    const n = [...hidden.values()].reduce((a, b) => a + b, 0);
    groupLines.push(`+${n} more claim${n === 1 ? '' : 's'} from ${[...hidden.keys()].join(', ')} — use the multiplayer:status skill to see all.`);
  }

  const lines = [...head, ...body, ...groupLines];
  if (rules.length) lines.push('', ...rules);
  return lines;
}
