---
title: October 28–30 DGX Spark results and review data
runs:
  - 2026-10-28-dgx-spark-class
---

Qwen 3.8 27B Q4 and Gemma 4 12B Q4 completed all **258 trials** on a DGX
Spark (NVIDIA GB10, Linux) with native 0.1.54: three per model and scenario
across the four task sets. Qwen passed 106 of 129 and Gemma 90 of 129. Three
failures are set aside as infrastructure: a gap in Linux script sandboxing,
and two gates the model wrote itself, which the harness classed as setup
failures.

Read the engineering set with care. Package scripts were switched off in the
evaluation homes, so three tasks that need a test run could not pass for
either model. The table keeps those 18 failures: Qwen failed 9 of 30
engineering trials and Gemma 16 of 30. Excluding them, Qwen failed 0 of 21
and Gemma 7 of 21. Docblocks-theme-roundtrip lacked its tools in all six
trials, and the harness stopped three Qwen complex-workflow trials while they
were still progressing. The reviewed report explains each case.

Claude Sonnet 4.6 reviewed 121 artifacts after the sweep. The **Artifact
reviews** tables use 108 of them, one column per rubric. They exclude 13
reviews that used the wrong rubric or graded a starting page instead of the
work; the other 137 tasks had no rubric to apply. The **Task performance**
tables give output speed, prefill speed and wall time from the engine's logs
for every attempt. Both models used speculative decoding, which is on by
default. Memory is left out because this machine's shared memory is
invisible to the measurement.

Download the [scorecard data](../../assets/scorecards/2026-10-28-dgx-spark-class/scorecard.json),
[full results with judging and performance](../../assets/scorecards/2026-10-28-dgx-spark-class/scorecard-details.json),
[reviewed report](../../assets/scorecards/2026-10-28-dgx-spark-class/report.md),
and [all trials](../../assets/scorecards/2026-10-28-dgx-spark-class/trials.csv).
[Download notes](../../assets/scorecards/2026-10-28-dgx-spark-class/README.md)
explain the set-aside trials, the review selection and how to check the data.
