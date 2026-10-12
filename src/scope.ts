import { posix } from 'node:path';
import { gitMaybe } from './git.ts';
import type { CheckResult, Claim } from './types.ts';

export interface ChangeSet {
  files: string[]; // touched paths, both sides of renames
  lines: Map<string, string[]>; // file -> added/removed line texts
  complete: boolean; // false if the diff was too large to read; then only path rules apply
}

const MAX_DIFF_BYTES = 64 * 1024 * 1024;

/** What changed between two commits: paths plus the changed lines themselves. null if a commit is missing. */
export function changeSet(repo: string, base: string, head = 'HEAD'): ChangeSet | null {
  const names = gitMaybe(repo, ['diff', '--name-status', '-M', '-z', base, head]);
  if (names === null) return null;
  const parts = names.split('\0').filter(Boolean);
  const files = new Set<string>();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const n = /^[RC]/.test(status) ? 2 : 1; // renames/copies list old and new path
    for (let k = 0; k < n; k++) files.add(parts[i++]);
  }
  const lines = new Map<string, string[]>();
  let diff: string | null = null;
  try {
    diff = gitMaybe(repo, ['diff', '-U0', '--no-color', '--no-ext-diff', '-M', base, head]);
  } catch {
    diff = null;
  }
  if (diff !== null && diff.length < MAX_DIFF_BYTES) {
    let current = '';
    for (const l of diff.split('\n')) {
      if (l.startsWith('+++ ')) current = l.slice(4).replace(/^b\//, '');
      else if (l.startsWith('--- ')) continue;
      else if ((l.startsWith('+') || l.startsWith('-')) && current) {
        const arr = lines.get(current) ?? [];
        arr.push(l.slice(1));
        lines.set(current, arr);
      }
    }
  }
  return { files: [...files], lines, complete: diff !== null && diff.length < MAX_DIFF_BYTES };
}

const MANIFEST: Record<string, RegExp> = {
  script: /(^|\/)package\.json$/,
  package: /(^|\/)(package\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/,
  make_target: /(^|\/)(GNUmakefile|[Mm]akefile(\.[^/]+)?|[^/]+\.mk)$/,
  just_recipe: /(^|\/)(\.?[Jj]ustfile|[^/]+\.just)$/,
};

const STOP = new Set(
  ('pnpm yarn npm npx bun node cargo make just python python3 pip uv git gh docker run test tests build ' +
    'src lib dist app apps packages package index json yaml toml true false null none main dev').split(' '),
);

/** Code-like tokens a change would have to mention to affect this claim (never plain English words). */
export function tokens(claim: Claim): string[] {
  const code = [...claim.quote.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
  const sources = [...code, ...claim.anchors.map((a) => a.value)];
  const out = new Set<string>();
  for (const s of sources) {
    for (const raw of s.split(/[\s'"()[\]{},;|<>=]+/)) {
      const t = raw.replace(/^[-./:]+|[.:,]+$/g, '');
      if (t.length < 4 || /^\d+$/.test(t) || STOP.has(t.toLowerCase())) continue;
      const codeLike = /[_./:@-]/.test(t) || /[a-z][A-Z]/.test(t) || code.some((c) => c.trim() === raw);
      if (!codeLike) continue;
      out.add(t);
      const base = posix.basename(t);
      if (t.includes('/') && base.length >= 4 && !STOP.has(base.toLowerCase())) out.add(base);
    }
  }
  return [...out];
}

const isProse = (f: string) => /\.(md|mdx|mdc|txt|rst)$/i.test(f);

function mentions(lines: string[], word: string): boolean {
  const re = new RegExp(`(^|[^\\w@/.-])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`);
  return lines.some((l) => re.test(l));
}

export interface ScopeInput {
  claim: Claim;
  results: CheckResult[];
}

/**
 * Which claims a change could have made stale, with the reason for each.
 * Claims not returned are skipped on this push: they cost nothing.
 */
export function affected(items: ScopeInput[], change: ChangeSet, instructionFileChanged: boolean): Map<string, string> {
  const hits = new Map<string, string>();
  for (const { claim, results } of items) {
    if (instructionFileChanged) {
      hits.set(claim.id, 'instruction file changed');
      continue;
    }
    const failed = results.find((r) => r.status === 'fail');
    if (failed) {
      hits.set(claim.id, `deterministic check fails: ${failed.anchor.type} "${failed.anchor.value}"`);
      continue;
    }
    const reason = anchorHit(claim, change) ?? tokenHit(claim, change);
    if (reason) hits.set(claim.id, reason);
  }
  return hits;
}

function anchorHit(claim: Claim, change: ChangeSet): string | null {
  for (const a of claim.anchors) {
    if (a.type === 'path') {
      const v = a.value.replace(/#.*$/, '').replace(/:\d+(:\d+)?$/, '').replace(/^\.\//, '').replace(/\/+$/, '');
      const candidates = [posix.normalize(v), posix.normalize(posix.join(posix.dirname(claim.file), v))];
      const hit = change.files.find((c) => candidates.some((p) => c === p || c.startsWith(p + '/')));
      if (hit) return `path ${a.value} changed (${hit})`;
      continue;
    }
    const manifest = MANIFEST[a.type];
    if (!manifest) continue;
    for (const f of change.files.filter((c) => manifest.test(c))) {
      // Without the diff text we can't tell what in the manifest changed; assume it could matter.
      if (!change.complete || mentions(change.lines.get(f) ?? [], a.value)) return `${a.type} "${a.value}" changed in ${f}`;
    }
  }
  return null;
}

function tokenHit(claim: Claim, change: ChangeSet): string | null {
  const toks = tokens(claim);
  for (const t of toks) {
    const path = t.includes('/') ? change.files.find((f) => f === t || f.startsWith(t + '/') || f.endsWith('/' + t)) : undefined;
    if (path) return `path ${t} changed (${path})`;
  }
  if (!change.complete) return null;
  for (const [file, lines] of change.lines) {
    if (isProse(file)) continue; // changelogs and docs mention names constantly
    const t = toks.find((tok) => mentions(lines, tok));
    if (t) return `${file} changed lines mentioning ${t}`;
  }
  return null;
}
