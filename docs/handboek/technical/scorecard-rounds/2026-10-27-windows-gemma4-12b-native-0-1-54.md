---
title: October 28 Windows Gemma 4 12B results
runs:
  - 2026-10-27-windows-gemma4-12b-native-0-1-54
---

Gemma 4 12B completed all four task sets on an RTX 5070 Ti laptop using
native 0.1.54: 129 attempts, three per scenario in each suite, with 89 raw
passes. Twelve attempts lacked required tools and one had an unevaluable
model-authored gate. The reviewed subset contains 89 passes in 116 attempts;
the download retains every raw verdict and exclusion reason.

All 59 applicable artifacts were judged, including outputs from failed
attempts. The **Artifact reviews** tables keep each rubric separate, exclude
three A/B reviews with mismatched axes, and distinguish 70 tasks with no
applicable rubric from missing artifacts. These were unblinded source and
artifact reviews by `codex-inline/current-session`. Nine deferred browser
checks subsequently passed on unchanged saved artifacts; these short checks
do not establish complete gameplay or visual quality.

The **Task performance** tables cover all 129 attempts, with per-trial
medians, ranges and sample counts for native output and prefill speed, wall
time, peak system RSS and peak GPU memory. The overall median native output
rate was 121.16 tokens/s. Admission-probe rates remain separate. Exact token
counts, GPU utilization, memory samples and fixed-score breakdowns are in the
download.

Download the [scorecard data](../../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/scorecard.json),
[full judging and performance report](../../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/scorecard-details.json),
and [measurement notes](../../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/README.md).
The run identifier retains the October 27 scheduling date; execution occurred
on October 28.
