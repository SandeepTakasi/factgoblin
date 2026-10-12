import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score, summarize, type Corpus } from '../src/bench.ts';
import { deleteFix, locate } from '../src/pipeline.ts';
import type { AuditResult } from '../src/pipeline.ts';
import type { Claim, Finding, Severity } from '../src/types.ts';

test('locate finds the quote nearest the claimed line, ignoring whitespace; null if absent', () => {
  const lines = ['run `make build`', 'x', 'y', 'run  `make build`', 'z'];
  assert.equal(locate(lines, 'run `make build`', 4), 4);
  assert.equal(locate(lines, 'run `make build`', 1), 1);
  assert.equal(locate(lines, 'npm run nope', 2), null);
  assert.equal(locate(lines, '   ', 2), null);
  const wrapped = ['intro', 'This ensures that all', 'code passes all tests. DO NOT', 'end'];
  assert.equal(locate(wrapped, 'This ensures that all code passes all tests.', 1), 2);
  assert.equal(locate(wrapped, 'code passes all tests', 1), 3);
});

const corpus: Corpus = {
  repos: { 'o/r': 'sha' },
  stale: [
    { repo: 'o/r', file: 'AGENTS.md', line: 10, claim: 'a', severity: 'high' },
    { repo: 'o/r', file: 'AGENTS.md', line: 40, claim: 'b', severity: 'high' },
    { repo: 'o/r', file: 'AGENTS.md', line: 60, claim: 'c', severity: 'low' },
  ],
  not_stale: [{ repo: 'o/r', file: 'AGENTS.md', line: 20, claim: 'trap' }],
  clean_files: [],
};

const finding = (file: string, line: number, severity: Severity): Finding => ({
  claim: { id: 'x', file, line, quote: 'q', statement: 's', kind: 'fact', anchors: [] },
  severity, reason: 'r', evidence: [],
});

const result = (findings: Finding[]): AuditResult => ({
  repo: '/tmp/r', commit: 'sha', findings,
  files: [{ path: 'AGENTS.md', aliases: ['CLAUDE.md'], target: 'AGENTS.md' }],
  stats: {} as AuditResult['stats'],
});

test('score: tolerance, nearest label, aliases, traps and unlabeled', () => {
  const s = score(corpus, 'o/r', result([
    finding('AGENTS.md', 12, 'high'), // tp (label 10)
    finding('AGENTS.md', 21, 'medium'), // trap (label 20)
    finding('AGENTS.md', 90, 'medium'), // unlabeled
  ]));
  assert.deepEqual(s.findings.map((f) => f.outcome), ['tp', 'fp_trap', 'unlabeled']);
  assert.deepEqual(s.missed.map((l) => l.line), [40, 60]);
});

test('summarize: precision over labeled medium/high only; high-severity recall', () => {
  const s = score(corpus, 'o/r', result([
    finding('AGENTS.md', 10, 'high'),
    finding('AGENTS.md', 41, 'high'),
    finding('AGENTS.md', 20, 'low'), // low findings don't count toward precision
    finding('AGENTS.md', 19, 'medium'), // trap
  ]));
  const sum = summarize(corpus, [{ repo: 'o/r', score: s }]);
  assert.equal(sum.tp, 2);
  assert.equal(sum.fpTrap, 1);
  assert.equal(sum.precisionLabeled, 2 / 3);
  assert.equal(sum.recallHigh, 1);
  assert.equal(sum.recallMediumHigh, 1); // the only labels are 2 high + 1 low
});

test('deleteFix removes a whole derivable line, and refuses when that would lose information', () => {
  const text = ['# Commands', '', '- Run the tests with `npm run test`.', '- Build: `npm run build`; lint: `npm run lint`.', 'last line `x`'].join('\n');
  const claim = (line: number, quote: string): Claim => ({ id: 'c', file: 'AGENTS.md', line, quote, statement: '', kind: 'fact', anchors: [] });
  assert.deepEqual(deleteFix(text, claim(3, 'Run the tests with `npm run test`.'), new Set()),
    { old: '- Run the tests with `npm run test`.\n', new: '', kind: 'delete' });
  assert.equal(deleteFix(text, claim(4, 'Build: `npm run build`'), new Set([4])), null); // lint claim on the same line stays true
  assert.equal(deleteFix(text, claim(3, 'tests with `npm run test`. - Build'), new Set()), null); // spans lines
  assert.deepEqual(deleteFix(text, claim(5, '`x`'), new Set()), { old: 'last line `x`', new: '', kind: 'delete' }); // no trailing newline
  assert.equal(deleteFix(text + '\n- Run the tests with `npm run test`.\n', claim(3, 'Run the tests with `npm run test`.'), new Set()), null); // ambiguous

  // Code blocks: shell commands are independent lines, example code and diagrams are not.
  const fenced = ['```bash', 'npm run compile', '```', '```ts', 'const [Drawer] = useHierarchyDrawer({', '```', '```text', '├── Button.tsx', '```'].join('\n');
  assert.equal(deleteFix(fenced, claim(2, 'npm run compile'), new Set())?.old, 'npm run compile\n');
  assert.equal(deleteFix(fenced, claim(5, 'const [Drawer] = useHierarchyDrawer({'), new Set()), null);
  assert.equal(deleteFix(fenced, claim(8, '├── Button.tsx'), new Set()), null);
});
