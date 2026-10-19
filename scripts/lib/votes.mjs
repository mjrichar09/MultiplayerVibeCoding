// Pitches and votes (PLAN §2.11): the team pitches ideas, then decides by
// vote: a "pick" vote ranks options (pitches) into a shortlist, a "decide"
// vote checks a few decision points for agreement. `escalate` is an urgent
// one-question decide vote. Everything lives on the shared state branch,
// one writer per file:
//
//   votes/<id>/vote.json            the frozen question(s), by whoever opened it
//   votes/<id>/ballot--<user>.json  each voter's answers
//   votes/<id>/results--<user>.json the count, by whoever counted (deterministic)
//   votes/<id>/closed--<user>.json  the outcome once it's settled
//
// Ballots are ordinary files on the branch: "sealed" means the plugin never
// shows one to anyone else before the results are in.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAndPush } from './git.mjs';
import { slugify } from './identity.mjs';
import { now } from './util.mjs';

export const FEELINGS = { love: 3, like: 2, unsure: 1, no: 0 };
const RANK_POINTS = [3, 2, 1];
const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));

/** Every vote with who has voted, its results, and its state: open | counted | closed. */
export async function listVotes(dir) {
  const root = path.join(dir, 'votes');
  if (!existsSync(root)) return [];
  const votes = [];
  for (const id of (await readdir(root)).sort()) {
    const folder = path.join(root, id);
    try {
      const vote = await readJson(path.join(folder, 'vote.json'));
      const files = await readdir(folder);
      const ballots = {};
      let results = null;
      let closed = null;
      for (const f of files.sort()) {
        if (f.startsWith('ballot--')) {
          const b = await readJson(path.join(folder, f));
          ballots[b.user] = b;
        } else if (f.startsWith('results--')) results ??= await readJson(path.join(folder, f));
        else if (f.startsWith('closed--')) closed ??= await readJson(path.join(folder, f));
      }
      const voted = vote.voters.filter((u) => ballots[u]);
      votes.push({
        ...vote,
        id,
        ballots,
        voted,
        waitingOn: vote.voters.filter((u) => !ballots[u]),
        results,
        closed,
        state: closed ? 'closed' : results ? 'counted' : 'open',
      });
    } catch {
      // Skip a half-written or unreadable vote.
    }
  }
  return votes;
}

export async function findVote(dir, ref) {
  const votes = await listVotes(dir);
  if (!ref) throw new Error('Which vote? Pass its id (see `multiplayer vote list`).');
  const hit = votes.find((v) => v.id === ref) ?? votes.filter((v) => v.id.endsWith(`--${ref}`) || v.id.includes(ref)).at(-1);
  if (!hit) throw new Error(`No vote "${ref}". Open votes: ${votes.filter((v) => v.state !== 'closed').map((v) => v.id).join(', ') || 'none'}.`);
  return hit;
}

/** Strip other people's ballots from a vote until it's counted. */
export function sealed(vote, me) {
  if (vote.state !== 'open') return vote;
  return { ...vote, ballots: vote.ballots[me] ? { [me]: vote.ballots[me] } : {} };
}

function check(spec) {
  if (!spec.title?.trim()) throw new Error('A vote needs a title.');
  if (spec.kind === 'decide') {
    if (!spec.questions?.length) throw new Error('A decide vote needs at least one question.');
    spec.questions.forEach((q, i) => {
      q.id ??= `q${i + 1}`;
      if (!q.text?.trim()) throw new Error(`Question ${q.id} needs text.`);
      if (!q.options?.length || q.options.length < 2) throw new Error(`Question ${q.id} needs at least two options.`);
    });
  } else if (spec.kind === 'pick') {
    if (!spec.options?.length || spec.options.length < 2) throw new Error('A pick vote needs at least two options.');
    spec.options.forEach((o, i) => {
      o.id = String(o.id ?? i + 1);
      if (!o.name?.trim()) throw new Error(`Option ${o.id} needs a name.`);
    });
    (spec.context ?? []).forEach((q, i) => {
      q.id ??= `c${i + 1}`;
    });
  } else throw new Error('A vote is either "decide" (decision points) or "pick" (choose between options).');
}

/** Open a vote. spec: { kind, title, urgent?, voters?, questions? | options?, context? }. */
export async function openVote(team, spec) {
  check(spec);
  const voters = (spec.voters?.length ? spec.voters : team.members.filter((m) => m.active !== false).map((m) => m.user)).map((u) =>
    String(u).trim().toLowerCase(),
  );
  const unknown = voters.filter((u) => !team.members.some((m) => m.user === u));
  if (unknown.length) throw new Error(`Not on the team: ${unknown.join(', ')}.`);
  const at = now(team.env);
  const id = `${stamp(at)}--${team.me.user}--${slugify(spec.title).slice(0, 40) || spec.kind}`;
  const vote = {
    kind: spec.kind,
    title: spec.title.trim(),
    urgent: Boolean(spec.urgent),
    by: team.me.user,
    created: at.toISOString(),
    voters: [...new Set(voters)],
    ...(spec.kind === 'decide' ? { questions: spec.questions } : { options: spec.options, context: spec.context ?? [] }),
  };
  const rel = path.posix.join('votes', id, 'vote.json');
  await mkdir(path.join(team.dir, 'votes', id), { recursive: true });
  await writeFile(path.join(team.dir, rel), `${JSON.stringify(vote, null, 2)}\n`);
  await commitAndPush(team.dir, team.remote, [rel], `multiplayer: ${team.me.user} ${vote.urgent ? 'escalate' : 'open vote'} ${id}`, {
    timeout: team.timeout,
  });
  return { ...vote, id };
}

function checkBallot(vote, ballot) {
  if (vote.kind === 'decide') {
    for (const q of vote.questions) {
      const a = ballot.answers?.[q.id];
      if (!a) throw new Error(`No answer for ${q.id} ("${q.text}").`);
      const known = q.options.some((o) => o.label === a.choice);
      if (!known && !a.other?.trim()) throw new Error(`${q.id}: "${a.choice}" isn't an option; give it as "other" text instead.`);
    }
  } else {
    const ids = new Set(vote.options.map((o) => o.id));
    for (const o of vote.options) {
      if (!(ballot.feelings?.[o.id] in FEELINGS)) throw new Error(`No gut feeling (love, like, unsure, no) for option ${o.id} "${o.name}".`);
    }
    const top = ballot.top ?? [];
    if (!top.length || top.length > 3 || top.some((t) => !ids.has(String(t))) || new Set(top).size !== top.length) {
      throw new Error('"top" must list one to three different option ids, first choice first.');
    }
    if (ballot.veto && !ids.has(String(ballot.veto))) throw new Error(`Veto "${ballot.veto}" isn't an option.`);
  }
}

/** Cast (or replace, until it's counted) my ballot. Returns the vote as it now stands. */
export async function castBallot(team, ref, ballot) {
  const vote = await findVote(team.dir, ref);
  const me = team.me.user;
  if (!vote.voters.includes(me)) throw new Error(`You're not a voter on "${vote.title}" (voters: ${vote.voters.join(', ')}).`);
  if (vote.state !== 'open') throw new Error(`"${vote.title}" has already been counted.`);
  checkBallot(vote, ballot);
  const rel = path.posix.join('votes', vote.id, `ballot--${me}.json`);
  const record = { ...ballot, user: me, at: now(team.env).toISOString() };
  await writeFile(path.join(team.dir, rel), `${JSON.stringify(record, null, 2)}\n`);
  await commitAndPush(team.dir, team.remote, [rel], `multiplayer: ${me} voted on ${vote.id}`, { timeout: team.timeout });
  return findVote(team.dir, vote.id);
}

/** The count, from the ballots alone (so any two counters write the same file). */
export function tally(vote) {
  const voted = vote.voters.filter((u) => vote.ballots[u]);
  if (vote.kind === 'decide') {
    return {
      kind: 'decide',
      voted,
      missing: vote.waitingOn,
      questions: vote.questions.map((q) => {
        const answers = voted.map((u) => ({ user: u, ...vote.ballots[u].answers[q.id] }));
        const choices = new Set(answers.map((a) => (a.other?.trim() ? `other:${a.other.trim()}` : a.choice)));
        const anyOther = answers.some((a) => a.other?.trim());
        // "review": someone wrote their own answer, so Claude judges whether it's close to the others.
        const status = choices.size === 1 && !anyOther ? 'agreed' : anyOther ? 'review' : 'differ';
        return { id: q.id, text: q.text, status, answers };
      }),
      notes: voted.filter((u) => vote.ballots[u].note).map((u) => ({ user: u, note: vote.ballots[u].note })),
    };
  }
  const firsts = (id) => voted.filter((u) => String(vote.ballots[u].top[0]) === id).length;
  const rows = vote.options.map((o) => {
    let total = 0;
    const per = voted.map((u) => {
      const b = vote.ballots[u];
      const rank = b.top.map(String).indexOf(o.id);
      total += FEELINGS[b.feelings[o.id]] + (rank >= 0 ? RANK_POINTS[rank] : 0);
      return { user: u, feeling: b.feelings[o.id], rank: rank >= 0 ? rank + 1 : null, veto: String(b.veto ?? '') === o.id };
    });
    const vetoedBy = per.filter((p) => p.veto).map((p) => p.user);
    const rankedFirst = firsts(o.id);
    // A veto drops an option, unless someone else put it first: then it's a question for the team.
    const vetoState = !vetoedBy.length ? null : per.some((p) => p.rank === 1 && !p.veto) ? 'disputed' : 'out';
    return { id: o.id, name: o.name, total, firsts: rankedFirst, vetoedBy, vetoState, unanimousFirst: rankedFirst === voted.length && voted.length > 1, per };
  });
  const eligible = rows.filter((r) => r.vetoState !== 'out').sort((a, b) => b.total - a.total || b.firsts - a.firsts);
  const cutoff = eligible[1];
  // A tie only matters when it straddles the shortlist's edge (second place vs third).
  const level = (r) => cutoff && r.total === cutoff.total && r.firsts === cutoff.firsts;
  const tied = eligible.slice(2).some(level) ? eligible.filter(level).map((r) => r.id) : [];
  return {
    kind: 'pick',
    voted,
    missing: vote.waitingOn,
    shortlist: eligible.slice(0, 2).map((r) => r.id),
    tiedAtCutoff: tied,
    rows: rows.sort((a, b) => b.total - a.total || b.firsts - a.firsts),
    context: voted.map((u) => ({ user: u, answers: vote.ballots[u].context ?? {}, why: vote.ballots[u].why ?? '' })),
  };
}

/** Count once everyone has voted (or `force` to count what's in). Writes the results. */
export async function countVote(team, ref, { force = false } = {}) {
  const vote = await findVote(team.dir, ref);
  if (vote.results) return vote;
  if (vote.waitingOn.length && !force) throw new Error(`Still waiting on ${vote.waitingOn.join(', ')}.`);
  if (!vote.voted.length) throw new Error('Nobody has voted yet.');
  const rel = path.posix.join('votes', vote.id, `results--${team.me.user}.json`);
  await writeFile(path.join(team.dir, rel), `${JSON.stringify(tally(vote), null, 2)}\n`);
  await commitAndPush(team.dir, team.remote, [rel], `multiplayer: count ${vote.id}`, { timeout: team.timeout });
  return findVote(team.dir, vote.id);
}

/** Mark a vote settled: which decisions it led to, and a line on how. */
export async function closeVote(team, ref, { decisions = [], outcome = '' } = {}) {
  const vote = await findVote(team.dir, ref);
  if (vote.state === 'closed') return vote;
  const rel = path.posix.join('votes', vote.id, `closed--${team.me.user}.json`);
  const record = { by: team.me.user, at: now(team.env).toISOString(), decisions, outcome };
  await writeFile(path.join(team.dir, rel), `${JSON.stringify(record, null, 2)}\n`);
  await commitAndPush(team.dir, team.remote, [rel], `multiplayer: ${team.me.user} closed ${vote.id}`, { timeout: team.timeout });
  return findVote(team.dir, vote.id);
}

/** One line per unsettled vote, for briefings and boards. Never reveals a ballot. */
export function voteSummary(vote, me) {
  const tag = vote.urgent ? 'Decision needed' : vote.kind === 'pick' ? 'Pick vote' : 'Decision check';
  if (vote.state === 'open') {
    const mine = vote.waitingOn.includes(me);
    const others = vote.waitingOn.filter((u) => u !== me);
    const waiting = mine ? `waiting on you${others.length ? ` and ${others.join(', ')}` : ''}` : `waiting on ${others.join(', ')}`;
    return { mine, urgent: vote.urgent, text: `${tag}: "${vote.title}" (${vote.by}) — ${waiting}` };
  }
  const r = vote.results;
  const open =
    r.kind === 'decide'
      ? r.questions.filter((q) => q.status !== 'agreed').length
      : r.tiedAtCutoff.length || r.rows.some((x) => x.vetoState === 'disputed') ? 1 : 0;
  const what =
    r.kind === 'decide'
      ? `${r.questions.length - open} agreed${open ? `, ${open} to talk out` : ''}`
      : `shortlist: ${r.shortlist.map((id) => vote.options.find((o) => o.id === id)?.name).join(', ')}`;
  return { mine: false, urgent: vote.urgent, text: `${tag}: "${vote.title}" counted — ${what}; record the outcome` };
}
