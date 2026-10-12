import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check } from './checks.ts';
import { discover } from './discover.ts';
import { git } from './git.ts';
import { runClaude, type LlmCall, type LlmResult } from './llm.ts';
import { affected, changeSet } from './scope.ts';
import {
  CHALLENGE_SCHEMA, EXTRACT_SCHEMA, FIX_SCHEMA, PROMPT_VERSION, VERIFY_SCHEMA,
  challengePrompt, extractPrompt, fixPrompt, verifyPrompt,
} from './prompts.ts';
import type { Anchor, Claim, ClaimKind, Evidence, Finding, InstructionFile, Severity } from './types.ts';

export interface AuditOptions {
  files?: string[]; // only these instruction files (path or alias)
  since?: string; // only re-check claims the changes since this commit could have affected
  skip?: (claim: Claim) => boolean; // e.g. claims an open fix PR already covers
  includeSkills?: boolean;
  fix?: boolean; // generate fix text (default true)
  derivableFix?: 'update' | 'delete'; // for stale derivable claims: rewrite the line (default) or delete it
  model?: string;
  log?: (msg: string) => void;
}

export interface AuditStats {
  files: number;
  claims: number;
  facts: number;
  passedMechanically: number;
  staleMechanically: number; // derivable claims a deterministic check found stale (no model verification)
  undecidedMechanically: number; // derivable claims no deterministic check could decide; skipped
  verified: number;
  skippedByScope: number;
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

/**
 * Deterministic "delete this line" fix for a stale derivable claim. null when deleting would lose
 * something: another still-true claim on the line, a claim spanning several lines, or ambiguous text.
 */
export function deleteFix(text: string, claim: Claim, sharedLines: Set<number>): { old: string; new: string; kind: 'delete' } | null {
  const lines = text.split('\n');
  const line = lines[claim.line - 1];
  if (line === undefined || sharedLines.has(claim.line) || !line.replace(/\s+/g, ' ').includes(claim.quote.replace(/\s+/g, ' ').trim())) return null;
  // Inside a fenced block, only shell commands are independent lines; deleting a line of example code
  // or of a tree diagram would break it, so those get an update fix instead.
  let fence: string | null = null;
  for (const l of lines.slice(0, claim.line - 1)) {
    const m = /^\s*(```|~~~)\s*([\w+-]*)/.exec(l);
    if (m) fence = fence === null ? m[2].toLowerCase() : null;
  }
  if (fence !== null && !['bash', 'sh', 'shell', 'zsh', 'console', 'shellsession'].includes(fence)) return null;
  const old = claim.line < lines.length ? line + '\n' : line;
  return text.split(old).length === 2 ? { old, new: '', kind: 'delete' } : null;
}

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
    files: 0, claims: 0, facts: 0, passedMechanically: 0, staleMechanically: 0, undecidedMechanically: 0, verified: 0, skippedByScope: 0, staleBeforeChallenge: 0, upheld: 0,
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

  // Scoped mode. Unknown base (force-push, shallow clone) or a huge change set: audit everything.
  let changed = opts.since ? changeSet(repo, opts.since) : null;
  if (opts.since && changed === null) log(`can't diff against ${opts.since}; auditing everything`);
  if (changed && !changed.complete) log(`diff since ${opts.since} too large to read; scoping by paths only`);

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
    if (opts.skip) {
      const before = claims.length;
      claims.splice(0, claims.length, ...claims.filter((c) => !opts.skip!(c)));
      if (claims.length < before) log(`${file.path}: ${before - claims.length} claim(s) already proposed or dismissed`);
    }
    const checked = claims.map((claim) => ({ claim, results: claim.anchors.map((a) => check(repo, file.path, a)) }));
    // Safety net: a non-fact whose concrete anchor deterministically fails still gets verified.
    let facts = checked.filter(({ claim, results }) => claim.kind === 'fact' || results.some((r) => r.status === 'fail'));
    if (changed) {
      const edited = [file.path, file.target, ...file.aliases].some((p) => changed!.files.includes(p));
      const hits = affected(facts, changed, edited);
      stats.skippedByScope += facts.length - hits.size;
      facts = facts.filter(({ claim }) => hits.has(claim.id));
      if (!facts.length) continue;
      log(`${file.path}: ${facts.length} claim(s) in scope (${[...new Set(hits.values())].slice(0, 3).join('; ')})`);
    }
    stats.facts += facts.length;

    type Stale = { claim: Claim; severity: Severity; reason: string; evidence: Evidence[]; derivable: boolean };
    const stale = new Map<string, Stale>();
    const toVerify: { claim: (typeof claims)[number]; checks: string[] }[] = [];
    for (const { claim, results } of facts) {
      // Semantic focus: derivable claims are decided by the free deterministic checks alone. A fail (or a
      // moved file) goes straight to the adversarial challenge; anything undecidable is left alone.
      // Model verification is spent only on semantic claims.
      if (claim.check === 'mechanical' && results.length) {
        const bad = results.find((r) => r.status === 'fail' || (r.status === 'unknown' && r.detail.startsWith('not at that path')));
        if (bad) {
          stats.staleMechanically++;
          const note = `${bad.anchor.type} "${bad.anchor.value}": ${bad.detail}`;
          stale.set(claim.id, { claim, severity: 'medium', reason: `Deterministic check: ${note}.`, evidence: [{ path: claim.file, line: claim.line, note }], derivable: true });
        } else if (results.every((r) => r.status === 'pass')) {
          stats.passedMechanically++;
        } else {
          stats.undecidedMechanically++;
        }
        continue;
      }
      toVerify.push({ claim, checks: results.map((r) => `${r.anchor.type} "${r.anchor.value}": ${r.status} (${r.detail})`) });
    }
    stats.verified += toVerify.length;

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
        if (claim && r.verdict === 'stale') stale.set(r.id, { claim, severity: r.severity, reason: r.reason, evidence: r.evidence, derivable: false });
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
      if (s && c.upheld) upheld.push({ claim: s.claim, severity: c.severity, reason: c.reason || s.reason, evidence: s.evidence, derivable: s.derivable });
    }
    stats.upheld += upheld.length;
    if (!upheld.length) continue;

    if (opts.fix !== false && opts.derivableFix === 'delete') {
      // Lines that also carry a claim we are not removing must stay.
      const removed = new Set(upheld.filter((f) => f.derivable).map((f) => f.claim.id));
      const shared = new Set(claims.filter((c) => c.kind === 'fact' && !removed.has(c.id)).map((c) => c.line));
      for (const f of upheld) if (f.derivable) f.fix = deleteFix(text, f.claim, shared) ?? undefined;
    }
    const needText = upheld.filter((f) => !f.fix);
    if (opts.fix !== false && needText.length) {
      log(`${file.path}: writing fixes`);
      const { edits } = await call<{ edits: { id: string; old: string; new: string }[] }>({
        cwd: repo, tools: [], schema: FIX_SCHEMA, cacheKey: `fix:v${PROMPT_VERSION}`,
        prompt: fixPrompt(file.path, text, needText.map((f) => ({
          id: f.claim.id, line: f.claim.line, quote: f.claim.quote, statement: f.claim.statement, reason: f.reason, evidence: f.evidence,
        }))),
      });
      for (const e of edits) {
        const f = upheld.find((u) => u.claim.id === e.id);
        // Only keep edits that apply cleanly: old must occur exactly once.
        if (f && !f.fix && e.old && e.old !== e.new && text.split(e.old).length === 2) f.fix = { old: e.old, new: e.new, kind: 'update' };
      }
    }
    findings.push(...upheld);
  }
  return { repo, commit, files, findings, stats };
}
