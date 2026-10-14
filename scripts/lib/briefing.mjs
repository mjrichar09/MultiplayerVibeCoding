// The team briefing shown at session start and by `status` (PLAN §2.6):
// prioritized, grouped per teammate, and capped regardless of team size.
// Priority: handoffs to me → claims overlapping mine → new decisions →
// recent notes → other teammates' claims.

import { activeClaims, isStale, mergedPr, prOverlaps } from './claims.mjs';
import { current } from './entries.mjs';
import { patternsOverlap } from './glob.mjs';
import { DAY_MS, ago } from './util.mjs';

export const BRIEFING_LINE_CAP = 40;
const MAX_OVERLAP_LINES = 8;
const MAX_PR_LINES = 5;
const MAX_HANDOFF_BODY_LINES = 8;
const DECISION_DAYS = 14;

export const STANDING_RULES = [
  'How to work with your team (multiplayer plugin) — mention each multiplayer action to the user in one line:',
  '- Claim before your first edit on a new task (multiplayer:claim, narrow paths); extend the claim if the work grows. Ask the user before editing files a teammate has claimed.',
  '- Git: commit at checkpoints; work only on your task branch; never force-push, rebase, or commit to the default branch. If told the default branch changed your files, commit and use multiplayer:update.',
  '- When done: push, open a PR, squash-merge once approved; the claim and branch clean up automatically. Release by hand (multiplayer:release) only for work that ends without a PR.',
  '- Record settled design choices with multiplayer:decide (the user agreed, or an alternative was rejected for a reason). Post things teammates need (broken setup, flaky test, changed command) with multiplayer:note.',
  '- If the user says they will be away, are stopping for a while, are stuck, or someone else should continue, offer a handoff to a fitting teammate (e.g. one with related claims). Use multiplayer:handoff only if they agree.',
  '- Delegating? Claim the whole task first and give each worker distinct files; workers leave git and claims to you. Subagents need nothing more; for parallel sessions (Orca, herdr, terminals) use multiplayer:delegate.',
];

export function workerRules(role) {
  const assigned = role?.paths?.length ? ` (${role.paths.join(', ')})` : '';
  return [
    `You are a worker agent${role?.lead ? ` under ${role.lead}'s lead session` : ''} (multiplayer plugin):`,
    `- Edit only the files you were assigned${assigned}. Leave git (commits, branches, merges, pushes), PRs, claims, decisions, and handoffs to your lead.`,
    '- If a warning says a teammate or another agent is working on a file, stop and tell your lead.',
    '- When done, report what you changed and anything teammates should know; your lead records it.',
  ];
}

const pathList = (paths, max = 3) =>
  `[${paths.slice(0, max).join(', ')}${paths.length > max ? `, +${paths.length - max}` : ''}]`;

function describeClaim(c, ctx) {
  const flags = [];
  if (c.handoff) flags.push(`handed over by ${c.supersedes?.split('--')[0] ?? 'a teammate'}`);
  else if (c.supersedes) flags.push(`took over ${c.supersedes.split('--')[0]}'s claim`);
  const pending = ctx.pendingHandoffs?.get(c.id);
  if (pending) flags.push(`handing off to ${pending.to.join(', ')}`);
  const pr = mergedPr(c, ctx.prCache);
  if (pr) flags.push(`PR #${pr.number} merged${c.keep ? ', kept open' : ''}`);
  const quiet = `for ${ago(c.updated ?? c.started, ctx.at).replace(/ ago$/, '')}`;
  if (isStale(c, ctx.config, ctx.at)) {
    flags.push(c.user === ctx.me ? `STALE, no activity ${quiet}: finish it, release it, or offer a handoff` : `STALE, no activity ${quiet}`);
  } else if (c.user === ctx.me && isIdle(c, ctx)) flags.push(`no activity ${quiet}: finish it, release it, or offer a handoff`);
  if (ctx.lastSeen && new Date(c.started) > new Date(ctx.lastSeen) && c.user !== ctx.me) flags.push('new');
  const where = [c.branch, c.issue ? `#${c.issue}` : null, `updated ${ago(c.updated ?? c.started, ctx.at)}`]
    .filter(Boolean)
    .join(', ');
  return `- ${c.slug}: ${c.task} ${pathList(c.paths)} (${where})${flags.length ? ` — ${flags.join('; ')}` : ''}`;
}

// My claim is getting quiet: a day before it would turn stale.
function isIdle(c, ctx) {
  const days = Math.max(1, (ctx.config.staleClaimDays ?? 3) - 1);
  return ctx.at - new Date(c.updated ?? c.started) > days * DAY_MS;
}

const firstLine = (text) => (text ?? '').split('\n').find((l) => l.trim()) ?? '';

/** Take whole items (each an array of lines) while they fit in `budget`. */
function fill(items, budget) {
  const lines = [];
  let hidden = 0;
  for (const item of items) {
    if (lines.length + item.length <= budget) lines.push(...item);
    else hidden++;
  }
  return { lines, hidden };
}

/**
 * Render the briefing. ctx: { me, members, claims, decisions, notes, handoffs,
 * readHandoffs, config, prCache, at, lastSeen, events, cap, rules, filterUser }.
 * Returns an array of lines.
 */
export function renderBriefing(ctx) {
  const cap = ctx.cap ?? BRIEFING_LINE_CAP;
  const full = cap === Infinity;
  const rules = ctx.rules === false ? [] : ctx.role ? workerRules(ctx.role) : STANDING_RULES;
  const at = ctx.at;
  const active = activeClaims(ctx.claims);
  const handoffs = ctx.handoffs ?? [];
  const accepted = new Set(ctx.claims.map((c) => c.handoff).filter(Boolean));
  ctx.pendingHandoffs = new Map(
    handoffs.filter((h) => h.claim && !accepted.has(h.id) && active.some((c) => c.id === h.claim)).map((h) => [h.claim, h]),
  );
  const teammates = ctx.members.filter((m) => m.active !== false && m.user !== ctx.me).map((m) => m.user);

  // --- always shown
  const head = [`multiplayer · you are ${ctx.me} · teammates (${teammates.length}): ${teammates.join(', ') || 'none yet'}`];
  for (const e of ctx.events ?? []) head.push(`Just now: ${e}`);

  const read = new Set(ctx.readHandoffs ?? []);
  const recent = (iso) => at - new Date(iso) < DECISION_DAYS * DAY_MS;
  const toMe = handoffs.filter((h) => h.to?.includes(ctx.me) && (full ? recent(h.created) : !read.has(h.id)));
  for (const h of toMe) {
    head.push(`📨 Handoff from ${h.user} (${ago(h.created, at)}): ${h.title}${h.branch ? ` — branch ${h.branch}` : ''}`);
    const body = h.body.split('\n').filter((l) => l.trim());
    const n = full ? body.length : MAX_HANDOFF_BODY_LINES;
    head.push(...body.slice(0, n).map((l) => `    ${l}`));
    if (body.length > n) head.push(`    … full handoff: .multiplayer/${h.file}`);
  }

  const mine = active.filter((c) => c.user === ctx.me);
  const others = active.filter((c) => c.user !== ctx.me && (!ctx.filterUser || c.user === ctx.filterUser));
  const myPaths = mine.flatMap((c) => c.paths);
  const overlapping = others.filter(
    (c) => !mergedPr(c, ctx.prCache) && c.paths.some((p) => myPaths.some((m) => patternsOverlap(m, p))),
  );
  if (!ctx.filterUser) {
    head.push(mine.length ? 'Your claims:' : 'You have no active claims.');
    for (const c of mine) head.push(describeClaim(c, ctx));
  }
  if (overlapping.length) {
    head.push('⚠️ Teammate claims overlapping yours — coordinate before editing shared files:');
    const n = full ? overlapping.length : MAX_OVERLAP_LINES;
    for (const c of overlapping.slice(0, n)) head.push(`- ${c.user} · ${describeClaim(c, ctx).slice(2)}`);
    if (overlapping.length > n) head.push(`- +${overlapping.length - n} more overlapping claims`);
  }
  const prHits = myPaths.length ? prOverlaps(myPaths, { prCache: ctx.prCache, claims: ctx.claims, members: ctx.members, me: ctx.me }) : [];
  if (prHits.length && !ctx.filterUser) {
    head.push("⚠️ Teammates' open PRs change files you've claimed — expect conflicts; coordinate or update after they merge:");
    const n = full ? prHits.length : MAX_PR_LINES;
    for (const { pr, owner, files } of prHits.slice(0, n)) {
      const shown = files.slice(0, 2).join(', ') + (files.length > 2 ? `, +${files.length - 2} more` : '');
      head.push(`- ${owner} · PR #${pr.number}${pr.isDraft ? ' (draft)' : ''}${pr.title ? ` "${pr.title}"` : ''}: ${shown}`);
    }
    if (prHits.length > n) head.push(`- +${prHits.length - n} more PRs`);
  }

  // --- budgeted sections, in priority order
  let budget = cap - head.length - (rules.length ? rules.length + 1 : 0);
  // Keep one line so teammates' claims are at least summarized.
  const shownIds = new Set(overlapping.map((c) => c.id));
  const reserve = others.some((c) => !shownIds.has(c.id)) ? 1 : 0;
  budget -= reserve;
  const sections = [];
  const more = (n, what) => `+${n} more ${what} — use the multiplayer:status skill to see all.`;

  const isNew = (iso) => (ctx.lastSeen && !full ? new Date(iso) > new Date(ctx.lastSeen) : recent(iso));
  const decisions = current(ctx.decisions ?? [])
    .filter((d) => (full || d.user !== ctx.me) && isNew(d.created))
    .filter((d) => !ctx.filterUser || d.user === ctx.filterUser)
    .reverse();
  if (decisions.length && budget > 2) {
    const { lines, hidden } = fill(
      decisions.map((d) => [`- ${d.title} — ${d.user}, ${ago(d.created, at)}${d.supersedes ? ' (replaces an earlier decision)' : ''} [${d.id}]`]),
      budget - 2,
    );
    sections.push(full ? `Decisions (last ${DECISION_DAYS} days):` : 'New team decisions (details in .multiplayer/decisions/):', ...lines);
    if (hidden) sections.push(more(hidden, 'decisions'));
    budget -= 1 + lines.length + (hidden ? 1 : 0);
  }

  const noteDays = ctx.config.noteDays ?? 3;
  const notes = (ctx.notes ?? [])
    .filter((n) => (full || n.user !== ctx.me) && at - new Date(n.created) < noteDays * DAY_MS)
    .filter((n) => !ctx.filterUser || n.user === ctx.filterUser)
    .reverse();
  if (notes.length && budget > 2) {
    const { lines, hidden } = fill(
      notes.map((n) => [`- ${n.user} (${ago(n.created, at)}): ${full ? n.body.replace(/\n+/g, ' ') : firstLine(n.body)}`]),
      budget - 2,
    );
    sections.push('Team notes:', ...lines);
    if (hidden) sections.push(more(hidden, 'notes'));
    budget -= 1 + lines.length + (hidden ? 1 : 0);
  }

  // Remaining teammate claims, grouped per person, most recently active first.
  budget += reserve;
  const shown = shownIds;
  const byUser = new Map();
  for (const c of others.filter((c) => !shown.has(c.id))) {
    if (!byUser.has(c.user)) byUser.set(c.user, []);
    byUser.get(c.user).push(c);
  }
  const time = (c) => new Date(c.updated ?? c.started).getTime();
  const groups = [...byUser.entries()]
    .map(([user, cs]) => [user, cs.sort((a, b) => time(b) - time(a))])
    .sort((a, b) => time(b[1][0]) - time(a[1][0]));
  if (groups.length && budget > 2) {
    sections.push(ctx.filterUser ? `${ctx.filterUser}'s claims:` : "Teammates' claims:");
    budget -= 2; // header + room for "+N more"
    const hidden = new Map();
    for (const [user, cs] of groups) {
      if (budget >= 2) {
        sections.push(`${user} (${cs.length}):`);
        budget -= 1;
        for (const c of cs) {
          if (budget >= 1) {
            sections.push(`  ${describeClaim(c, ctx)}`);
            budget -= 1;
          } else hidden.set(user, (hidden.get(user) ?? 0) + 1);
        }
      } else hidden.set(user, (hidden.get(user) ?? 0) + cs.length);
    }
    if (hidden.size) {
      const n = [...hidden.values()].reduce((a, b) => a + b, 0);
      sections.push(`+${n} more claim${n === 1 ? '' : 's'} from ${[...hidden.keys()].join(', ')} — use the multiplayer:status skill to see all.`);
    }
  } else if (groups.length) {
    sections.push(more(groups.reduce((a, [, cs]) => a + cs.length, 0), 'teammate claims'));
  }

  const lines = [...head, ...sections];
  if (rules.length) lines.push('', ...rules);
  return lines;
}
