# M1 results

Prompt version 3, `claude -p` default model, one run per configuration.

## Held-out set (7 random repos, labels committed in 5dc5b1a before any tool run)

| | As pre-registered | After adjudication |
|---|---|---|
| Precision, medium/high findings | 7/7 | 7/7 |
| Precision, all findings | 10/13 (77%) | 13/13 |
| Recall, high | 2/2 | 2/2 |
| Recall, medium+high | 7/7 | 7/7 |
| Recall, low | 3/6 | 6/9 |
| Findings on the 3 clean files | 0 | 0 |
| Cost | $7.24 (~$1.03/file) | |

Adjudication: the 3 "false positives" (material-ui AGENTS.md:35, :38; payload AGENTS.md:70) were
checked directly against the code after the run; in each case the tool was right and the label was
wrong (labels marked `adjudicated` in heldout-findings.json). Missed: three low-severity nuance claims
(payload "Payload 3.x" on a 4.0 beta; outline "use strict mode" with `strict: false`; outline
"RESTful" for an RPC API).

## Stability (3 independent uncached runs on the held-out set)

| | orig | stab1 | stab2 |
|---|---|---|---|
| Recall, medium+high | 7/7 | 7/7 | 6/7 |
| Precision, medium/high | 7/7 | 9/10 | 6/6 |
| Findings on clean files | 0 | 0 | 0 |
| Cost | $7.24 | $6.47 | $6.12 |

6 of 7 medium/high labels found in every run; payload :272 in 2 of 3. The one medium/high "false
positive" (material-ui :46, `pnpm prettier # Format staged changes`, script formats all changes vs
master) is a literal-wording dispute, counted against the tool. Variance is mainly in severity
(same finding high in one run, medium in another) and in which low findings appear. Design
consequence for M2: fix-PR updates must be additive/sticky, not rebuilt from scratch each push.

## Development corpus (19 repos, prompts tuned against it — optimistic)

Run 2: 16/16 precision on medium/high, 9/11 high recall, $18.83.

## Caveats

- Small samples: 7/7 medium+high on held-out is consistent with a true rate as low as ~60% (95% Wilson).
- Labels and tool are the same model family; three labeling errors surfaced in 368 verdicts, so labels
  are noisy in both directions.
- Single run per configuration; run-to-run variance not yet measured (deno `spec::` flipped between
  dev runs 1 and 2, though prompts also changed).
