// Deterministic evaluation of change scoping (no new LLM calls: claim extraction comes from the cache).
// 1. Recall: for each labeled medium/high stale claim, does affected() select it given the real diff
//    between the instruction file's last edit and the pinned commit?
// 2. Cost proxy: for the last N commits of each repo, what fraction of claims would a push re-check?
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureRepo, type Corpus } from './bench.ts';
import { check } from './checks.ts';
import { discover } from './discover.ts';
import { gitMaybe } from './git.ts';
import { runClaude } from './llm.ts';
import { locate } from './pipeline.ts';
import { EXTRACT_SCHEMA, PROMPT_VERSION, extractPrompt } from './prompts.ts';
import { affected, changeSet, type ScopeInput } from './scope.ts';
import type { Claim, InstructionFile } from './types.ts';

async function claimsFor(repo: string, file: InstructionFile): Promise<ScopeInput[]> {
  const text = readFileSync(join(repo, file.path), 'utf8');
  const { output } = await runClaude<{ claims: (Omit<Claim, 'id' | 'file'> & { check: string })[] }>({
    cwd: repo, tools: [], prompt: extractPrompt(file.path, text), schema: EXTRACT_SCHEMA,
    cacheKey: `extract:v${PROMPT_VERSION}`,
  });
  const lines = text.split('\n');
  const items: ScopeInput[] = [];
  for (const c of output.claims) {
    const line = locate(lines, c.quote, c.line);
    if (line === null) continue;
    const claim: Claim = { ...c, id: `c${items.length + 1}`, file: file.path, line };
    items.push({ claim, results: claim.anchors.map((a) => check(repo, file.path, a)) });
  }
  return items;
}

function lastEdit(name: string, sha: string, path: string): string | null {
  try {
    return execFileSync('gh', ['api', `repos/${name}/commits?path=${encodeURIComponent(path)}&sha=${sha}&per_page=1`, '--jq', '.[0].sha'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

export async function scopeEval(corpora: Corpus[], recentCommits: number, log: (m: string) => void): Promise<string> {
  const rows: string[] = [];
  let selected = 0;
  let total = 0;
  const perPush: number[] = [];
  for (const corpus of corpora) {
    for (const [name, sha] of Object.entries(corpus.repos)) {
      const labels = corpus.stale.filter((l) => l.repo === name && l.severity !== 'low');
      const repo = ensureRepo(name, sha);
      const files = discover(repo).filter((f) => labels.some((l) => l.file === f.path || f.aliases.includes(l.file)) ||
        corpus.not_stale.some((l) => l.repo === name && (l.file === f.path || f.aliases.includes(l.file))));
      for (const file of files) {
        const items = await claimsFor(repo, file);
        if (!items.length) continue;
        // Per-push cost proxy: re-check fraction over the last N commits.
        gitMaybe(repo, ['fetch', '-q', `--depth=${recentCommits + 1}`, '--filter=blob:none', 'origin', sha]);
        const commits = (gitMaybe(repo, ['rev-list', '--first-parent', `--max-count=${recentCommits}`, sha]) ?? '').split('\n').filter(Boolean);
        for (const c of commits) {
          const changed = changeSet(repo, `${c}^`, c);
          if (!changed) continue;
          const edited = [file.path, file.target, ...file.aliases].some((p) => changed.files.includes(p));
          perPush.push(affected(items, changed, edited).size / items.length);
        }
        // Recall over the window since the file's last edit.
        const fileLabels = labels.filter((l) => l.file === file.path || file.aliases.includes(l.file));
        if (!fileLabels.length) continue;
        const base = lastEdit(name, sha, file.target);
        let changed: ReturnType<typeof changeSet> = null;
        if (base && base !== sha) {
          gitMaybe(repo, ['fetch', '-q', '--depth=1', '--filter=blob:none', 'origin', base]);
          changed = changeSet(repo, base, sha);
        }
        const hits = changed ? affected(items, changed, false) : new Map<string, string>();
        for (const l of fileLabels) {
          total++;
          const near = items.map((i) => i.claim).filter((c) => Math.abs(c.line - l.line) <= 5)
            .sort((a, b) => Math.abs(a.line - l.line) - Math.abs(b.line - l.line));
          const hit = near.find((c) => hits.has(c.id));
          if (hit) selected++;
          const why = !base || base === sha ? 'file edited at pinned commit (rule 1 covers it)'
            : !near.length ? 'no extracted claim near the label'
            : hit ? hits.get(hit.id)! : `not selected (${changed?.files.length ?? 0} files changed since ${base.slice(0, 8)}${changed && !changed.complete ? ', diff too large' : ''})`;
          rows.push(`${hit ? '✓' : '✗'} ${name} ${l.file}:${l.line} [${l.severity}] ${l.claim.slice(0, 70)} — ${why}`);
        }
        log(`${name}: done`);
      }
    }
  }
  perPush.sort((a, b) => a - b);
  const q = (p: number) => perPush.length ? `${Math.round(perPush[Math.floor(p * (perPush.length - 1))] * 100)}%` : 'n/a';
  return [
    `# Scope eval`,
    '',
    `Recall: ${selected}/${total} labeled medium/high stale claims selected by change scoping`,
    `Per-push share of claims re-checked (last ${recentCommits} commits per file, ${perPush.length} pushes): ` +
      `median ${q(0.5)}, p90 ${q(0.9)}, max ${q(1)}`,
    `(Zero-share pushes cost nothing; deterministic checks run on every push for free.)`,
    '',
    ...rows,
  ].join('\n');
}

