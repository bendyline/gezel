---
title: October 2026 Mac results and review data
runs:
  - 2026-10-16-m5max-local-seven-completed-arms
  - 2026-10-21-m5max-ornith-observed-subset
---

The Apple M5 Max campaign closed at 601 recorded attempts: 476 passed,
119 failed their tasks, and six were excluded for infrastructure problems.
LFM 2.5, Qwen 3.6, Qwen 3.8 and BTL4 each completed 129 attempts. Ornith
completed 85 of 129 planned attempts; Nemotron and MiniCPM were not run.

The tables retain 600 attempts in two separate rounds: four complete model
arms and the partial Ornith round. One additional failed Ornith attempt had
comparison-identity drift and remains in the evidence download with its
original classification, outside the comparison tables.

The [scorecard data](../../assets/scorecards/2026-10-16-m5max-local-seven/scorecard.json)
and [full judging and performance data](../../assets/scorecards/2026-10-16-m5max-local-seven/scorecard-details.json)
are available as JSON. The companion includes all 601 observations, 248
artifact reviews, each task's rubric and sample counts, and per-trial speed
and memory measurements. Four declared artifacts were missing, 14 reviews
had a mismatched rubric, and 335 tasks had no applicable declared rubric.
No review is pending. Different task rubrics are kept separate, so this
round has no combined quality score in the tables.

All nine admission probes generated fewer than 256 output tokens; Ornith's
single probe generated 84. Treat the table's speeds as preliminary. The
companion also records engine-derived speeds during the actual tasks and
their sample counts. [Download notes and validation details](../../assets/scorecards/2026-10-16-m5max-local-seven/README.md)
explain the populations and caveats.
