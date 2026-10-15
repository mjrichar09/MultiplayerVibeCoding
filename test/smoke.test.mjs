import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CLI } from './helpers/team.mjs';

// A directory outside any git repo, so hooks have nothing to coordinate.
const outside = mkdtempSync(path.join(tmpdir(), 'multiplayer-smoke-'));
test.after(() => rmSync(outside, { recursive: true, force: true }));

const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', cwd: outside });

for (const event of ['session-start', 'pre-tool-use']) {
  test(`hook ${event} exits 0 silently outside a git repo`, () => {
    const r = run(['hook', event], JSON.stringify({ hook_event_name: event, cwd: outside }));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });

  test(`hook ${event} fails open on garbage input`, () => {
    const r = run(['hook', event], '{not json');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
}

test('unknown hook event fails open', () => {
  const r = run(['hook', 'nope'], '{}');
  assert.equal(r.status, 0);
});

test('unknown command exits non-zero', () => {
  const r = run(['nope']);
  assert.notEqual(r.status, 0);
});
