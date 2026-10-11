# Agent-instruction drift checker — M1 plan

Working name: TBD (decide before publishing). Goal: find claims in agent instruction files
(AGENTS.md, CLAUDE.md, skills, cursor rules…) that are no longer true about the code, with
evidence and an exact fix — precise enough that maintainers merge the fix instead of muting the tool.

Evidence this is built on: `research/` (scan of ~130 repos, 20 audited, 7 fix PRs, 2 merged).
Ground truth: `research/labeled-findings.json` (36 stale, 6 false-positive traps, 3 clean, pinned SHAs).

## Decisions (2026-10-11)
- TypeScript on Node ≥22, run `.ts` directly via Node type stripping; `tsc` only for typecheck/build.
- LLM via headless `claude -p` (user's subscription) for M1. Provider kept behind one function so the
  Anthropic API can be added for CI in M2.
- M1 = CLI + bench only. No GitHub integration until the gate below passes.
- Corelore is out of scope (archived in `_archive/`); no code reuse — evaluated, ~0 overlap.

## Gate to start M2
On the labeled corpus: ≥90% precision on reported medium/high findings (labeled stale = TP,
labeled not_stale = FP; unlabeled findings reported separately for human review) and ≥70% recall of
labeled high-severity findings. If precision stalls below 90%: stop and rethink before any integration.
Caveat: the corpus is small and was produced by the same kind of audit, so recall is optimistic.

## Pipeline
1. **discover** — instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` (any depth),
   `.github/copilot-instructions.md`, `.cursorrules`, `.cursor/rules/**/*.mdc`, `**/SKILL.md` under
   `.agents/`, `.claude/`, `.github/`. Skip vendored dirs. Dedupe symlinks/identical copies.
2. **extract** (LLM, no tools) — typed claims with anchors; flags examples/placeholders and
   preferences so they are never reported as stale (the traps in the corpus).
3. **check** (deterministic) — per anchor: path (symlink + case-sensitive aware), package script,
   make/just target, package name, symbol, `@deprecated`. Result is pass / fail / unknown; anything
   the parser can't fully see (e.g. Makefile `$(eval …)`) is `unknown`, never `fail`.
4. **verify** (LLM + read-only tools) — semantic claims and `unknown`s, one session per file.
5. **challenge** (LLM + read-only tools) — adversarial second pass on every stale verdict; only
   findings that survive are reported.
6. **fix** (LLM, no tools) — minimal `{old, new}` edits matching file style; `old` must match exactly.
7. **report** — JSON + markdown; `--fix` applies edits to the working tree.

## Security (instruction files are untrusted input addressed to agents)
Every `claude -p` call: `--safe-mode --restricted --strict-mcp-config --permission-prompts none
--no-session-persistence`, tools limited to `Read,Grep,Glob` (or none), cwd = target repo,
structured output via `--json-schema`, budget cap. Target-repo content is always passed as data.
Must be proven by `test/isolation` (hostile CLAUDE.md + hook) before the first real run.

## Bench
`bench` fetches each corpus repo at its pinned SHA into `.cache/`, runs the pipeline, matches
findings to labels (same file, line ±5 or same claim), prints precision/recall + cost/latency.
Stage outputs are cached by (file hash, prompt version) so reruns are cheap and resumable.
