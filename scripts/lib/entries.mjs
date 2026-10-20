// Decisions, notes, and handoffs (PLAN §4, Phase 3). Each is an append-only
// file written once by its author: <kind>/<ts>--<user>--<slug>.md.

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { commitAndPush, git } from './git.mjs';
import { slugify } from './identity.mjs';
import { formatFrontmatter, parseFrontmatter } from './state.mjs';
import { now } from './util.mjs';
import { currentBranchOrNull, defaultBranch, dirtyFiles } from './workflow.mjs';
import { activeClaims, listClaims } from './claims.mjs';

export const KINDS = { decision: 'decisions', note: 'notes', handoff: 'handoffs', pitch: 'pitches' };

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // 20261014-094312

export async function listEntries(dir, kind) {
  const sub = path.join(dir, KINDS[kind]);
  if (!existsSync(sub)) return [];
  const out = [];
  for (const f of (await readdir(sub)).filter((f) => f.endsWith('.md')).sort()) {
    try {
      const { data, body } = parseFrontmatter(await readFile(path.join(sub, f), 'utf8'));
      out.push({ ...data, id: f.slice(0, -3), kind, body: body.trim(), file: path.posix.join(KINDS[kind], f) });
    } catch {
      // Skip unreadable entries.
    }
  }
  return out;
}

async function addEntry(team, kind, data, body, slugSource) {
  const at = now(team.env);
  const slug = slugify(slugSource).slice(0, 40) || kind;
  const id = `${stamp(at)}--${team.me.user}--${slug}`;
  const rel = path.posix.join(KINDS[kind], `${id}.md`);
  const file = path.join(team.dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  const entry = { user: team.me.user, created: at.toISOString(), ...data };
  await writeFile(file, formatFrontmatter(entry, body));
  await commitAndPush(team.dir, team.remote, [rel], `multiplayer: ${team.me.user} ${kind} ${slug}`, {
    timeout: team.timeout,
  });
  return { ...entry, id, kind, body: body.trim(), file: rel };
}

/** Entries not replaced by a later one's `supersedes`. */
export function current(entries) {
  const replaced = new Set(entries.map((e) => e.supersedes).filter(Boolean));
  return entries.filter((e) => !replaced.has(e.id));
}

/** Record an ADR. Body sections: Context, Decision, Consequences, Alternatives. */
export async function decide(team, { title, body, supersedes }) {
  if (!title?.trim()) throw new Error('A decision needs a title (a one-line summary).');
  if (!body?.trim()) throw new Error('A decision needs a body (context, decision, consequences, alternatives).');
  if (supersedes) {
    const all = await listEntries(team.dir, 'decision');
    if (!all.some((d) => d.id === supersedes)) throw new Error(`No decision "${supersedes}" to supersede.`);
  }
  return addEntry(team, 'decision', { title: title.trim(), supersedes }, body, title);
}

/** Post a team note to everyone. The first line is its headline. */
export async function note(team, { text }) {
  if (!text?.trim()) throw new Error('A note needs text.');
  const headline = text.trim().split('\n')[0].slice(0, 120);
  return addEntry(team, 'note', { title: headline }, text, headline);
}

/** Pitch an idea to the team. The first line is its name; the rest is the pitch. */
export async function pitch(team, { text }) {
  if (!text?.trim()) throw new Error('A pitch needs text: a name on the first line, then the idea.');
  const [first, ...rest] = text.trim().split('\n');
  if (!rest.join('').trim()) throw new Error('A pitch needs more than a name: describe the idea below the first line.');
  return addEntry(team, 'pitch', { title: first.replace(/^#+\s*/, '').slice(0, 120) }, rest.join('\n'), first);
}

/**
 * Pass my work to a teammate (PLAN §2.7: only when asked). Pushes the current
 * task branch so they can continue on it; the recipient's next session start
 * accepts the claim. Returns { handoff, pushed }.
 */
export async function handoff(team, { to, title, body, claim: claimSlug }) {
  const { root, remote, me } = team;
  const recipient = String(to ?? '').trim().toLowerCase();
  if (!recipient) throw new Error('A handoff needs a recipient (a teammate username).');
  if (recipient === me.user) throw new Error("You can't hand work to yourself.");
  const member = team.members.find((m) => m.user === recipient && m.active !== false);
  if (!member) {
    const names = team.members.filter((m) => m.user !== me.user).map((m) => m.user);
    throw new Error(`"${recipient}" isn't on the team. Teammates: ${names.join(', ') || 'none'}.`);
  }
  if (!body?.trim()) throw new Error('A handoff needs notes: what changed, why, open questions, next steps, gotchas.');

  const base = await defaultBranch(root, remote, team.config);
  const branch = await currentBranchOrNull(root);
  const mine = activeClaims(await listClaims(team.dir)).filter((c) => c.user === me.user);
  const claimed = claimSlug
    ? mine.find((c) => c.slug === claimSlug || c.id === claimSlug)
    : mine.find((c) => c.branch === branch) ?? (mine.length === 1 ? mine[0] : null);
  if (claimSlug && !claimed) throw new Error(`You have no claim "${claimSlug}".`);

  let pushed = false;
  const handBranch = claimed?.branch ?? branch;
  if (handBranch && handBranch !== base) {
    if (handBranch === branch) {
      const dirty = await dirtyFiles(root);
      if (dirty.length) throw new Error(`Commit your changes before handing off (${dirty.join(', ')}).`);
    }
    await git(['push', '--quiet', '-u', remote, handBranch], { cwd: root, timeout: team.timeout });
    pushed = true;
  }
  const entry = await addEntry(
    team,
    'handoff',
    {
      title: title?.trim() || claimed?.task || 'Handoff',
      to: [recipient],
      claim: claimed?.id ?? null,
      branch: handBranch && handBranch !== base ? handBranch : null,
    },
    body,
    claimed?.slug || title || 'handoff',
  );
  return { handoff: entry, pushed, claim: claimed ?? null };
}
