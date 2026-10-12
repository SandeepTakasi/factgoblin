import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checks.ts';
import { affected, changeSet, tokens } from '../src/scope.ts';
import type { Anchor, CheckResult, Claim } from '../src/types.ts';

const g = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function write(repo: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(p)), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
}

// base: a small repo. head: one commit that renames a dir, edits package.json and a source file.
const repo = mkdtempSync(join(tmpdir(), 'drift-scope-'));
g(repo, 'init', '-q');
write(repo, {
  'AGENTS.md': 'x\n',
  'pkg-manager/install.ts': 'export {};\n',
  'package.json': '{"scripts":{"build":"tsc"}}',
  'src/api.ts': 'export function generateObject() {}\n',
  'src/other.ts': 'export const unrelated = 1;\n',
});
g(repo, 'add', '-A');
g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base');
const base = g(repo, 'rev-parse', 'HEAD');
g(repo, 'mv', 'pkg-manager', 'installing');
write(repo, {
  'package.json': '{"scripts":{"compile":"tsc"}}',
  'src/api.ts': '/** @deprecated use generateText */\nexport function generateObject() {}\n',
});
g(repo, 'add', '-A');
g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'head');

const claim = (id: string, quote: string, anchors: Anchor[]): Claim =>
  ({ id, file: 'AGENTS.md', line: 1, quote, statement: quote, kind: 'fact', anchors });
const pass = (c: Claim): CheckResult[] => c.anchors.map((anchor) => ({ anchor, status: 'pass', detail: '' }));

test('changeSet lists both sides of a rename and the changed lines', () => {
  const c = changeSet(repo, base)!;
  assert.ok(c.files.includes('pkg-manager/install.ts') && c.files.includes('installing/install.ts'));
  assert.ok(c.complete && c.lines.get('package.json')!.some((l) => l.includes('compile')));
  assert.equal(changeSet(repo, 'deadbeef'), null);
});

test('tokens keeps code-like identifiers and paths, never plain English words', () => {
  const t = tokens(claim('c', 'Structured output: run `pnpm build`, then `generateObject` in `cli/args/flags.rs`', []));
  assert.ok(t.includes('cli/args/flags.rs') && t.includes('flags.rs') && t.includes('generateObject'));
  assert.ok(!t.includes('pnpm') && !t.includes('build') && !t.includes('Structured') && !t.includes('output'));
});

test('affected: path, manifest, token-in-content, failing check, untouched, instruction edit', () => {
  const changed = changeSet(repo, base)!;
  const items = [
    claim('path', '`pkg-manager/` holds install logic', [{ type: 'path', value: 'pkg-manager/' }]),
    claim('script', 'run `pnpm build`', [{ type: 'script', value: 'build' }]),
    claim('api', 'use `generateObject` for structured output', [{ type: 'api', value: 'generateObject' }]),
    claim('quiet', 'constants live in `src/other.ts`', [{ type: 'path', value: 'src/other.ts' }]),
  ].map((c) => ({ claim: c, results: c.id === 'api' ? c.anchors.map((a) => check(repo, 'AGENTS.md', a)) : pass(c) }));
  const hits = affected(items, changed, false);
  assert.match(hits.get('path')!, /pkg-manager/);
  assert.match(hits.get('script')!, /package\.json/);
  // A deprecation only adds a doc comment; the free deterministic check is what catches it.
  assert.match(hits.get('api')!, /deterministic check fails: api "generateObject"/);
  assert.equal(hits.has('quiet'), false);

  const failing = items[3];
  failing.results = [{ anchor: failing.claim.anchors[0], status: 'fail', detail: 'gone' }];
  const empty = { files: [], lines: new Map(), complete: true };
  assert.match(affected([failing], empty, false).get('quiet')!, /deterministic check fails/);
  assert.equal(affected([items[3]], { ...empty, files: ['x.txt'] }, true).get('quiet'), 'instruction file changed');
});

test('affected ignores unrelated manifest edits and prose mentions (the over-selection seen in scope-eval)', () => {
  const change = {
    files: ['package.json', '.changeset/structured-output.md'],
    lines: new Map([['package.json', ['  "version": "1.2.3",']], ['.changeset/structured-output.md', ['use generateObject for objects']]]),
    complete: true,
  };
  const script = claim('script', 'run `pnpm build`', [{ type: 'script', value: 'build' }]);
  const api = claim('api', 'use `generateObject` for structured output', [{ type: 'api', value: 'generateObject' }]);
  const hits = affected([script, api].map((c) => ({ claim: c, results: pass(c) })), change, false);
  assert.equal(hits.size, 0);
});

test.after(() => rmSync(repo, { recursive: true, force: true }));
