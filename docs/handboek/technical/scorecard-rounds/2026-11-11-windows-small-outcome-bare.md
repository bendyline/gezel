---
title: November small-model evaluation on a 12 GB laptop GPU
runs:
  - 2026-11-11-windows-small-outcome-bare
---

Fourteen small models ran every scenario in core, productivity, developer and complex work three times on a Windows laptop with an NVIDIA RTX 5070 Ti Laptop GPU (12 GB): 1,806 attempts, one at a time, from November 11 to November 26. Every attempt used the same Gezel commit, native 0.1.62 with llama.cpp on CUDA, and the `auto` task strategy, which for these models is the outcome strategy without the recipe; craftbooks without a contract run step by step. **848 attempts passed**, 952 failed their tasks, and six were excluded for infrastructure: four daemon crashes within eight seconds of starting and two unavailable sandboxes.

| Model | Core | Productivity | Developer | Complex work | **Total** |
|---|---:|---:|---:|---:|---:|
| Ornith 1.5 9B | 26/33 | 32/39 | 26/30 | 22/27 | **106/129** |
| Gemma 4 12B | 29/33 | 34/39 | 23/30 | 12/27 | **98/129** |
| Qwen 3.5 9B | 26/33 | 31/39 | 26/30 | 14/27 | **97/129** |
| Gemma 4 E4B | 27/33 | 36/39 | 17/30 | 12/27 | **92/129** |
| Qwen 3.5 4B | 18/33 | 32/39 | 23/30 | 11/27 | **84/129** |
| Nemotron 3.5 Bolt E4B | 24/33 | 27/39 | 18/30 | 10/27 | **79/129** |
| LFM3 1.7B | 12/33 | 24/39 | 11/30 | 11/27 | **58/129** |
| MiniCPM5 2B | 11/33 | 22/39 | 14/30 | 7/27 | **54/129** |
| Granite 4.2 3B | 14/33 | 18/39 | 11/30 | 9/27 | **52/129** |
| Granite 4.2 8B (partly on the CPU) | 22/33 | 13/39 | 9/30 | 7/27 | **51/129** |
| Gemma 4 E2B | 17/33 | 13/39 | 4/30 | 6/27 | **40/129** |
| Qwen 3.5 2B | 8/33 | 11/39 | 6/30 | 4/27 | **29/129** |
| Qwen 3.5 0.8B | 2/33 | 1/39 | 1/30 | 1/27 | **5/129** |
| MiniCPM5 1B | 0/33 | 0/39 | 0/30 | 3/27 | **3/129** |

**Ornith 1.5 9B led overall and on complex work**, where it passed 22 of 27 attempts; no other model passed more than 14. Gemma 4 E4B had the best productivity result (36/39), and Qwen 3.5 9B tied Ornith on developer tasks. Among the smallest models, LFM3 1.7B passed as many complex-work attempts as Qwen 3.5 4B. Qwen 3.5 0.8B and MiniCPM5 1B passed 5 and 3 of 129 attempts: they were the fastest models here, so this work is simply beyond them.

**Every model ran entirely on the GPU except Granite 4.2 8B.** At its catalog context of 65,536 tokens with f16 KV cache it needs about 15 GiB, so llama.cpp placed part of it on the CPU in all 129 attempts. It generated 4.1–19.8 tokens/s (median 10.8), and 50 of its 78 failures were attempts stopped for lack of progress or by the time limit, against at most one for each of the other models from 3B up. Its results are probably understated and are not a measure of the model on a GPU that holds it. Nanbeige 4.2 3B was not run, for the same reason.

GPU power changed during the sweep, so speeds are kept in separate periods. The three Gemma models and the first 21 Qwen 3.5 9B core attempts ran with the laptop's GPU limited to 45 W; the rest ran at about 77 W, where Qwen 3.5 9B generated a median of 58 tokens/s against 43 under the lower limit. Five Nemotron productivity attempts overlapped 22 minutes on battery and ran at about 60 tokens/s against 106 on AC power. Early in the run, Windows Modern Standby throttled the GPU about tenfold; cells measured then, and one cell interrupted by a power loss, were discarded whole and rerun with the laptop held awake. No published attempt overlaps standby.

**Claude Sonnet 5.5 reviewed every deliverable** after the sweep, through the Claude CLI. Of the 798 attempts whose task has a review rubric, 724 were reviewed and 74 produced no deliverable; the other 1,008 attempts have no qualitative rubric. The reviewer saw the task and up to 20 KiB of the deliverable, but not the model or whether the attempt passed. Ornith 1.5 9B had the highest pooled review mean (5.9 of 10), and half the models fell between 4 and 5. Reviews are advisory, kept separate by rubric, and never change pass/fail.

Speeds are medians of each attempt's rate, taken from the engine's own timings, and exclude tool time. Memory is reported as two separate peaks that must not be added: the daemon and engine in system memory, and the model on the graphics card, which reached 10,208 of 12,227 MiB. Every model's weights match the catalog entry of the Gilde release the run used, byte for byte.

Download the [scorecard data](../../assets/scorecards/2026-11-11-windows-small-outcome-bare/scorecard.json), [every attempt with its review, speeds and memory](../../assets/scorecards/2026-11-11-windows-small-outcome-bare/scorecard-details.json), or the [same attempts as a spreadsheet](../../assets/scorecards/2026-11-11-windows-small-outcome-bare/trials.csv). The [download notes](../../assets/scorecards/2026-11-11-windows-small-outcome-bare/README.md) explain the power periods, exclusions, reviews and how to regenerate the export.
