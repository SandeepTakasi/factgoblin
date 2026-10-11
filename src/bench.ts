import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from './git.ts';
import type { AuditResult } from './pipeline.ts';
import type { Finding, Severity } from './types.ts';

export interface Label {
  repo: string;
  file: string;
  line: number;
  claim: string;
  severity?: Severity;
}

export interface Corpus {
  repos: Record<string, string>; // name -> pinned commit
  stale: Label[];
  not_stale: Label[];
  clean_files: { repo: string; file: string }[];
}

export const REPO_CACHE = join(import.meta.dirname, '..', '.cache', 'repos');
const LINE_TOLERANCE = 5;

export function loadCorpus(path: string): Corpus {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Shallow-fetches exactly the pinned commit, once. */
export function ensureRepo(name: string, sha: string): string {
  const dir = join(REPO_CACHE, `${name.replace('/', '__')}@${sha.slice(0, 12)}`);
  if (existsSync(join(dir, '.git'))) return dir;
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['remote', 'add', 'origin', `https://github.com/${name}.git`]);
  git(dir, ['fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', sha]);
  git(dir, ['checkout', '-q', 'FETCH_HEAD']);
  return dir;
}

/** Instruction files the corpus has labels for, per repo. */
export function labeledFiles(corpus: Corpus, repo: string): string[] {
  const labeled = [...corpus.stale, ...corpus.not_stale].filter((l) => l.repo === repo && l.line > 0);
  const clean = corpus.clean_files.filter((c) => c.repo === repo);
  return [...new Set([...labeled, ...clean].map((l) => l.file))];
}

export type Outcome = 'tp' | 'fp_trap' | 'unlabeled';

export interface ScoredFinding {
  finding: Finding;
  outcome: Outcome;
  label?: Label;
}

export interface Score {
  findings: ScoredFinding[];
  missed: Label[]; // labeled stale with no matching finding
}

/** A finding matches the nearest label in the same file within LINE_TOLERANCE lines. */
export function score(corpus: Corpus, repo: string, result: AuditResult): Score {
  const labels = [
    ...corpus.stale.filter((l) => l.repo === repo).map((l) => ({ l, stale: true })),
    ...corpus.not_stale.filter((l) => l.repo === repo && l.line > 0).map((l) => ({ l, stale: false })),
  ];
  const sameFile = (label: string, finding: string) =>
    label === finding || result.files.some((f) => f.path === finding && f.aliases.includes(label));
  const matched = new Set<Label>();
  const findings = result.findings.map((finding): ScoredFinding => {
    let best: (typeof labels)[number] | undefined;
    for (const x of labels) {
      const d = Math.abs(x.l.line - finding.claim.line);
      if (sameFile(x.l.file, finding.claim.file) && d <= LINE_TOLERANCE && (!best || d < Math.abs(best.l.line - finding.claim.line))) best = x;
    }
    if (!best) return { finding, outcome: 'unlabeled' };
    matched.add(best.l);
    return { finding, outcome: best.stale ? 'tp' : 'fp_trap', label: best.l };
  });
  const missed = corpus.stale.filter((l) => l.repo === repo && !matched.has(l));
  return { findings, missed };
}

export interface Summary {
  tp: number;
  fpTrap: number;
  unlabeled: number;
  precisionLabeled: number | null; // tp / (tp + fp_trap), medium+high findings only
  recallHigh: number | null;
  highLabels: number;
  highFound: number;
}

export function summarize(corpus: Corpus, scores: { repo: string; score: Score }[]): Summary {
  const mh = scores.flatMap((s) => s.score.findings).filter((f) => f.finding.severity !== 'low');
  const tp = mh.filter((f) => f.outcome === 'tp').length;
  const fpTrap = mh.filter((f) => f.outcome === 'fp_trap').length;
  const audited = new Set(scores.map((s) => s.repo));
  const highLabels = corpus.stale.filter((l) => l.severity === 'high' && audited.has(l.repo));
  const missed = new Set(scores.flatMap((s) => s.score.missed));
  const highFound = highLabels.filter((l) => !missed.has(l)).length;
  return {
    tp,
    fpTrap,
    unlabeled: mh.filter((f) => f.outcome === 'unlabeled').length,
    precisionLabeled: tp + fpTrap ? tp / (tp + fpTrap) : null,
    recallHigh: highLabels.length ? highFound / highLabels.length : null,
    highLabels: highLabels.length,
    highFound,
  };
}
