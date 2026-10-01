# Relevance calibration — ms-marco-minilm-l6@1, 2026-09-26

The thresholds in `packages/service/src/relevance/registry.ts` for
`ms-marco-minilm-l6@1` come from this record. Run directories under
`evals/runs/` are not committed; this file is.

- Labels `259a61bbaafc9c49`, turn mode `balanced`, 90 queries (dev and test
  splits by family), trial daemon on MLX `qwen3.5-4b-q4` (never prompted).
- Uncalibrated run: `retrieval-bench-2026-09-26T20-03-41-429Z` (arms `off`,
  `raw`, offline sweep).
- Live confirmation: `retrieval-bench-2026-09-26T20-10-35-372Z` (arms `off`,
  `raw`, and four threshold triples). The command:
  `pnpm --filter @bendyline/gezel-evals run retrieval-bench -- --relevance-model ms-marco-minilm-l6@1 --thresholds "0.00001,0.00003,0.5;0.00003,0.0001,0.5;0.0001,0.0003,0.5;0.0003,0.001,0.5"`

## Chosen

`drop 0.00001 · keep 0.00003 · strong 0.95`

- **keep 3e-5** is the lowest live cut that meets the selection rule on the
  dev split: turn false injection 1.00 → 0.42, strict R@5 0.96 → 0.95
  (floor: baseline − 2 points), set precision 0.62 → 0.80. keep 1e-4 ties it
  on false injection at R@5 0.94; 3e-4 and 1e-3 cut false injection to 0.33
  but lose 3–5 points of recall on dev.
- **drop 1e-5** leaves `search` exactly as the uncalibrated model ranks it.
  Every cut of 3e-5 or higher cost `search` 6 points of strict recall on the
  test split, and `search` is the tool a model calls when it wants leads.
- **strong 0.95** is the only score band where candidates are mostly the
  answer (turn: 91% relevant, 73% grade 2; search: 85% grade 2). Strong labels
  the tier only; it does not change what is kept.

## Test split (held out), paired against the model off

| Surface | Δ false injection | Δ strict R@5 | Δ set precision |
|---|---|---|---|
| turn | −0.50 [−0.67, −0.17] | −0.05 [−0.10, 0.00] | +0.11 [+0.08, +0.13] |
| references | −0.25 [−0.75, 0.00] | 0.00 | +0.17 [+0.11, +0.23] |
| search | 0.00 | 0.00 [−0.09, +0.09] | 0.00 |

Acceptance (plan Phase 6): the turn false-injection CI excludes 0; strict
recall loses no more than 5 points (point estimate at the limit); latency
gates hold. The references CI touches 0 — only four abstain subjects reach
that surface — so its improvement is suggestive, not established.

## Ordering and cost (uncalibrated arm vs off)

- nDCG@5: search 0.79 → 0.87 (dev), 0.86 → 0.91 (test); references 0.85 →
  0.95 (dev), flat on test; turn 0.79 → 0.82 (dev), flat on test.
- Separation (AUC, relevant vs irrelevant): 0.90–0.96 across surfaces.
- p95 with the model scoring (cold score cache): turn 63 ms, references
  37 ms, search 58 ms, against budgets of 250 / 700 / 400 ms. Later arms in
  one run reuse cached scores, so their latency is not a measurement.

## Caveats

- The corpus is English and fictional by construction. A real catalog's
  score distribution may differ; re-run the bench on the rebuilt food
  catalog (Tier R) before turning the check on by default.
- Turn false injection plateaus at 0.33–0.50: some abstain queries keep a
  candidate the model scores high (a near-miss sibling) or one outside the
  scored window. Raising keep does not remove them.
- The model stays default-off. These thresholds apply only to installs that
  turn the relevance check on.
- 2026-09-30: the real-catalog run this record asked for is
  [KNOWLEDGE-CALIBRATION-2026-09-30.md](KNOWLEDGE-CALIBRATION-2026-09-30.md).
  It adds a stricter knowledge bar and logit-space mapping on top of these
  thresholds, and the check is now on for new installs.
