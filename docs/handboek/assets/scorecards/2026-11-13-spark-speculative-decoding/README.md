# DGX Spark speculative decoding comparison, November 13–22, 2026

A test of whether speculative decoding changes the quality of a model's work.
Three models ran on a DGX Spark (NVIDIA GB10, 122 GB shared memory, Linux
arm64) with Gezel native 0.1.62: llama.cpp v0.9.0 on CUDA 13.0 at revision
cd959bae. Gezel was built from 9e5fd58f with a clean tree, with Gilde 0.3.10.

| Arm | Speculation | How it was set | Scorecard model id |
|---|---|---|---|
| Qwen 3.8 27B Q4 | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` | `qwen3.8-27b-q4.none` |
| Qwen 3.8 27B Q4 | MTP, built-in head | `GEZEL_EVAL_LLAMA_SPEC_TYPE=draft-mtp` | `qwen3.8-27b-q4.mtp` |
| Qwen 3.8 27B Q4 | DFlash2 drafter | catalog default on CUDA | `qwen3.8-27b-q4` |
| Gemma 4 12B Q4 | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` | `gemma4-12b-q4.none` |
| Gemma 4 12B Q4 | MTP assistant model | catalog default | `gemma4-12b-q4` |
| Muse Glimmer 30B Q4 | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` | `muse-glimmer-30b-q4.none` |
| Muse Glimmer 30B Q4 | DFlash2 drafter | catalog default on CUDA | `muse-glimmer-30b-q4` |

The arm that matches the catalog's own setting carries the plain model id, so
model pages and `gezel doctor` quote only what a person gets by default. The
other arms appear only in this round. Each arm ran each of the 43 scenarios
three times, in three rounds with the arm order rotated: 903 trials. Every
trial's engine log was checked for its arm's speculation mode, and every
trial passed that check. No trial was repeated, replaced, set aside or
rescored.

- [Scorecard data](scorecard.json): the round the scorecard page reads.
  [runs/](runs/2026-11-13-spark-speculative-decoding.json) holds the same shard.
- [Full results](scorecard-details.json): every trial's result, score-trial
  facts, metrics, observed speculation, judge report and review selection,
  plus each cell's build stamp from the driver log.
- [Paired analysis](paired-analysis.json): the comparisons below, with every
  scenario's means.
- [Reviewed report](report.md): the final readout. [PLAN.md](PLAN.md) holds
  the endpoints written before the first trial; [ROUND1.md](ROUND1.md) and
  [ROUND2.md](ROUND2.md) are the interim readouts, and [results.md](results.md)
  the study's own tables.
- [All trials](trials.csv): one row per trial.
- Judge ledgers for [round 1](judging/judge-report-r1.json),
  [round 2](judging/judge-report-r2.json) and
  [round 3](judging/judge-report-r3.json), [verification](verification.json)
  and [file manifest](manifest.json).

## Results

| Task set | Qwen none | Qwen MTP | Qwen DFlash2 | Gemma none | Gemma MTP | Muse none | Muse DFlash2 |
|---|---:|---:|---:|---:|---:|---:|---:|
| General capability (core) | 33/33 | 32/33 | 33/33 | 32/33 | 32/33 | 33/33 | 32/33 |
| Office and knowledge work (productivity) | 38/39 | 37/39 | 37/39 | 34/39 | 33/39 | 36/39 | 39/39 |
| Engineering work (developer) | 25/30 | 30/30 | 29/30 | 23/30 | 26/30 | 28/30 | 29/30 |
| Complex workflows (complex-work) | 24/27 | 24/27 | 24/27 | 14/27 | 15/27 | 16/27 | 21/27 |
| All | 120/129 | 123/129 | 123/129 | 103/129 | 106/129 | 113/129 | 121/129 |

## Comparisons

Paired by scenario: each arm's mean over its three trials of a scenario, the
difference averaged over scenarios. Intervals are 95% bootstrap intervals over
scenarios. The p-value is an exact sign-flip test over the scenarios whose arms
differ, which is more reliable than the interval when only a few differ.

| A vs B | Pass-rate difference (points) | p | Review mean difference | p |
|---|---:|---:|---:|---:|
| Qwen MTP vs none | +2.3 [−3.1, 7.8] | 0.59 | −0.03 [−0.25, 0.19] | 0.82 |
| Qwen DFlash2 vs none | +2.3 [−3.1, 8.5] | 0.62 | +0.06 [−0.19, 0.32] | 0.67 |
| Qwen DFlash2 vs MTP | 0.0 [−3.1, 3.1] | 1.00 | +0.09 [−0.11, 0.27] | 0.39 |
| Gemma MTP vs none | +2.3 [−3.9, 8.5] | 0.64 | +0.03 [−0.10, 0.16] | 0.67 |
| Muse DFlash2 vs none | +6.2 [1.6, 11.6] | 0.055 | +0.02 [−0.09, 0.13] | 0.79 |

Every review-mean interval sits inside the ±0.5 margin set before the run. No
pass-rate difference survives correction for ten tests, which would need a
p-value below 0.005. The Muse difference rests on 8 of 43 scenarios and has no
known cause. Three of Muse's 16 failures without speculation were
speed-sensitive (below), against one of its 8 with DFlash2; the rest stopped
after a counted number of attempts or went idle, which speed does not change.
On scenarios both arms passed every time, speculation moved how much the
models wrote and how many tool calls they made by 6% or less.

## What to read carefully

**Some failures depend on speed.** A failure counts as speed-sensitive when
it hit the hard time ceiling, or when a stop triggered by elapsed time cut off
a model turn that was still running. Eight of 903 were: four for Qwen and three
for Muse without speculation, and one for Muse with DFlash2. Five of the eight
came from one harness check whose wait for a running turn is a flat four
minutes, whatever the decode speed. They all count as failures in the tables.
With them left out, Qwen MTP vs none is −0.8 points and Muse DFlash2 vs none
+5.0. Leaving out only failures favors the arm that had them, so treat these
figures as a bound, not an estimate.

**Round 2 was judged twice.** Its first judge pass exited successfully having
judged none of its 301 trials; the cause was not recorded. A re-run on
November 20 judged the expected 133, and that ledger is the one published.

## Judging

Claude Sonnet 5.5, through the Claude CLI, reviewed 397 artifacts: the 16
scenarios that declare a rubric, plus the default HTML rubric for the three
game tasks. Each rubric has its own column; there is no combined quality
score. Two trials with a declared rubric produced nothing to review (one Qwen
API-contract review and one Muse research brief, both without speculation).
The other 504 trials had no rubric to apply. No review is excluded. Reviews
are advisory and unblinded: the judge saw the prompt and one artifact, not
which arm made it.

## Performance

Speeds come from the engine's own logs, for every attempt including failures.

| Arm | Output, median | Drafts accepted | Median trial | Total trial time |
|---|---:|---:|---:|---:|
| Qwen none | 12.1 tok/s | – | 8.5 min | 48.8 h |
| Qwen MTP | 29.1 tok/s | 60% | 5.1 min | 31.1 h |
| Qwen DFlash2 | 33.0 tok/s | 59% | 4.3 min | 24.2 h |
| Gemma none | 28.7 tok/s | – | 4.6 min | 20.4 h |
| Gemma MTP | 76.5 tok/s | 66% | 2.7 min | 13.5 h |
| Muse none | 11.8 tok/s | – | 15.6 min | 47.9 h |
| Muse DFlash2 | 34.1 tok/s | 59% | 6.8 min | 33.9 h |

Whole trials speed up less than output because reading the prompt and running
tools take the same time either way. Within each model, every arm launched
llama-server with the same context window, f16 KV cache, one slot and
reasoning budget; only the drafter differed. Memory is not shown: the GB10's GPU uses shared memory the
process measurement cannot see.

## Reproducing

The importer reads the local `evals/runs` archive, which is not in the
repository. It checks every trial's speculation mode against its engine log,
every cell's build stamp in the driver log, and the judge ledgers against each
trial's own review, then recomputes the paired analysis and confirms it matches
the study's own results:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-speculative-decoding-scorecard.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/gen-scorecard-barrel.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-speculative-decoding-scorecard.mjs --check
```

The archive is needed only to regenerate or check this download. Home paths
and the hostname are redacted, and hashes identify the original files. The
score-trial facts leave out three diagnostic event lists (miscEvents,
continuity and retrieval); those, generated artifacts, transcripts and process
logs stay in the archive. Five verification trials, one per original arm, ran
before the sweep to confirm each speculation mode and are not included.
