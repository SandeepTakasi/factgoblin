import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from './checks.ts';
import { discover } from './discover.ts';
import { git } from './git.ts';
import { runClaude, type LlmCall, type LlmResult } from './llm.ts';
import {
  CHALLENGE_SCHEMA, EXTRACT_SCHEMA, FIX_SCHEMA, PROMPT_VERSION, VERIFY_SCHEMA,
  challengePrompt, extractPrompt, fixPrompt, verifyPrompt,
} from './prompts.ts';
import type { Anchor, Claim, ClaimKind, Evidence, Finding, InstructionFile, Severity } from './types.ts';

export interface AuditOptions {
  files?: string[]; // only these instruction files (path or alias)
  includeSkills?: boolean;
  fix?: boolean; // generate fix text (default true)
  model?: string;
  log?: (msg: string) => void;
}

export interface AuditStats {
  files: number;
  claims: number;
  facts: number;
  passedMechanically: number;
  verified: number;
  staleBeforeChallenge: number;
  upheld: number;
  llmCalls: number;
  cachedCalls: number;
  costUsd: number;
  llmMs: number;
}

export interface AuditResult {
  repo: string;
  commit: string;
  files: InstructionFile[];
  findings: Finding[];
  stats: AuditStats;
}

interface RawClaim {
  line: number;
  quote: string;
  statement: string;
  kind: ClaimKind;
  check: 'mechanical' | 'semantic';
  anchors: Anchor[];
}

const READ_ONLY: LlmCall['tools'] = ['Read', 'Grep', 'Glob'];
const VERIFY_BATCH = 10;

/** Returns the 1-based line containing the quote, nearest to the claimed line; null if absent. */
export function locate(lines: string[], quote: string, claimed: number): number | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const q = norm(quote);
  if (!q) return null;
  let best: number | null = null;
  const within = (i: number, n: number) => n > 0 && norm(lines.slice(i, i + n).join(' ')).includes(q);
  lines.forEach((_, i) => {
    // Quotes may wrap across up to 3 lines; line i is the start if dropping it breaks the match.
    const startsHere = [1, 2, 3].some((n) => within(i, n) && !within(i + 1, n - 1));
    if (startsHere && (best === null || Math.abs(i + 1 - claimed) < Math.abs(best - claimed))) best = i + 1;
  });
  return best;
}

export async function audit(repo: string, opts: AuditOptions = {}): Promise<AuditResult> {
  const log = opts.log ?? (() => {});
  const commit = git(repo, ['rev-parse', 'HEAD']).trim();
  const stats: AuditStats = {
    files: 0, claims: 0, facts: 0, passedMechanically: 0, verified: 0, staleBeforeChallenge: 0, upheld: 0,
    llmCalls: 0, cachedCalls: 0, costUsd: 0, llmMs: 0,
  };
  const call = async <T>(c: Omit<LlmCall, 'model'>): Promise<T> => {
    const res: LlmResult<T> = await runClaude<T>({ ...c, model: opts.model });
    stats.llmCalls++;
    if (res.cached) stats.cachedCalls++;
    else {
      stats.costUsd += res.costUsd;
      stats.llmMs += res.durationMs;
    }
    return res.output;
  };

  let files = discover(repo);
  if (opts.files?.length) {
    const wanted = new Set(opts.files);
    files = files.filter((f) => wanted.has(f.path) || f.aliases.some((a) => wanted.has(a)));
  } else if (!opts.includeSkills) {
    files = files.filter((f) => !f.path.endsWith('SKILL.md'));
  }
  stats.files = files.length;

  const findings: Finding[] = [];
  for (const file of files) {
    const text = readFileSync(join(repo, file.path), 'utf8');
    const lines = text.split('\n');
    log(`${file.path}: extracting claims`);
    const { claims: raw } = await call<{ claims: RawClaim[] }>({
      cwd: repo, tools: [], prompt: extractPrompt(file.path, text), schema: EXTRACT_SCHEMA,
      cacheKey: `extract:v${PROMPT_VERSION}`,
    });

    const claims: (Claim & { check: RawClaim['check'] })[] = [];
    for (const c of raw) {
      const line = locate(lines, c.quote, c.line);
      if (line === null) continue; // quote isn't in the file: hallucinated, drop
      claims.push({ ...c, id: `c${claims.length + 1}`, file: file.path, line });
    }
    stats.claims += claims.length;
    const checked = claims.map((claim) => ({ claim, results: claim.anchors.map((a) => check(repo, file.path, a)) }));
    // Safety net: a non-fact whose concrete anchor deterministically fails still gets verified.
    const facts = checked.filter(({ claim, results }) => claim.kind === 'fact' || results.some((r) => r.status === 'fail'));
    stats.facts += facts.length;

    const toVerify: { claim: (typeof claims)[number]; checks: string[] }[] = [];
    for (const { claim, results } of facts) {
      if (claim.check === 'mechanical' && results.length && results.every((r) => r.status === 'pass')) {
        stats.passedMechanically++;
        continue;
      }
      toVerify.push({ claim, checks: results.map((r) => `${r.anchor.type} "${r.anchor.value}": ${r.status} (${r.detail})`) });
    }
    stats.verified += toVerify.length;

    const stale = new Map<string, { claim: Claim; severity: Severity; reason: string; evidence: Evidence[] }>();
    for (let i = 0; i < toVerify.length; i += VERIFY_BATCH) {
      const batch = toVerify.slice(i, i + VERIFY_BATCH);
      log(`${file.path}: verifying claims ${i + 1}-${i + batch.length} of ${toVerify.length}`);
      const { results } = await call<{ results: { id: string; verdict: string; severity: Severity; reason: string; evidence: Evidence[] }[] }>({
        cwd: repo, tools: READ_ONLY, schema: VERIFY_SCHEMA, cacheKey: `verify:v${PROMPT_VERSION}:${commit}`,
        prompt: verifyPrompt(file.path, batch.map(({ claim, checks }) => ({
          id: claim.id, line: claim.line, quote: claim.quote, statement: claim.statement, check: checks,
        }))),
      });
      for (const r of results) {
        const claim = batch.find((b) => b.claim.id === r.id)?.claim;
        if (claim && r.verdict === 'stale') stale.set(r.id, { claim, severity: r.severity, reason: r.reason, evidence: r.evidence });
      }
    }
    stats.staleBeforeChallenge += stale.size;
    if (!stale.size) continue;

    log(`${file.path}: challenging ${stale.size} stale verdict(s)`);
    const { results: challenged } = await call<{ results: { id: string; upheld: boolean; severity: Severity; reason: string }[] }>({
      cwd: repo, tools: READ_ONLY, schema: CHALLENGE_SCHEMA, cacheKey: `challenge:v${PROMPT_VERSION}:${commit}`,
      prompt: challengePrompt(file.path, [...stale].map(([id, s]) => ({
        id, line: s.claim.line, quote: s.claim.quote, statement: s.claim.statement, reason: s.reason, evidence: s.evidence,
      }))),
    });
    const upheld: Finding[] = [];
    for (const c of challenged) {
      const s = stale.get(c.id);
      if (s && c.upheld) upheld.push({ claim: s.claim, severity: c.severity, reason: s.reason, evidence: s.evidence });
    }
    stats.upheld += upheld.length;
    if (!upheld.length) continue;

    if (opts.fix !== false) {
      log(`${file.path}: writing fixes`);
      const { edits } = await call<{ edits: { id: string; old: string; new: string }[] }>({
        cwd: repo, tools: [], schema: FIX_SCHEMA, cacheKey: `fix:v${PROMPT_VERSION}`,
        prompt: fixPrompt(file.path, text, upheld.map((f) => ({
          id: f.claim.id, line: f.claim.line, quote: f.claim.quote, statement: f.claim.statement, reason: f.reason, evidence: f.evidence,
        }))),
      });
      for (const e of edits) {
        const f = upheld.find((u) => u.claim.id === e.id);
        // Only keep edits that apply cleanly: old must occur exactly once.
        if (f && e.old && e.old !== e.new && text.split(e.old).length === 2) f.fix = { old: e.old, new: e.new };
      }
    }
    findings.push(...upheld);
  }
  return { repo, commit, files, findings, stats };
}
