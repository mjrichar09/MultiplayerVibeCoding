// Project files the team shares through the code repo (PLAN Phase 5):
// the CLAUDE.md "Team decisions" block kept in sync with recorded decisions,
// and the scaffolded CLAUDE.md / .claude/settings.json / PR template.

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { current, listEntries } from './entries.mjs';
import { git } from './git.mjs';
import { currentBranchOrNull, defaultBranch, startTaskBranch } from './workflow.mjs';

const PLUGIN_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEMPLATES = path.join(PLUGIN_ROOT, 'templates');

export const BLOCK_START = '<!-- multiplayer:decisions:start (kept in sync by the multiplayer plugin; edit the decision files, not this list) -->';
export const BLOCK_END = '<!-- multiplayer:decisions:end -->';
const START_RE = /<!-- multiplayer:decisions:start[^>]*-->/;
const END_RE = /<!-- multiplayer:decisions:end -->/;
const DECISION_REF = /\.multiplayer\/decisions\/([^`\s)]+)\.md/g;

// ------------------------------------------------------------ decisions block

/** One line per current decision: title, its "## Decision" gist, author, date, file. */
function decisionLine(d) {
  const section = /##\s*Decision\s*\n+([\s\S]*?)(\n##|$)/i.exec(d.body ?? '');
  const gist = (section?.[1] ?? '').trim().split('\n')[0].replace(/\s+/g, ' ');
  const short = gist.length > 200 ? `${gist.slice(0, 197)}…` : gist;
  return `- **${d.title}**${short ? `: ${short}` : ''} (${d.user}, ${d.created.slice(0, 10)}; \`.multiplayer/decisions/${d.id}.md\`)`;
}

export function renderDecisionsBlock(decisions) {
  const live = current(decisions);
  const body = live.length ? live.map(decisionLine).join('\n') : '_No team decisions recorded yet._';
  return `## Team decisions\n${BLOCK_START}\n${body}\n${BLOCK_END}`;
}

/** Which current decisions the CLAUDE.md in `root` is missing, and which listed ones are outdated. */
export async function syncStatus(root, dir) {
  const file = path.join(root, 'CLAUDE.md');
  const live = current(await listEntries(dir, 'decision'));
  const text = existsSync(file) ? await readFile(file, 'utf8') : '';
  const listed = new Set([...text.matchAll(DECISION_REF)].map((m) => m[1]));
  const liveIds = new Set(live.map((d) => d.id));
  return {
    hasFile: Boolean(text),
    hasBlock: START_RE.test(text) && END_RE.test(text),
    missing: live.filter((d) => !listed.has(d.id)),
    outdated: [...listed].filter((id) => !liveIds.has(id)),
  };
}

/** Replace (or append) the decisions block. Also clears merge-conflict markers inside it. */
function withBlock(text, block) {
  const start = text.search(START_RE);
  const endMatch = [...text.matchAll(new RegExp(END_RE.source, 'g'))].pop();
  if (start !== -1 && endMatch) {
    // Include the "## Team decisions" heading (and any conflict marker) just above the start marker.
    const before = text.slice(0, start);
    const heading = before.lastIndexOf('## Team decisions');
    const from = heading !== -1 && !before.slice(heading).includes('\n## ', 1) ? heading : start;
    const cut = text.slice(0, from).replace(/(<<<<<<<[^\n]*\n|=======\n|>>>>>>>[^\n]*\n)+$/, '');
    const after = text.slice(endMatch.index + endMatch[0].length).replace(/^\n(=======|>>>>>>>[^\n]*)(\n|$)/, '\n');
    return `${cut}${block}${after}`;
  }
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

const hasConflictMarkers = (text) => /^(<<<<<<<|=======$|>>>>>>>)/m.test(text);

/**
 * Bring CLAUDE.md's decisions block up to date and commit it on the current
 * task branch (starting one if on the default branch). With `resolve`, only
 * rewrite the block to settle a merge conflict in it, and stage the file.
 * Returns { status: 'synced' | 'up-to-date' | 'resolved', added, removed, branch, branchCreated }.
 */
export async function syncClaudeMd(team, { resolve = false } = {}) {
  const { root, dir, me } = team;
  const file = path.join(root, 'CLAUDE.md');
  const decisions = await listEntries(dir, 'decision');
  const block = renderDecisionsBlock(decisions);
  const text = existsSync(file) ? await readFile(file, 'utf8') : `# ${path.basename(root)}\n`;

  if (resolve) {
    const next = withBlock(text, block);
    if (hasConflictMarkers(next)) throw new Error('CLAUDE.md has conflicts outside the decisions block; resolve those by hand.');
    await writeFile(file, next);
    await git(['add', 'CLAUDE.md'], { cwd: root });
    return { status: 'resolved' };
  }

  const before = await syncStatus(root, dir);
  if (before.hasBlock && !before.missing.length && !before.outdated.length) return { status: 'up-to-date' };

  const base = await defaultBranch(root, team.remote, team.config);
  let branch = await currentBranchOrNull(root);
  let branchCreated = false;
  if (!branch || branch === base) {
    ({ branch, created: branchCreated } = await startTaskBranch(root, team.remote, base, `${me.user}/sync-claude-md`));
  }
  await writeFile(file, withBlock(text, block));
  await git(['add', 'CLAUDE.md'], { cwd: root });
  await git(['commit', '--quiet', '-m', 'multiplayer: sync CLAUDE.md with team decisions', '--', 'CLAUDE.md'], { cwd: root });
  return {
    status: 'synced',
    added: before.missing.map((d) => d.title),
    removed: before.outdated,
    branch,
    branchCreated,
  };
}

// ------------------------------------------------------------------ scaffold

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

function pluginInfo() {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(manifest.repository ?? '')?.[1] ?? '';
  return { marketplace: marketplace.name, marketplaceRepo: repo };
}

async function skillRules() {
  const names = (await readdir(path.join(PLUGIN_ROOT, 'skills'))).sort();
  return names.map((n) => `"Skill(multiplayer:${n})", "Skill(multiplayer:${n} *)"`).join(',\n      ');
}

/** Union-merge the template's settings into existing settings without overriding anything set. */
function mergeSettings(existing, template) {
  const out = { ...existing };
  for (const key of ['extraKnownMarketplaces', 'enabledPlugins']) {
    out[key] = { ...template[key], ...(existing[key] ?? {}) };
  }
  const perms = { ...(existing.permissions ?? {}) };
  for (const key of ['allow', 'deny']) {
    perms[key] = [...new Set([...(perms[key] ?? []), ...template.permissions[key]])];
  }
  out.permissions = perms;
  return out;
}

const PR_TEMPLATE_PATHS = [
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/pull_request_template.md',
  'PULL_REQUEST_TEMPLATE.md',
  'pull_request_template.md',
  'docs/PULL_REQUEST_TEMPLATE.md',
  'docs/pull_request_template.md',
];

/**
 * Add the team's shared project files, never overwriting anything: create
 * missing files, append the multiplayer sections to an existing CLAUDE.md,
 * and union-merge settings. Commits on a task branch for review via PR.
 * Returns { branch, branchCreated, files: [{ file, action }] }.
 */
export async function scaffold(team) {
  const { root, dir, me } = team;
  const base = await defaultBranch(root, team.remote, team.config);
  const vars = {
    project: path.basename(root),
    defaultBranch: base,
    ...pluginInfo(),
    skillRules: await skillRules(),
  };
  vars.howWeWork = fill(await readFile(path.join(TEMPLATES, 'how-we-work.md'), 'utf8'), vars).trim();
  vars.decisions = renderDecisionsBlock(await listEntries(dir, 'decision'));
  const files = [];

  // CLAUDE.md
  const claudeMd = path.join(root, 'CLAUDE.md');
  if (!existsSync(claudeMd)) {
    await writeFile(claudeMd, `${fill(await readFile(path.join(TEMPLATES, 'CLAUDE.md.tmpl'), 'utf8'), vars).trim()}\n`);
    files.push({ file: 'CLAUDE.md', action: 'created' });
  } else {
    const text = await readFile(claudeMd, 'utf8');
    if (START_RE.test(text)) files.push({ file: 'CLAUDE.md', action: 'unchanged' });
    else {
      const extra = text.includes('## How we work (multiplayer)') ? vars.decisions : `${vars.howWeWork}\n\n${vars.decisions}`;
      await writeFile(claudeMd, `${text.replace(/\s*$/, '')}\n\n${extra}\n`);
      files.push({ file: 'CLAUDE.md', action: 'added the multiplayer sections' });
    }
  }

  // .claude/settings.json
  const settingsFile = path.join(root, '.claude', 'settings.json');
  const template = JSON.parse(fill(await readFile(path.join(TEMPLATES, 'settings.json.tmpl'), 'utf8'), vars));
  if (!existsSync(settingsFile)) {
    await mkdir(path.dirname(settingsFile), { recursive: true });
    await writeFile(settingsFile, `${JSON.stringify(template, null, 2)}\n`);
    files.push({ file: '.claude/settings.json', action: 'created' });
  } else {
    let existing;
    try {
      existing = JSON.parse(await readFile(settingsFile, 'utf8'));
    } catch {
      files.push({ file: '.claude/settings.json', action: 'skipped (not valid JSON; merge the template by hand)' });
    }
    if (existing) {
      const merged = mergeSettings(existing, template);
      if (JSON.stringify(merged) === JSON.stringify(existing)) files.push({ file: '.claude/settings.json', action: 'unchanged' });
      else {
        await writeFile(settingsFile, `${JSON.stringify(merged, null, 2)}\n`);
        files.push({ file: '.claude/settings.json', action: 'merged in the multiplayer settings' });
      }
    }
  }

  // PR template
  const existingPr = PR_TEMPLATE_PATHS.find((p) => existsSync(path.join(root, p)));
  if (existingPr) files.push({ file: existingPr, action: 'unchanged (already has a PR template)' });
  else {
    const prFile = path.join(root, PR_TEMPLATE_PATHS[0]);
    await mkdir(path.dirname(prFile), { recursive: true });
    await writeFile(prFile, await readFile(path.join(TEMPLATES, 'PULL_REQUEST_TEMPLATE.md'), 'utf8'));
    files.push({ file: PR_TEMPLATE_PATHS[0], action: 'created' });
  }

  const changed = files.filter((f) => !f.action.startsWith('unchanged') && !f.action.startsWith('skipped')).map((f) => f.file);
  if (!changed.length) return { files, branch: await currentBranchOrNull(root), branchCreated: false };

  let branch = await currentBranchOrNull(root);
  let branchCreated = false;
  if (!branch || branch === base) {
    ({ branch, created: branchCreated } = await startTaskBranch(root, team.remote, base, `${me.user}/multiplayer-setup`));
  }
  await git(['add', '--', ...changed], { cwd: root });
  await git(['commit', '--quiet', '-m', 'multiplayer: add team setup (CLAUDE.md, shared settings, PR template)', '--', ...changed], {
    cwd: root,
  });
  return { files, branch, branchCreated };
}
