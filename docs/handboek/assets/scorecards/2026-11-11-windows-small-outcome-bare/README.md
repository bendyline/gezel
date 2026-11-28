# November 2026 Windows small-model scorecard

Fourteen small models ran every scenario in core, productivity, developer and
complex-work three times on a Windows laptop with a 12 GB NVIDIA RTX 5070 Ti
Laptop GPU: 1,806 attempts, 848 passes,
952 model failures and 6
infrastructure exclusions. Trials ran one at a time from 2026-11-11
to 2026-11-26, from a checkout at `92437e37` whose
daemon and packages were last built from `7e7fb07c`, one commit earlier
(the newer commit changed no evaluation code), with Gezel native 0.1.62
(llama.cpp build 12110, CUDA 12.8) and Gilde 0.3.8.

- [scorecard.json](scorecard.json) is the page dataset, validated against
  ScorecardDatasetSchema v1: pass counts per scenario, per-trial speed and
  memory medians by power period, and review means by rubric.
- [scorecard-details.json](scorecard-details.json) keeps all 1,806
  trials: outcome and failure class, engine launch record, speeds, tokens,
  memory and GPU telemetry, the full Sonnet 5.5 review with its axes and
  rationale, and a hash of every evidence file read.
- [trials.csv](trials.csv) is the same trials as one spreadsheet row each.
- [verification.json](verification.json) records the coverage checks, and
  [manifest.json](manifest.json) the file hashes and the commands that
  regenerate or check this export from the local archive.

## Results

| Model | Passed | Median output (tok/s) | Review mean (reviews) | Ran on |
|---|---:|---:|---:|---|
| Ornith 1.5 (9B, Q4) | 106/129 (82%) | 61.93 | 5.89 (57) | GPU |
| Gemma 4 (12B, Q4) | 98/129 (76%) | 25.84 | 4.81 (57) | GPU |
| Qwen 3.5 (9B, Q4) | 97/129 (75%) | 56.9 | 5.07 (57) | GPU |
| Gemma 4 (E4B, Q4) | 92/129 (71%) | 124.93 | 4.68 (57) | GPU |
| Qwen 3.5 (4B, Q4) | 84/129 (65%) | 39.56 | 4.49 (57) | GPU |
| Nemotron 3.5 Bolt (E4B, Q4) | 79/129 (61%) | 105.57 | 4.45 (56) | GPU |
| LFM3 (1.7B, Q4) | 58/129 (45%) | 243.99 | 4.47 (56) | GPU |
| MiniCPM5 (2B, Q4) | 54/129 (42%) | 147.13 | 4.05 (57) | GPU |
| Granite 4.2 (3B, Q4) | 52/129 (40%) | 100.09 | 3.88 (57) | GPU |
| Granite 4.2 (8B, Q4) | 51/129 (40%) | 10.77 | 4.43 (46) | GPU + CPU |
| Gemma 4 (E2B, Q4) | 40/129 (31%) | 202.71 | 3.64 (54) | GPU |
| Qwen 3.5 (2B, Q4) | 29/129 (22%) | 196.09 | 3.41 (51) | GPU |
| Qwen 3.5 (0.8B, Q4) | 5/129 (4%) | 298.04 | 2.5 (46) | GPU |
| MiniCPM5 (1B, Q4) | 3/129 (2%) | 295.21 | 1.4 (16) | GPU |

Passed counts every attempt, including the six infrastructure exclusions.
Output speeds pool each model's trials: the three Gemma models ran entirely,
and Qwen 3.5 9B partly, under the 45 W limit described below, so their speeds
are not comparable with the rest. The page splits them by period. Review
means are advisory, pooled here across rubrics for a quick read; the page
and the dataset keep each rubric separate, and a mean covers only trials
that produced a deliverable.

## What was run

Task strategy was `auto`, which for these models is outcome without the
recipe; craftbooks without a contract fall back to stepwise by design. Each
model used its catalog context with f16 KV cache and one slot. Every model
was fully resident on the GPU except Granite 4.2 8B, whose offload plan
needed about 15 GiB at a 65,536-token context. llama.cpp placed part of it on
the CPU in all 129 trials, it decoded 4.11–19.76
tokens/s (median 10.77), and 50 of its 78 failures
were attempts stopped for lack of progress or by the time limit rather than
wrong answers, so its results are probably understated.
Nanbeige 4.2 3B was not run for the same reason. Model weights match the
Gilde 0.3.8 catalog entries byte for byte (SHA-256 recorded per model).

## Power periods

GPU power changed during the sweep, so speeds are reported per period:

- **Plugged in, G-Helper Silent · 45 W GPU limit**: 408 trials, all
  three Gemma models and the first 21 Qwen 3.5 9B core trials, until
  2026-11-16T14:17:15Z.
- **Plugged in, G-Helper Turbo · about 77 W GPU limit**: 1,393 trials, the rest.
- **Partly on battery, G-Helper Balanced**: 5 Nemotron
  productivity trials that overlapped 22 minutes without AC power on
  2026-11-24.

Windows Modern Standby throttled the GPU about tenfold early in the run.
Cells measured during standby, and the Qwen 3.5 9B complex-work cell a
power loss interrupted, were discarded and rerun with the host held awake.
No published trial overlaps a standby window from the Kernel-Power log. Speed
differences between periods are hardware, not model, effects.

## Reviews

Claude Sonnet 5.5 reviewed each deliverable after the sweep, through the
Claude CLI (`anthropic-cli/claude-sonnet-5-5`), with up to 20 KiB of the
artifact. 798 trials had a rubric: 724 were
reviewed and 74 produced no deliverable. The other
1,008 trials have no qualitative rubric and are marked not
applicable. Four reviews failed silently in the first pass and were rerun the
same night. The three game anchors share the generic HTML rubric; every
other reviewed scenario has its own axes. Reviews never change pass/fail.

## Measurements

Speeds come from llama-server's own timings in each trial's engine log and
exclude tool and scheduling time. Wall time includes them. The four
daemon-crash trials never started an engine, and two MiniCPM5 1B trials
logged no speeds, so their periods have fewer samples than trials. Memory
fields are MiB: system RSS covers the daemon and engine processes, GPU
memory is the card, and the two must not be added. The page's probe speeds
are separate admission probes, not task medians.

Regenerate or check this export with the commands in [manifest.json](manifest.json).
Nothing here required new inference.
