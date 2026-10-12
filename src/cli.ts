#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ensureRepo, labeledFiles, loadCorpus, score, summarize, type Score } from './bench.ts';
import { audit, type AuditResult } from './pipeline.ts';
import { covers, knownItems, syncPr } from './pr.ts';
import { markdown } from './report.ts';
import { scopeEval } from './scope-eval.ts';

const USAGE = `Usage:
  factgoblin audit [repo] [--since REF] [--file PATH]... [--include-skills] [--no-fix] [--derivable-fix update|delete] [--apply] [--json OUT] [--model M]
  factgoblin bench [--corpus PATH] [--repo OWNER/NAME]... [--model M]
  factgoblin scope-eval [--corpus PATH]...
  factgoblin pr [repo] [--since REF] [--branch NAME] [--base BRANCH] [--include-skills] [--derivable-fix update|delete] [--dry-run] [--model M]`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    file: { type: 'string', multiple: true },
    since: { type: 'string' },
    branch: { type: 'string', default: 'factgoblin/fixes' },
    base: { type: 'string' },
    'dry-run': { type: 'boolean' },
    'derivable-fix': { type: 'string', default: 'update' },
    'include-skills': { type: 'boolean' },
    'no-fix': { type: 'boolean' },
    apply: { type: 'boolean' },
    json: { type: 'string' },
    model: { type: 'string' },
    corpus: { type: 'string', multiple: true },
    repo: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});
const log = (m: string) => process.stderr.write(`· ${m}\n`);
const DEFAULT_CORPUS = join(import.meta.dirname, '..', 'research', 'labeled-findings.json');
const [command, target] = positionals;

if (values.help || !command) {
  console.log(USAGE);
} else if (command === 'audit') {
  const repo = resolve(target ?? '.');
  const result = await audit(repo, {
    files: values.file, since: values.since, derivableFix: derivableFix(), includeSkills: values['include-skills'], fix: !values['no-fix'], model: values.model, log,
  });
  if (values.json) writeFileSync(values.json, JSON.stringify(result, null, 2));
  if (values.apply) applyFixes(result);
  process.stdout.write(markdown(result));
  process.exitCode = result.findings.some((f) => f.severity !== 'low') ? 1 : 0;
} else if (command === 'bench') {
  await bench();
} else if (command === 'pr') {
  const repo = resolve(target ?? '.');
  const known = knownItems(repo, values.branch!);
  const skip = (c: { file: string; line: number }) => covers(known, c.file, readFileSync(join(repo, c.file), 'utf8'), c.line);
  const result = await audit(repo, { since: values.since || undefined, skip, derivableFix: derivableFix(), includeSkills: values['include-skills'], fix: true, model: values.model, log });
  log(`audit: ${result.findings.length} finding(s), ${result.stats.skippedByScope} claim(s) skipped by scope, $${result.stats.costUsd.toFixed(2)}`);
  syncPr(result, { branch: values.branch!, base: values.base, dryRun: values['dry-run'], log });
} else if (command === 'scope-eval') {
  const paths = values.corpus?.length ? values.corpus : [DEFAULT_CORPUS, join(import.meta.dirname, '..', 'research', 'heldout-findings.json')];
  console.log(await scopeEval(paths.map(loadCorpus), 20, log));
} else {
  console.error(USAGE);
  process.exitCode = 2;
}

function derivableFix(): 'update' | 'delete' {
  const v = values['derivable-fix'];
  if (v !== 'update' && v !== 'delete') {
    console.error(`--derivable-fix must be "update" or "delete", got "${v}"`);
    process.exit(2);
  }
  return v;
}

function applyFixes(result: AuditResult) {
  for (const f of result.findings) {
    if (!f.fix) continue;
    const path = join(result.repo, f.claim.file);
    const text = readFileSync(path, 'utf8');
    if (text.split(f.fix.old).length !== 2) {
      log(`skipped fix for ${f.claim.file}:${f.claim.line} (text changed by an earlier fix)`);
      continue;
    }
    writeFileSync(path, text.replace(f.fix.old, f.fix.new));
    log(`applied fix to ${f.claim.file}:${f.claim.line}`);
  }
}

async function bench() {
  const corpus = loadCorpus(values.corpus?.[0] ?? DEFAULT_CORPUS);
  const names = values.repo?.length ? values.repo : Object.keys(corpus.repos);
  const scores: { repo: string; score: Score; result: AuditResult }[] = [];
  for (const name of names) {
    const files = labeledFiles(corpus, name);
    if (!files.length) continue;
    log(`${name}: fetching ${corpus.repos[name].slice(0, 12)}`);
    const dir = ensureRepo(name, corpus.repos[name]);
    const result = await audit(dir, { files, fix: false, model: values.model, log: (m) => log(`${name}: ${m}`) });
    const s = score(corpus, name, result);
    scores.push({ repo: name, score: s, result });
    const count = (o: string) => s.findings.filter((f) => f.outcome === o).length;
    log(`${name}: ${result.findings.length} findings (tp ${count('tp')}, trap ${count('fp_trap')}, unlabeled ${count('unlabeled')}), ` +
      `missed ${s.missed.length}, $${result.stats.costUsd.toFixed(2)}`);
  }
  const sum = summarize(corpus, scores);
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(0)}%`);
  const cost = scores.reduce((a, s) => a + s.result.stats.costUsd, 0);
  const lines = [
    `# Bench (${scores.length} repos)`,
    '',
    `Precision on labeled medium/high findings: ${pct(sum.precisionLabeled)} (${sum.tp} correct, ${sum.fpTrap} hit a known false-positive trap)`,
    `Recall of labeled high-severity rot: ${pct(sum.recallHigh)} (${sum.highFound}/${sum.highLabels})`,
    `Recall of labeled medium+high rot: ${pct(sum.recallMediumHigh)} (${sum.mediumHighFound}/${sum.mediumHighLabels})`,
    `Unlabeled medium/high findings needing human review: ${sum.unlabeled}`,
    `Cost: $${cost.toFixed(2)}`,
    `Gate (precision ≥90%, high recall ≥70%): ${(sum.precisionLabeled ?? 0) >= 0.9 && (sum.recallHigh ?? 0) >= 0.7 ? 'PASS' : 'FAIL'}`,
    '',
    '## Unlabeled findings (review, then add to the corpus)',
    ...scores.flatMap((s) => s.score.findings.filter((f) => f.outcome === 'unlabeled').map((f) =>
      `- ${s.repo} ${f.finding.claim.file}:${f.finding.claim.line} [${f.finding.severity}] ${f.finding.claim.quote} — ${f.finding.reason}`)),
    '',
    '## Missed labeled rot',
    ...scores.flatMap((s) => s.score.missed.map((l) => `- ${s.repo} ${l.file}:${l.line} [${l.severity}] ${l.claim}`)),
  ];
  const out = join(import.meta.dirname, '..', '.cache', 'bench');
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(join(out, `${stamp}.json`), JSON.stringify(scores, null, 2));
  console.log(lines.join('\n'));
}
