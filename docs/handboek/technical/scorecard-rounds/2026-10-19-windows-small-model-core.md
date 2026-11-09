---
title: October 2026 Windows results and review data
runs:
  - 2026-10-20-rtx5070ti-core-continuation-64k
  - 2026-10-20-rtx5070ti-core-original-64k
  - 2026-10-20-rtx5070ti-nanbeige-core-32k
---

The eight-model core evaluation completed all 264 requested attempts on an
RTX 5070 Ti laptop: 182 passed, 70 failed their tasks, and 12 were excluded
after exceeding Nanbeige's 32K context. These were context failures, not GPU
out-of-memory failures. Every attempt has been reviewed.

The tables preserve three runtime rounds: 49 original trials, 182 trials
after a runtime correction, and the separate 33-trial Nanbeige 32K rerun.
The original and continuation rounds show counts because neither alone has
three repeats of every task. Nanbeige's full-suite score is withheld because
some tasks have no attributable results. Its 12 passes, nine model failures
and 12 infrastructure exclusions remain available in the data.

Download the [scorecard data](../../assets/scorecards/2026-10-19-windows-small-model-core/scorecard.json)
and [full judging and performance data](../../assets/scorecards/2026-10-19-windows-small-model-core/scorecard-details.json).
The companion preserves all 254 artifact reviews: 247 eligible reviews,
six infrastructure diagnostics and one excluded review that exceeded its
input limit. Ten attempts produced no artifact to score. The four task
rubrics stay separate: the **Artifact reviews** tables show HTML, code, data
and document quality means with eligible artifact counts, plus counts for
missing artifacts and excluded reviews. These were unblinded reviews by
the OpenAI Codex agent that ran the round, in the same session; no combined
quality score is calculated.

The **Task performance** tables show output and prefill speed, wall time,
peak system RSS and peak GPU memory as per-trial medians with ranges and
sample counts. They include available observations from all attempts,
including failures. These engine-log measurements are separate from
admission probes. GPU performance changed during the run, so each journal
keeps its own measurement period, including Nanbeige's slower and later
faster periods. [Download notes](../../assets/scorecards/2026-10-19-windows-small-model-core/README.md)
explain provenance, exclusions, memory headroom and validation.
