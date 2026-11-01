# DGX Spark scorecard, October 28–30, 2026

Qwen 3.8 27B Q4 and Gemma 4 12B Q4 ran all four task sets on a DGX Spark
(NVIDIA GB10, 122 GB shared memory, Linux arm64) with Gezel native 0.1.54:
llama.cpp on CUDA 13.0 at revision 620d2225. Each model ran each scenario
three times, 258 trials in all. No trial was repeated, replaced or rescored
for publication. Gezel was built from 22fec991 plus an uncommitted fix for
conditional clauses in step procedures, with Gilde 0.3.1.

- [Scorecard data](scorecard.json): the round the Handboek scorecard reads.
  [runs/](runs/2026-10-28-dgx-spark-class.json) holds the same shard.
- [Full results](scorecard-details.json): every trial's result, facts,
  metrics, fixed-rubric breakdown, judge report and review selection, plus
  the shard as the harness first wrote it.
- [Reviewed report](report.md): what the numbers mean, the measurement
  defects found during the run, and the fixes proposed.
- [All trials](trials.csv): one row per trial.
- [Judge ledger](judging/judge-report.json), [verification](verification.json)
  and [file manifest](manifest.json).

## Results

| Task set | Qwen 3.8 27B | Gemma 4 12B |
|---|---:|---:|
| General capability (core) | 33/33 | 32/33 |
| Office and knowledge work (productivity) | 34/39 | 32/39 |
| Engineering work (developer) | 21/30 | 14/30 |
| Complex workflows (complex-work) | 18/27 | 12/27 |

These are raw passes. The scorecard page sets aside the three trials the
harness classed as infrastructure failures, so it shows complex workflows as
18/25 for Qwen and 12/26 for Gemma.

## What to read carefully

**Engineering work had no test runner.** Evaluation homes run at the
strictest security level, which has switched package scripts off since
October 26. Bug-fix-tdd, codemod-sweep and refactor-module each need an
observed test run, so no model could pass them. The table keeps these 18
failures as model failures. Without them:

| Engineering work | Qwen 3.8 27B | Gemma 4 12B |
|---|---:|---:|
| Failure rate | 9/30 (30.0%) | 16/30 (53.3%) |
| Excluding failures at the tool-usage step | 0/21 (0.0%) | 7/21 (33.3%) |

A failure counts as tool-usage when the task stopped on a step that needs a
test run and the run tool was never offered. Each such trial is marked in
the full results and the trial CSV.

**Three trials are set aside.** One Qwen author-gate-script trial hit a gap
on Linux: Gezel cannot yet run a script the model wrote when that script
must both have no network access and report back to the app. The other two,
one per model, failed on a gate the model wrote itself. The harness classed
those as setup failures and the table keeps that classification, although
the model's own work caused them.

**Some failures are not about the model.** Docblocks-theme-roundtrip lacked
its DocBlocks tools in all six trials. The harness stopped two Qwen
route-multi trials and one Qwen author-fanout trial while their tasks were
still progressing. All of these count as failures.

**The reviewed report was corrected on October 31.** It first said Gemma
ignored the recipes Gezel suggested. In fact Gezel's suggestion tool offered
no fitting recipe, and Gemma did what it said. The report also named the
wrong tool for Gemma's text write into a Word file. It now lists the fixes
made since this round. The numbers here are unchanged.

## Judging

After the sweep, Claude Sonnet 4.6 (through the Claude CLI) reviewed 121
artifacts. Each rubric has its own column; there is no combined quality
score. The table uses 108 reviews: the declared rubrics, plus the default
HTML rubric for the three game tasks. It excludes 13 reviews:

- six A/B readout reviews, scored against a rubric written for a runbook;
- six find-vs-create reviews, which graded the seeded shop page;
- one author-gate-script review, which graded an incidental page.

The other 137 trials had no rubric to apply: their task declares none and
they produced no HTML page. No declared deliverable is missing. Reviews are
advisory and unblinded: the judge saw the prompt and one artifact, not the
running result.

## Performance

Speeds come from the engine's own logs, for every attempt including
failures. The scorecard page gives per-trial medians with ranges and sample
counts for each task set; across all of a model's trials:

| | Qwen 3.8 27B | Gemma 4 12B |
|---|---:|---:|
| Output, median | 28.6 tok/s | 76.3 tok/s |
| Prefill, median | 779 tok/s | 1,552 tok/s |
| Total trial time | 34.8 h | 16.0 h |

Both models ran with MTP speculative decoding on, the default, so output
speeds include accepted draft tokens. Wall time includes tool work and
waiting.

Memory is not shown. The GB10's GPU uses shared memory that the process
measurement cannot see, the GPU reports no memory figure of its own, and
whole-system memory includes everything else running. Each trial's samples
are in the full results.

## Reproducing

The importer reads the local `evals/runs` archive, which is not in the
repository. It checks the shard as first written against all 258 trial
results, checks the judge ledger against each trial's own review, and
recomputes the fixed scores:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-dgx-spark-class-scorecard.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/gen-scorecard-barrel.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-dgx-spark-class-scorecard.mjs --check
```

The archive is needed only to regenerate or check this download. Home paths
and the hostname are redacted, and hashes identify the original files.
Generated artifacts, transcripts and process logs stay in the archive. Two
earlier Qwen attempts, started before the browser used for checks was
installed, were set aside before the sweep and are not included.
