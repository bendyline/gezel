---
title: October 25 M5 Max Bolt comparison and review data
runs:
  - 2026-10-25-m5max-bolt-five
---

The five-model core campaign completed all 165 trials: 11 scenarios, three
repeats, five models. Bolt and Gemma E4B each passed 26/33, Gemma E2B 14/33,
Gemma 12B 23/33 and Qwen 9B 21/33. Every trial was reviewed, including failed
outputs: 158 artifacts have advisory scores and seven missing outputs have
no invented score. HTML, code, data and document quality remain separate.

Download the [scorecard data](../../assets/scorecards/2026-10-25-m5max-bolt-five/scorecard.json)
and [full report JSON with judging and performance](../../assets/scorecards/2026-10-25-m5max-bolt-five/scorecard-details.json).
The full report preserves exact review axes and rationales, per-trial timings,
token coverage, fixed-score breakdowns, model identities and 32 documented
framework/evaluator findings. Some gate passes contained incomplete or broken
artifacts; some gates also rejected valid outputs. Raw verdicts remain
unchanged, and these findings do not establish when a defect was introduced.

Bolt ran on llama.cpp Metal using NVIDIA's October 23 revision; the other
models used MLX. The **Task performance** rows show task medians, ranges and
sample counts, including failed attempts and recovery. Bolt throughput is
request-derived; MLX decode is an active-stream estimate and MLX prefill is
unavailable. Token streams have incomplete coverage, first-write latency is
not completed-output latency, and process RSS is not GPU telemetry.
[Download notes and validation](../../assets/scorecards/2026-10-25-m5max-bolt-five/README.md)
explain the frozen comparison, measurement limits and excluded older trials.
