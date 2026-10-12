import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, gitMaybe } from './git.ts';
import type { AuditResult } from './pipeline.ts';
import type { Evidence, Finding, Severity } from './types.ts';

/** One proposed fix, as carried in the PR body so later runs can update the PR additively. */
export interface Item {
  file: string;
  line: number;
  severity: Severity;
  quote: string;
  reason: string;
  evidence: Evidence[];
  old: string;
  new: string;
  lineText?: string; // the claim's line as it was on the base branch: a stable identity across runs
  kind?: 'update' | 'delete';
  derivable?: boolean;
}

const STATE = /<!-- agent-drift-state: ([A-Za-z0-9+/=]+) -->/;
// Identity of a proposal: the stale line itself. Fix wording (`old`/`new`) varies between runs, the
// line doesn't; if the line changes, it's a new situation and may be proposed again.
const key = (i: Pick<Item, 'file' | 'old' | 'lineText'>) => `${i.file}\0${i.lineText ?? i.old}`;
const lineAt = (text: string, line: number) => (text.split('\n')[line - 1] ?? '').trim();

/**
 * Items from PRs opened before lineText existed: recover it from the base branch, but only while the
 * item's stale text is still on that line. Otherwise the line now says something else and the old item
 * must not match it (it once swallowed a brand-new finding on the same line number).
 */
export function legacyLines(items: Item[], read: (file: string) => string): Item[] {
  return items.flatMap((i) => {
    if (i.lineText) return [i];
    const lineText = lineAt(read(i.file), i.line);
    return lineText.includes(i.old.trim()) ? [{ ...i, lineText }] : [];
  });
}

/** Whether a claim on this line is already covered by one of these items. */
export function covers(items: Item[], file: string, text: string, line: number): boolean {
  const lineText = lineAt(text, line);
  return items.some((i) => i.file === file && (i.lineText ? i.lineText === lineText : lineText.includes(i.old.trim())));
}

/** The edit must touch the flagged claim's own lines (±2), so a fix can't rewrite unrelated text. */
export function editTouchesClaim(text: string, f: Finding): boolean {
  if (!f.fix) return false;
  const at = text.indexOf(f.fix.old);
  if (at === -1 || text.indexOf(f.fix.old, at + 1) !== -1) return false; // missing or ambiguous
  const start = text.slice(0, at).split('\n').length;
  const end = start + f.fix.old.split('\n').length - 1;
  return start <= f.claim.line + 2 && end >= f.claim.line - 2;
}

export function toItems(result: AuditResult, read: (file: string) => string): Item[] {
  return result.findings
    .filter((f) => f.severity !== 'low' && f.fix && editTouchesClaim(read(f.claim.file), f))
    .map((f) => ({
      file: f.claim.file, line: f.claim.line, severity: f.severity, quote: f.claim.quote,
      reason: f.reason, evidence: f.evidence, old: f.fix!.old, new: f.fix!.new,
      lineText: lineAt(read(f.claim.file), f.claim.line),
      kind: f.fix!.kind ?? 'update', derivable: f.derivable ?? false,
    }));
}

/**
 * Additive update: keep what the open PR already proposes while the stale text is still on the base
 * branch, add new fixes, never re-propose fixes from a PR that was closed without merging.
 */
export function merge(existing: Item[], fresh: Item[], read: (file: string) => string, dismissed: Set<string>): Item[] {
  const out = new Map<string, Item>();
  for (const i of [...existing, ...fresh]) {
    if (dismissed.has(key(i)) || out.has(key(i))) continue;
    if (read(i.file).split(i.old).length !== 2) continue; // fixed (or rewritten) on the base branch
    out.set(key(i), i);
  }
  return [...out.values()].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

export function parseState(body: string): Item[] {
  const m = STATE.exec(body);
  if (!m) return [];
  try {
    return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
  } catch {
    return [];
  }
}

export function renderBody(items: Item[], commit: string): string {
  const order = { high: 0, medium: 1, low: 2 };
  const out = [
    `These instructions for coding agents no longer match the code. Each change below was checked ` +
      `against the code at \`${commit.slice(0, 12)}\`.`,
  ];
  for (const i of [...items].sort((a, b) => order[a.severity] - order[b.severity])) {
    out.push(
      '',
      `### \`${i.file}:${i.line}\` (${i.severity}${i.kind === 'delete' ? ', line removed' : ''})`,
      '',
      `> ${i.quote}`,
      '',
      i.reason,
      '',
      ...i.evidence.map((e) => `- \`${e.path}${e.line ? `:${e.line}` : ''}\`: ${e.note}`),
    );
    if (i.kind === 'delete') {
      out.push('', 'This line only restated something an agent can read from the code itself, so it is removed rather than rewritten: it can no longer drift.');
    } else if (i.derivable) {
      out.push('', '<sub>This line only restates something an agent can read from the code itself. Deleting it would stop it drifting again (run with `derivable-fix: delete` to do that automatically).</sub>');
    }
  }
  out.push(
    '',
    '<sub>Opened by agent-drift. Merge to apply. Close it to dismiss these fixes; new drift will be proposed in a new PR.</sub>',
    `<!-- agent-drift-state: ${Buffer.from(JSON.stringify(items)).toString('base64')} -->`,
  );
  return out.join('\n');
}

interface PrRef {
  number: number;
  state: string;
  body: string;
  url: string;
}

function listPrs(repo: string, branch: string): PrRef[] {
  return JSON.parse(gh(repo, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '20', '--json', 'number,state,body,url']));
}

/**
 * Items already proposed (open PR) or dismissed (closed unmerged): their claims don't need re-verifying
 * on every push. A merged PR's items are fixed, so they are not included.
 */
export function knownItems(repo: string, branch: string): Item[] {
  return listPrs(repo, branch).filter((p) => p.state === 'OPEN' || p.state === 'CLOSED').flatMap((p) => parseState(p.body));
}

export interface PrOptions {
  branch: string;
  base?: string;
  dryRun?: boolean;
  log: (m: string) => void;
}

function gh(repo: string, args: string[]): string {
  return execFileSync('gh', args, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Opens, updates or closes the single fix PR. Returns its URL, or null when nothing is proposed. */
export function syncPr(result: AuditResult, opts: PrOptions): string | null {
  const repo = result.repo;
  const base = opts.base ?? gh(repo, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name']);
  const read = (file: string) => git(repo, ['show', `origin/${base}:${file}`]);
  gitMaybe(repo, ['fetch', '-q', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`]);

  const prs = listPrs(repo, opts.branch);
  const open = prs.find((p) => p.state === 'OPEN');
  const withLine = (items: Item[]) => legacyLines(items, read);
  const dismissed = new Set<string>(prs.filter((p) => p.state === 'CLOSED').flatMap((p) => withLine(parseState(p.body)).map(key)));
  const existing = open ? withLine(parseState(open.body)) : [];
  const items = merge(existing, toItems(result, read), read, dismissed);

  if (!items.length) {
    if (open && !opts.dryRun) {
      // Drop the stored state first: a PR the bot closes as resolved must not count as a human dismissal.
      gh(repo, ['pr', 'edit', String(open.number), '--body', 'All the stale instructions this PR addressed have since been fixed on the base branch.']);
      gh(repo, ['pr', 'close', String(open.number), '--delete-branch', '--comment', 'Nothing left to propose: every stale claim here was fixed on the base branch or dismissed earlier.']);
    }
    opts.log(open ? `closed ${open.url}: nothing left to fix` : 'no medium/high fixes to propose');
    return null;
  }
  const same = existing.length === items.length && existing.every((e, i) => key(e) === key(items[i]) && e.new === items[i].new);
  if (open && same) {
    opts.log(`${open.url} already proposes these ${items.length} fix(es)`);
    return open.url;
  }
  const body = renderBody(items, result.commit);
  if (opts.dryRun) {
    opts.log(`dry run: would ${open ? 'update' : 'open'} a PR with ${items.length} fix(es)`);
    process.stdout.write(body + '\n');
    return null;
  }

  // Build the branch in a throwaway worktree so the caller's checkout is never touched.
  const dir = mkdtempSync(join(tmpdir(), 'agent-drift-pr-'));
  try {
    git(repo, ['worktree', 'add', '-q', '--detach', dir, `origin/${base}`]);
    for (const i of items) {
      const path = join(dir, i.file);
      writeFileSync(path, readFileSync(path, 'utf8').replace(i.old, () => i.new));
    }
    const identity = gitMaybe(dir, ['config', 'user.email'])?.trim()
      ? []
      : ['-c', 'user.name=github-actions[bot]', '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com'];
    git(dir, ['add', '-A']);
    git(dir, [...identity, 'commit', '-q', '-m', 'docs: fix stale agent instructions\n\nGenerated by agent-drift.']);
    git(dir, ['push', '-q', '--force', 'origin', `HEAD:refs/heads/${opts.branch}`]);
  } finally {
    gitMaybe(repo, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, { recursive: true, force: true });
  }
  const bodyFile = join(mkdtempSync(join(tmpdir(), 'agent-drift-body-')), 'body.md');
  writeFileSync(bodyFile, body);
  if (open) {
    gh(repo, ['pr', 'edit', String(open.number), '--body-file', bodyFile]);
    opts.log(`updated ${open.url} (${items.length} fix(es))`);
    return open.url;
  }
  const url = gh(repo, ['pr', 'create', '--base', base, '--head', opts.branch, '--title', 'Fix stale agent instructions', '--body-file', bodyFile]);
  opts.log(`opened ${url} (${items.length} fix(es))`);
  return url;
}
