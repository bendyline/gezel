# October 28 Windows Gemma 4 12B scorecard

This completed run contains 129 attempts: core 33, productivity 39,
development 30 and complex workflow 27. Every suite/scenario cell has three
trials. The October 27 identifier is the scheduling date; inference ran on
October 28, 2026, from 07:03:41 to 20:39:34 UTC.

- [scorecard.json](scorecard.json) is the page dataset, validated against
  ScorecardDatasetSchema v1. It includes per-suite task observations and
  separate rubric means with sample counts.
- [scorecard-details.json](scorecard-details.json) preserves all 129 trials,
  fixed-score axes, exact artifact judgments and justifications, token
  counters, durations, memory/GPU telemetry, exclusions and provenance.
- [verification.json](verification.json) records strict coverage and the
  completed evidence audit. [manifest.json](manifest.json) provides hashes
  and the commands to regenerate or check this export from the local archive.

## Capability and judging

There were 89 raw passes out of 129 attempts. The reviewed capability subset
contains 89 passes out of 116: three DocBlocks and nine development attempts
lacked required tools, and one authored gate could not be evaluated. The
last defect was model-authored, not a machine outage. Every excluded attempt
remains in the raw record and task-performance observations. A suite with
unmeasured scenarios may have its headline rate withheld by the page.

There are 59 actual artifact judgments: 56 included reviews and three A/B
reviews excluded because the frozen rubric did not match the task. All
excluded scores remain in the full report. Seventy trials had no applicable
qualitative rubric or generated HTML; these are explicitly not applicable,
not missing deliverables. No review is pending and no missing artifact has
an invented score.

Reviews were unblinded, by `codex-inline/current-session`, using the frozen
integer axes and a combined 20 KiB artifact/context limit. The exact judge
model revision is unavailable. Scenario-specific rubrics remain separate,
even where two rubrics use similar axis names. Reviews assess source and
artifact content, not rendered visual polish. Original review text is
preserved, including comments written before runtime validation finished.

Nine core HTML trials initially lacked a working browser executable. After
inference ended, all nine passed the unchanged canonical assertions using
cached Chrome 153.0.8010.12. No inference, repair, artifact edit or dependency
installation occurred during that validation. Short game checks do not
cover every gameplay defect. Petshop checks image references against saved
raster bytes using the original setContent behavior.

## Performance and provenance

Task observations use native engine logs for all attempts, including failed
and capability-excluded attempts. Tables show per-trial medians, ranges and
sample counts; they are separate from the original cached admission probe.
The full report also retains native token totals, provider counters, GPU
utilization and memory sample counts. Provider and native token counters
measure different things and must not be added together.

The median native decode rate was 121.16 tokens/s, with 18,196,306 input and
1,919,829 output tokens recorded by the engine. Native throughput excludes
tool and scheduling time; the complete run took about 13 hours 36 minutes.
Memory fields named MB are MiB. Process-tree RSS covers system memory;
discrete GPU memory is measured separately. Peak system RSS was 21,991 MiB,
peak GPU memory 10,730 of 12,227 MiB, and peak GPU utilization 100%.

The host used an AMD Ryzen AI 9 HX 370 and an NVIDIA GeForce RTX 5070 Ti
Laptop GPU. Native release 0.1.54 and all 62 files across four Windows
checkout variants were verified before launch. The engine used CUDA 12.8
and llama.cpp revision 620d2225cc436ab0b001e3200e590e3b286ef9ab. Main and MTP
model hashes, source/build/catalog hashes and the original Gilde version are
preserved in the data. No new inference or rescoring was used for this export.

Evidence references are relative to the retained local run archive. Raw
transcripts and generated artifacts are not included in this download.
Workstation paths and hostname are redacted; provenance hashes remain intact.
