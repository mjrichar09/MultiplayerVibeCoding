import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../scripts/crew.mjs', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });

for (const event of ['session-start', 'pre-tool-use']) {
  test(`hook ${event} exits 0 silently on valid input`, () => {
    const r = run(['hook', event], JSON.stringify({ hook_event_name: event, cwd: process.cwd() }));
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
