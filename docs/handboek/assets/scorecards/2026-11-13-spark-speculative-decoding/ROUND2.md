# Round 2 readout (interim, two trials per scenario)

Round 2 ran 2026-11-16 08:12 to 2026-11-19 13:20 (77 h), every cell on 9e5fd58f
with the same dist. 301 trials, 0 excluded for the wrong speculation mode.

## Judge pass had to be re-run

The driver's judge pass at 13:20 exited 0 but judged 0 of 301 ("301 skipped (no
artifact)"). judge-sweep prints that for any trial `maybeJudgeTrial` declines,
including a failed Claude CLI call, and it discards the judge's log lines, so
the cause was not recorded. On 2026-11-20 a single copied trial judged
normally, and a full re-run judged 133 of 301 (the same 133 as round 1: the 19
rubric scenarios per arm). Log: `judge-spec-ab-2026-11-13-r2.rerun.log`.

## Round 2 alone

| Arm | Pass | Judge mean (n=19) | Decode t/s | Draft acceptance |
| --- | --- | --- | --- | --- |
| qwen none | 40/43 | 6.73 | 12.1 | - |
| qwen mtp | 41/43 | 6.57 | 29.0 | 56.6% |
| qwen dflash | 41/43 | 6.52 | 33.4 | 60.9% |
| gemma none | 36/43 | 4.83 | 28.7 | - |
| gemma mtp | 35/43 | 4.65 | 75.9 | 64.8% |
| muse none | 38/43 | 5.74 | 11.8 | - |
| muse dflash | 39/43 | 5.65 | 34.0 | 57.7% |

Every judge difference in round 2 favors `none` (-0.06 to -0.21); in round 1
every one favored speculation (+0.05 to +0.40). That swing is what noise at this
n looks like.

## Rounds 1 + 2 (602 trials)

| A vs B | Pass diff (pts) | Judge diff |
| --- | --- | --- |
| qwen mtp vs none | +2.3 [-4.7, 9.3] | -0.02 [-0.31, 0.26] |
| qwen dflash vs none | +1.2 [-7.0, 9.3] | +0.08 [-0.17, 0.36] |
| qwen dflash vs mtp | -1.2 [-5.8, 3.5] | +0.10 [-0.05, 0.26] |
| gemma mtp vs none | +2.3 [-4.7, 9.3] | -0.06 [-0.26, 0.15] |
| muse dflash vs none | +4.7 [0.0, 10.5] | +0.02 [-0.13, 0.18] |

- Judge: every interval now sits inside the +/-0.5 practical margin. Round 1's
  qwen dflash +0.40 did not repeat.
- Pass: every point estimate but dflash-vs-mtp is positive, by 1-5 points. Muse's
  lower bound touches zero. Of the six scenarios where Muse's two arms differ,
  five favor dflash, and two of those five are `none` failures that were
  speed-sensitive (below). Leaving speed-sensitive stops out, Muse is +4.7
  [-1.2, 11.6] and qwen mtp 0.0.

## Speed confound: now observed

analyze.mjs now flags a failure as speed-sensitive when it is a hard-ceiling
stop, or a time-triggered stop (`stale no-write repair loop`, retry-loop
stall/long path) that cut off a turn still running (daemon.log `EXIT throw ...
stopped before the model finished` within 20 s of the harness terminal).

Rounds 1-2: qwen none 2, muse none 2, muse dflash 1, all others 0.

- r2 qwen none and muse none `craftbook-codemod-sweep`: the stale no-write loop
  fired at 244-246 s while the repair turn was generating. Its in-flight
  deferral is a flat 4 min (`NO_WRITE_REPAIR_INFLIGHT_DEFER_MS`), not scaled by
  decode rate, so an 11-12 t/s turn outlives it. The qwen turn had made six tool
  calls and was in prefill for a write-only repair call when it was stopped.
- r2 muse none `craftbook-edit-midtask` and muse dflash
  `craftbook-export-generalize`: hard ceiling, one in each arm.
- Correction to ROUND1.md: r1 qwen none `craftbook-deep-security-review` was
  flagged too. Its repair turn had ended without the missing section, as
  ROUND1.md says, but the outer session had resumed and was generating (turn
  476 s old) when the stop fired 10 s later. "None was cut off mid-generation"
  holds for the repair turn only.

The flag is conservative: it marks stops that speed could have changed, not
ones it did. Speed-sensitive failures are 4 of 36 failures in the `none` arms
and 1 of 34 in the speculation arms.
