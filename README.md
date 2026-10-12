# factgoblin

**Your agents trust your docs. The goblin doesn't.**

Coding agents follow `AGENTS.md`, `CLAUDE.md`, Cursor rules and skills to the letter. When the code
moves on and those files don't, agents confidently run commands that no longer exist, put code in
dead directories, and use deprecated APIs. factgoblin finds those claims, proves them stale against
the code, and opens one PR that fixes them.

It only speaks with concrete evidence. Every finding cites the files that contradict it, survives an
adversarial second check, and comes with an exact, minimal edit to the instruction file. Your rules and
preferences are never touched; only claims about what the code is or does.

Model effort goes where it matters: **semantic claims** ("`nx prepush` runs all tests", "use
`generateObject`", "`ee/` is consumed by web"), the silent, costly kind no linter can check. Lines that
merely restate something an agent can read from the code (a path, a script name, a make target) are
checked deterministically for free, and with `derivable-fix: delete` a stale one is removed instead of
rewritten, so it can never drift again. Each finding is a disagreement between docs and code: if the
code is what's wrong, close the PR and fix the code.

## Results so far

On a held-out set of 7 randomly chosen, actively maintained repos (labels committed before the tool
ever ran on them), across 3 independent runs: 20 of 21 medium/high detections (7 stale claims × 3
runs), at least 90% precision on medium/high findings in every run, and zero findings on files that
were already accurate. About $1 of model usage per instruction file for a full audit. Details
and caveats: [research/RESULTS.md](research/RESULTS.md).

## GitHub Action

Runs after every push to your default branch, re-checking only the claims that push could have made
stale, plus a weekly full audit. Findings arrive as a single PR, kept up to date: merge it to apply,
close it to dismiss those fixes for good. It never comments on contributors' PRs and never blocks a merge.

```yaml
- uses: actions/checkout@v7
- uses: SandeepTakasi/factgoblin@main
  with:
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}   # or claude-code-oauth-token
```

The first run audits everything; each later push re-checks only what changed since the last
successful run, so a failed run never hides drift. Full workflow:
[examples/factgoblin.yml](examples/factgoblin.yml). The job needs `contents: write`,
`pull-requests: write` and `actions: read`, and the repository setting "Allow GitHub Actions to
create and approve pull requests". PRs opened with the default `GITHUB_TOKEN` don't trigger other
workflows; pass a PAT or app token as `github-token` if you need CI on them.

## CLI

Requires Node ≥ 22.18 and a logged-in [Claude Code](https://claude.com/claude-code) CLI.

```bash
node src/cli.ts audit path/to/repo                 # full audit, report to stdout
node src/cli.ts audit path/to/repo --since HEAD~5  # only claims recent changes could affect
node src/cli.ts audit path/to/repo --apply         # write the fixes into the files
node src/cli.ts audit path/to/repo --derivable-fix delete  # remove stale lines that restate the code
node src/cli.ts pr path/to/repo --dry-run          # what the fix PR would contain
```

## Safety

Instruction files are text written *to agents*, so they are treated as hostile input. Every model
call runs headless Claude Code with `--safe-mode --restricted`: the audited repo's own `CLAUDE.md`,
settings, hooks, skills and MCP servers are never loaded, only read-only file tools exist, and nothing
can run code. `test/isolation.test.ts` proves it against a repo that tries both prompt injection and a
command-running hook (without these flags, that hook does run). Proposed edits are rejected unless
they touch only the lines of the claim being fixed.

## Limits

- Medium/high findings are the product; low-severity findings vary between runs.
- Change scoping can miss claims whose staleness comes from files they don't name; the weekly full
  audit is the backstop.
- Evaluated on a small sample (see RESULTS.md); treat the numbers as early.
