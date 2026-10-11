import assert from 'node:assert/strict';
import { test } from 'node:test';
import { score, summarize, type Corpus } from '../src/bench.ts';
import { locate } from '../src/pipeline.ts';
import type { AuditResult } from '../src/pipeline.ts';
import type { Finding, Severity } from '../src/types.ts';

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
  files: [{ path: 'AGENTS.md', aliases: ['CLAUDE.md'] }],
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
});
