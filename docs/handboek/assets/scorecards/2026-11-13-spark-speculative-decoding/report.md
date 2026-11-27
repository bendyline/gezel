# Final readout: speculative decoding does not change quality

Ran 2026-11-13 08:07 to 2026-11-22 13:12 on the Spark (GB10), llama.cpp v0.9.0
(native 0.1.62), gezel 9e5fd58f with one dist throughout. Three rounds of the
four scorecard suites (43 scenarios), seven arms, 903 trials, 0 excluded for
running the wrong speculation mode. Each arm launched llama-server with the
same settings (context, f16 KV, one slot, batch, reasoning budget) apart from
the drafter. Judged by claude-sonnet-5-5 on the 19 scenarios with a rubric.
Endpoints are the ones PLAN.md fixed before any trial ran. Full tables:
results.md; interim readouts: ROUND1.md, ROUND2.md.

## Answer

Neither MTP nor DFlash2 changed result quality measurably on any of the three
models. Judge scores match within 0.1 points, and every interval sits inside
the +/-0.5 margin set in advance. No pass-rate difference is significant;
Muse with DFlash2 leans +6 points (exact p=0.055, one of ten tests), with no
mechanism behind it. Matched by scenario, output length and tool calls are the
same. Speculation decodes 2.7-2.9x faster and takes 29-50% less wall time.

## By arm

| Arm | Pass | Judge mean | Decode t/s | Draft acceptance | Median trial (min) | Total h |
| --- | --- | --- | --- | --- | --- | --- |
| qwen none | 120/129 | 6.51 | 12.1 | - | 8.5 | 48.8 |
| qwen mtp | 123/129 | 6.50 | 29.1 | 60.4% | 5.1 | 31.1 |
| qwen dflash | 123/129 | 6.59 | 33.0 | 59.4% | 4.3 | 24.2 |
| gemma none | 103/129 | 4.72 | 28.7 | - | 4.6 | 20.4 |
| gemma mtp | 106/129 | 4.75 | 76.5 | 66.0% | 2.7 | 13.5 |
| muse none | 113/129 | 5.63 | 11.8 | - | 15.6 | 47.9 |
| muse dflash | 121/129 | 5.64 | 34.1 | 59.2% | 6.8 | 33.9 |

## Paired by scenario (A minus B)

95% bootstrap CI over scenarios, plus an exact sign-flip test over the
scenarios whose results differ (the bootstrap is optimistic when only a few
scenarios differ).

| A vs B | Pass diff (pts) | CI | Differ | Exact p | Judge diff | CI | Exact p |
| --- | --- | --- | --- | --- | --- | --- | --- |
| qwen mtp vs none | +2.3 | [-3.1, 7.8] | 10 | 0.59 | -0.03 | [-0.25, 0.19] | 0.82 |
| qwen dflash vs none | +2.3 | [-3.1, 8.5] | 9 | 0.62 | +0.06 | [-0.19, 0.32] | 0.67 |
| qwen dflash vs mtp | 0.0 | [-3.1, 3.1] | 4 | 1.00 | +0.09 | [-0.11, 0.27] | 0.39 |
| gemma mtp vs none | +2.3 | [-3.9, 8.5] | 11 | 0.64 | +0.03 | [-0.10, 0.16] | 0.67 |
| muse dflash vs none | +6.2 | [1.6, 11.6] | 8 | 0.055 | +0.02 | [-0.09, 0.13] | 0.79 |

- **Judge.** Equivalent within the +/-0.5 margin for every comparison. The
  round-to-round sign flip (round 1 all toward speculation, round 2 all toward
  `none`) was noise; round 1's qwen dflash +0.40 did not hold.
- **Pass rate.** Nine of ten tests sit far from significance. Muse is the
  exception and does not survive correction for ten tests (Holm needs p < 0.005
  for the smallest). Of Muse `none`'s 16 failures, 3 are speed-sensitive (below)
  against 1 of DFlash2's 8; leaving those out it is +5.0 [0.4, 10.5]. The
  remaining `none` failures are attempt-counted stops (repeat loops, file edits
  that failed five times, retry loops) and three idle chats after the model
  ended its turn. None of them depends on elapsed time, and no product-side
  timer (step-stall pause, one-shot timeout) fired in any Muse `none` trial;
  the two seen in Muse were in DFlash2 trials. Read it as an unexplained lean,
  not an effect.
- **Scenarios moving 2 of 3 or more** go both ways: qwen dflash gains
  author-gate-script and loses export-generalize, gemma mtp gains
  export-generalize and loses ab-test-readout, qwen mtp gains codemod-sweep
  (two of `none`'s failures there were speed-sensitive), muse dflash gains
  route-multi and powerpoint-deck.
- **Output.** On scenarios every trial of both arms passed (26-34 per pair),
  the `none`/speculation ratio of output tokens is 0.97-1.06 (geometric mean)
  and of tool calls 0.97-1.03. Muse `none`'s higher raw median (9.1k vs 7.9k)
  comes from which trials passed.
- **Failure modes** are the same kinds in every arm; there is no crash,
  garbled output, or rollback signature specific to speculation.

## Speed

Speculation triples decode on all three models, with 59-66% of drafted tokens
accepted. On Qwen, DFlash2 decodes 13% faster than MTP (33.0 vs 29.1 t/s) and
used 22% less total wall time with the same pass count. Whole trials speed up
less than decode because prefill and tool time do not change.

## Speed-sensitive stops (a harness effect)

A failure is flagged speed-sensitive when it is a hard ceiling, or a
time-triggered stop that cut off a turn still generating. Eight of 903:
qwen none 4, muse none 3, muse dflash 1, every other arm 0.

Five of the eight are the craftbook `stale no-write repair loop`. Its in-flight
deferral is a flat 4 minutes (`NO_WRITE_REPAIR_INFLIGHT_DEFER_MS` in
evals/src/craftbooks/scenario.ts), not scaled by decode rate as the retry
loop's `shouldDeferRetryLoopForInflight` is, so at about 12 t/s a repair turn
can still be generating when it fires (stopped turns were 242-476 s old). All
five were in `none` arms. Scaling that deferral by throughput would remove the
effect. This was not changed during the run.

## Other findings

- **The judge can fail silently.** Round 2's judge pass exited 0 having judged 0
  of 301. judge-sweep prints "skipped (no artifact)" for any trial the judge
  declines, a failed Claude CLI call included, and discards the judge's log, so
  the cause was not recorded. A re-run the next day judged the expected 133.
  judge-sweep should count failed judge calls separately and exit non-zero when
  it judges none of the eligible trials.
- **The judge covers 19 of 43 scenarios.** A blind pairwise comparison of the
  two arms' outputs on all 43 would test quality where no rubric exists. Not
  built.

## Limits

One machine and one quantization (Q4) per model; three trials per scenario,
so pass-rate resolution is about +/-6 points per comparison. Sampling uses the
catalog's settings (not greedy), so trials differ from one another in every
arm, and a difference smaller than about 6 points would not be visible here.
