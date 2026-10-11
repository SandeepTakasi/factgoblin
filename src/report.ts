import type { AuditResult } from './pipeline.ts';

export function markdown(result: AuditResult): string {
  const { findings, stats } = result;
  const out = [
    `# Agent instruction drift: ${findings.length} stale claim(s)`,
    '',
    `Commit \`${result.commit.slice(0, 12)}\` · ${stats.files} file(s) · ${stats.claims} claims (${stats.facts} facts, ` +
      `${stats.passedMechanically} passed deterministic checks, ${stats.verified} verified) · ` +
      `${stats.staleBeforeChallenge} flagged → ${stats.upheld} survived challenge · ` +
      `${stats.llmCalls} LLM calls (${stats.cachedCalls} cached), $${stats.costUsd.toFixed(2)}`,
  ];
  const order = { high: 0, medium: 1, low: 2 };
  for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
    out.push(
      '',
      `## [${f.severity}] ${f.claim.file}:${f.claim.line}`,
      '',
      `> ${f.claim.quote}`,
      '',
      f.reason,
      '',
      ...f.evidence.map((e) => `- \`${e.path}${e.line ? `:${e.line}` : ''}\` — ${e.note}`),
    );
    if (f.fix) out.push('', '```diff', ...f.fix.old.split('\n').map((l) => `- ${l}`), ...f.fix.new.split('\n').map((l) => `+ ${l}`), '```');
  }
  return out.join('\n') + '\n';
}
