# ADR 0003: Throughput-scaled eval ceilings

- **Status:** Accepted
- **Decision owners:** eval harness

## Context

Every `timeoutMs` in `evals/src/scenarios/` is a hand-authored hard ceiling,
calibrated by watching a gemma-class model on a CUDA box that decodes at
21-23 tok/s. The eval measures capability, which is invariant to decode
speed — a trial reaches the same verdict at 5 tok/s or 50 tok/s, just over
different wall-clock. A fixed ceiling breaks that invariance and makes the
verdict a property of the hardware.

This produced real false negatives. On 2026-08-01, `conflict-synthesis` was
pinned at 30 min; gemma cleared it in 1.8 min at 22.5 tok/s while qwen needed
36.8 min at 4.8 tok/s and died on the wall with the harness itself reporting
"forward progress kept happening". Re-run with room it passed 13/13. The
first fix was to hand-bump that one constant to 90 min, which does not
generalize: 29 of 37 scenarios with explicit ceilings sit under 60 min, and
any of them can produce the same artifact on a slower model.

## Decision

The scenario-authored ceiling is scaled by measured decode throughput:

```
scale     = clamp(20 / observed_tok_per_sec, 1, 8)
effective = min(authored * scale, DEFAULT_MAX_DURATION_MS)
```

- **Reference is 20 tok/s** — the class the ceilings were authored against.
- **Scaling is one-directional.** A model faster than the reference keeps the
  authored ceiling rather than earning a tighter one; the authored value is a
  runaway safety net, not a performance target.
- **An explicit `--timeout` is absolute** and never scaled. The operator asked
  for that wall clock.
- **The rate comes from the preflight admission probe**, threaded through
  `runBatch` into every trial, so a matrix pays for one measurement.
- **Two guards.** The 8x multiplier cap keeps a single bad rate measurement
  from silently lifting every ceiling to the 8 h backstop and disabling the
  safety net wholesale; the absolute clamp preserves that backstop.

### The probe is deliberately NOT lengthened

The probe generates only ~85 output tokens, and its measured rate spans 2x
across runs of an identical model+binary+host (3.94 / 5.09 / 5.22 / 7.89
tok/s on the DGX Spark). The obvious reading — too small a sample, lengthen
it — is wrong, and this is recorded here because it will be proposed again.

Each probe also reports a prefill rate over a 2,783-token sample, which is
unimpeachably large. That number spans **4.1x** across the same four runs
(169.8 - 703.4 tok/s) and correlates with the decode rate at **r = 0.996**.
Both are measuring the same thing: the host genuinely runs 2-4x faster on
some days than others. A longer probe would measure that same host state,
just as accurately, for more wall-clock on every batch.

Within a single run the host is stable, which is what makes a start-of-run
probe sufficient. Across the 11-scenario core suite on 2026-08-02 (1h40m),
per-trial decode spanned 7.61-7.95 tok/s — a 4.5% band with no thermal trend
(first four scenarios mean 7.79, last four 7.77) — against a probe reading of
7.89. **The probe predicted the run mean to 1.0%.**

`PreflightReport.promptTokensPerSec` is recorded for this reason: decode and
prefill move together with host state, so a future probe where the two
*diverge* is the signature of a measurement problem rather than a slow day.
Without the field, that distinction is unrecoverable after the fact.

### What the host variance turned out to be

Investigated 2026-08-02. The variance tracks **machine uptime**, and a reboot
on 2026-08-01 17:21 PDT sits exactly on the boundary between the slow and
fast readings:

| Probe (UTC) | Uptime | prefill tok/s |
|---|---|---|
| 2026-08-02 15:51 | 15.5 h | 703.4 |
| 2026-08-02 20:35 | 20.2 h | 641.6 |
| 2026-08-02 20:29 | 20.1 h | 632.4 |
| 2026-07-26 22:40 | 2.3 d | 300.7 |
| 2026-08-01 01:23 | 3.5 d | 290.3 |
| 2026-07-30 09:34 | 2.0 d | 169.8 |

Ruled out: **parallelism** (81 recorded trials, zero overlapping pairs — the
harness is strictly serial); **thermal throttling** (a 1h40m sustained suite
showed no decay, 7.79 → 7.77 tok/s, and `clocks_event_reasons.active` stayed
`0x0` with the die at 45-50 °C); **recent load** (a forced probe 20 min after
a 1h40m run, and another immediately after a different model's run, both
landed in the fast band at 7.08 and 6.90 tok/s).

The leading hypothesis is physical-memory fragmentation on a unified-memory
host — the GPU reads weights from system RAM, THP is `madvise` with no
hugepage reservation, and days of repeated ~29 GB model loads fragment the
pool. It is **unproven**: no fragmentation counters were captured on a slow
day. `PreflightReport.hostState` ([host-state.ts](../../evals/src/host-state.ts))
now records uptime, available memory, `thp_fault_fallback`, `compact_stall`,
and `compact_fail` on every probe so the next occurrence is decidable — a
nonzero `thpFaultFallback` on a slow day implicates fragmentation, a zero
exonerates it.

Operationally, until the mechanism is settled: a multi-day-uptime box can run
evals 2-4x slower end to end. Reboot before a long sweep, and treat
cross-day throughput comparisons as invalid unless uptime is comparable.

## Consequences

Ceilings adapt to the host instead of encoding one machine's throughput, and
adding a slower model to the matrix no longer requires re-tuning ~29
constants. The cost is that a ceiling is no longer a fixed number you can
read out of the scenario file — the effective value is logged per trial
(`[trial] throughput-scaled ceiling: 40m → 101m at 7.89 tok/s`).

Scenario ceilings should now be authored against the 20 tok/s reference and
left alone. Hand-bumping one for a slow model compounds with the scaling:
`conflict-synthesis`'s 90 min stopgap became 228 min at 7.89 tok/s — roughly
35x what the trial actually used — and has been reverted to its authored
30 min, which the scaling lifts to 76-152 min across the observed rate range
against a 36.8 min worst-case need. Two mechanisms solving one problem is how
ceilings drift out of meaning.

The no-progress watchdogs remain the primary terminators. This changes only
the backstop.

## Regression map

- [`evals/src/runner.test.ts`](../../evals/src/runner.test.ts) —
  `throughputScaledMaxDurationMs`: the one-directional rule, the multiplier
  cap, the 8 h clamp, nonsense-rate rejection, and a replay of the
  `conflict-synthesis` timings that motivated the change.
- [`evals/src/batch.test.ts`](../../evals/src/batch.test.ts) — the probe rate
  reaching every trial in a batch, a caller-supplied rate winning over the
  probe, and an unmeasured throughput leaving ceilings as authored.
