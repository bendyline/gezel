---
title: November 13–22 DGX Spark speculative decoding comparison
runs:
  - 2026-11-13-spark-speculative-decoding
---

This round asked one question: does speculative decoding change the quality
of a model's work? With speculative decoding, a small drafter proposes several
tokens at once and the model checks them, so it writes faster. On a DGX Spark
(NVIDIA GB10, Linux) with native 0.1.62 (llama.cpp v0.9.0 on CUDA), Qwen 3.8
27B Q4 ran three ways (no speculation, MTP and DFlash2), Gemma 4 12B Q4 two
ways (none and MTP) and Muse Glimmer 30B Q4 two ways (none and DFlash2). Each
of the seven ran every scenario in the four task sets three times: **903
trials**. Rows marked *default* use the setting Gezel ships for that model on
this machine.

**Speculation did not change measured quality.** Claude Sonnet 5.5 reviewed
397 artifacts. For each model, the review means of its settings match within
0.1 points, inside the ±0.5 margin set before the run. Pass counts out of 129
were 120 for Qwen without speculation, 123 with MTP and 123 with DFlash2;
103 and 106 for Gemma; 113 and 121 for Muse. None of those differences is
significant. Muse with DFlash2 comes closest, at +6.2 points with an exact p
of 0.055, and it is one of ten tests.

**It is much faster.** Output speed was 2.7 to 2.9 times higher with
speculation: Qwen wrote 12.1 tokens a second without it, 29.1 with MTP and
33.0 with DFlash2; Gemma 28.7 and 76.5; Muse 11.8 and 34.1. Whole trials took
29% to 50% less time. On Qwen, DFlash2 was 13% faster than MTP with the same
pass count.

Read the slower rows with care. Eight failures came from stops the test
harness makes after a fixed time while the model was still working: four for
Qwen and three for Muse without speculation, and one for Muse with DFlash2.
Faster decoding might have avoided them, but they still count as failures
here. Memory is left out because this machine's shared memory is invisible to
the measurement.

Download the [scorecard data](../../assets/scorecards/2026-11-13-spark-speculative-decoding/scorecard.json),
[full results with judging and performance](../../assets/scorecards/2026-11-13-spark-speculative-decoding/scorecard-details.json),
[paired analysis](../../assets/scorecards/2026-11-13-spark-speculative-decoding/paired-analysis.json),
[reviewed report](../../assets/scorecards/2026-11-13-spark-speculative-decoding/report.md),
and [all trials](../../assets/scorecards/2026-11-13-spark-speculative-decoding/trials.csv).
[Download notes](../../assets/scorecards/2026-11-13-spark-speculative-decoding/README.md)
explain the design, the checks and how to reproduce the data.
