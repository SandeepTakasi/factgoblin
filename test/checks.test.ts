import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checks.ts';
import { discover } from '../src/discover.ts';
import type { AnchorType } from '../src/types.ts';

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), 'drift-fixture-'));
  const files: Record<string, string> = {
    'AGENTS.md': '# Agents\nRun `make build`.\n',
    'packages/web/AGENTS.md': '# Web agents\n',
    'vendor/lib/AGENTS.md': '# vendored, must be ignored\n',
    'docs/ai/agents.md': '# a docs page about agents, not an instruction file\n',
    '.agents/skills/release/SKILL.md': '---\nname: release\n---\n',
    '.github/pull_request_template.md': 'template\n',
    '.gitignore': 'dist/\n',
    'package.json': JSON.stringify({ name: 'root', scripts: { build: 'tsc' }, devDependencies: { typescript: '5' } }),
    'packages/web/package.json': JSON.stringify({ name: '@acme/web', scripts: { 'test:unit': 'vitest' } }),
    'Makefile': 'build:\n\techo hi\n.PHONY: lint fmt\nlint fmt:\n\techo\n',
    'tools.mk': '$(eval $(call go_install,kind))\n',
    'justfile': 'alias f := format\nformat:\n  echo\n',
    'src/installing/index.ts': 'export const x = 1;\n',
    'src/api.ts': [
      '/**',
      ' * Generates an object.',
      ' * @deprecated Use `generateText` with an `output` setting instead.',
      ' */',
      'export function generateObject() {}',
      '',
      'export function generateText() {}',
    ].join('\n'),
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(repo, dirname(p)), { recursive: true });
    writeFileSync(join(repo, p), content);
  }
  // CLAUDE.md -> AGENTS.md and .claude/skills -> ../.agents/skills, like langfuse/pnpm/sentry.
  symlinkSync('AGENTS.md', join(repo, 'CLAUDE.md'));
  mkdirSync(join(repo, '.claude'));
  symlinkSync('../.agents/skills', join(repo, '.claude/skills'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '-A'], { cwd: repo });
  return repo;
}

const repo = fixture();
const c = (type: AnchorType, value: string, from = 'AGENTS.md') => check(repo, from, { type, value });

test('discover finds instruction files, dedupes symlinks, skips vendored', () => {
  const found = discover(repo);
  assert.deepEqual(found.map((f) => f.path), ['.agents/skills/release/SKILL.md', 'AGENTS.md', 'packages/web/AGENTS.md']);
  assert.deepEqual(found.find((f) => f.path === 'AGENTS.md')?.aliases, ['CLAUDE.md']);
});

test('path: exists, relative to the instruction file, and through a symlinked dir', () => {
  assert.equal(c('path', 'src/installing/').status, 'pass');
  assert.equal(c('path', './src/installing/index.ts:3').status, 'pass');
  assert.equal(c('path', 'package.json', 'packages/web/AGENTS.md').status, 'pass');
  assert.equal(c('path', '.claude/skills/release/SKILL.md').status, 'pass');
});

test('path: missing, wrong case, generated, moved, placeholder', () => {
  assert.equal(c('path', 'src/pkg-manager/').status, 'fail');
  const wrongCase = c('path', '.github/PULL_REQUEST_TEMPLATE.md');
  assert.equal(wrongCase.status, 'fail');
  assert.match(wrongCase.detail, /different case/);
  assert.equal(c('path', 'dist/bundle.js').status, 'unknown');
  assert.equal(c('path', 'installing/index.ts').status, 'unknown'); // similar path exists elsewhere
  assert.equal(c('path', 'src/<module>/index.ts').status, 'unknown');
  assert.equal(c('path', 'src/**/*.ts').status, 'unknown');
});

test('scripts and packages across the workspace', () => {
  assert.equal(c('script', 'test:unit').status, 'pass');
  assert.equal(c('script', 'compile').status, 'fail');
  assert.equal(c('package', '@acme/web').status, 'pass');
  assert.equal(c('package', 'typescript').status, 'pass');
  assert.equal(c('package', '@acme/config').status, 'fail');
});

test('make: multi-target rules pass; missing target is unknown when targets are macro-generated', () => {
  assert.equal(c('make_target', 'fmt').status, 'pass');
  assert.equal(c('make_target', 'install-kind').status, 'unknown');
});

test('just: recipes and aliases', () => {
  assert.equal(c('just_recipe', 'f').status, 'pass');
  assert.equal(c('just_recipe', 'gen-grammar').status, 'fail');
});

test('api: deprecated definition fails, live one passes, absent one fails', () => {
  const dep = c('api', 'generateObject()');
  assert.equal(dep.status, 'fail');
  assert.match(dep.detail, /deprecated at src\/api\.ts:3/);
  assert.equal(c('api', 'generateText').status, 'pass');
  assert.equal(c('symbol', 'streamObject').status, 'fail');
});
