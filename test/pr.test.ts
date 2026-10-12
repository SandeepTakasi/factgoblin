import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editTouchesClaim, merge, parseState, renderBody, type Item } from '../src/pr.ts';
import type { Finding } from '../src/types.ts';

const text = ['# Agents', '', 'Run `nx prepush` to run all tests.', '', '## Other', 'Unrelated line.'].join('\n');

const finding = (line: number, old: string): Finding => ({
  claim: { id: 'c1', file: 'AGENTS.md', line, quote: 'q', statement: 's', kind: 'fact', anchors: [] },
  severity: 'high', reason: 'r', evidence: [], fix: { old, new: 'x' },
});

test('editTouchesClaim: only edits on the claim lines (±2), unique and present', () => {
  assert.equal(editTouchesClaim(text, finding(3, 'to run all tests')), true);
  assert.equal(editTouchesClaim(text, finding(3, 'Unrelated line.')), false); // line 6, too far
  assert.equal(editTouchesClaim(text, finding(3, 'not in file')), false);
  assert.equal(editTouchesClaim(text + '\nto run all tests', finding(3, 'to run all tests')), false); // ambiguous
});

const item = (file: string, old: string, line = 1): Item =>
  ({ file, line, severity: 'medium', quote: old, reason: 'r', evidence: [], old, new: old + '!' });

test('merge: additive, drops fixed-upstream and dismissed, dedupes, sorts', () => {
  const base: Record<string, string> = { 'AGENTS.md': 'alpha\nbeta\ngamma\n', 'CLAUDE.md': 'delta\n' };
  const read = (f: string) => base[f];
  const existing = [item('AGENTS.md', 'alpha', 1), item('AGENTS.md', 'gone', 9)];
  const fresh = [item('AGENTS.md', 'alpha', 1), item('CLAUDE.md', 'delta', 1), item('AGENTS.md', 'gamma', 3)];
  const dismissed = new Set(['AGENTS.md\0gamma']);
  const out = merge(existing, fresh, read, dismissed);
  assert.deepEqual(out.map((i) => `${i.file}:${i.old}`), ['AGENTS.md:alpha', 'CLAUDE.md:delta']);
});

test('merge identifies proposals by the stale line, not by fix wording (dismissal bug from e2e)', () => {
  const read = () => 'Run the tests with `npm run test`.\n';
  const dismissedItem = { ...item('AGENTS.md', 'Run the tests with `npm run test`.', 1), lineText: 'Run the tests with `npm run test`.' };
  const reworded = { ...item('AGENTS.md', '`npm run test`', 1), lineText: 'Run the tests with `npm run test`.' };
  const dismissed = new Set(['AGENTS.md\0Run the tests with `npm run test`.']);
  assert.deepEqual(merge([], [reworded], read, dismissed), []);
  assert.equal(merge([dismissedItem], [reworded], read, new Set()).length, 1); // deduped, not doubled
});

test('PR body state round-trips and survives unicode', () => {
  const items = [item('AGENTS.md', 'use `généré` → x', 4)];
  const body = renderBody(items, 'abcdef1234567890');
  assert.match(body, /### `AGENTS\.md:4` \(medium\)/);
  assert.deepEqual(parseState(body), items);
  assert.deepEqual(parseState('no state here'), []);
});
