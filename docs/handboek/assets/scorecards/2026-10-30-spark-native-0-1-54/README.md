# Spark native 0.1.54 scorecard

This publication contains all 258 planned attempts for Qwen 3.8 27B Q4 and
Gemma 4 12B Q4 on Windows ARM64 / NVIDIA RTX Spark N1X. Execution occurred
October 28–30, 2026. The original directory retains its October 27 planning
date. No inference or judging was repeated for publication.

- [Product scorecard](scorecard.json): three separately registered rounds,
  consumed by the Handboek scorecard macro and other repository reports.
- [Full evidence companion](scorecard-details.json): every trial's result,
  fixed score, facts, performance, host, postmortem, review selection and
  publication classification; exact judge axes and rationales, diagnostics,
  provenance and original evidence hashes.
- [Reviewed report](report.md), [scenario/repetition comparison](scenario-comparison.md),
  [trial CSV](overall-trials.csv) and [coverage audit](final-coverage-audit.md).
- [Original analytical comparison](overall-scorecard.json): raw-eligibility
  aggregates and explicitly labeled diagnostic sensitivity views. This is
  distinct from the publication-only attribution correction below.
- [Verification](verification.json) and [file manifest](manifest.json).
- Complete judge ledgers: [original](judging/original.json),
  [continuation](judging/continuation.json), [final six](judging/final-six.json).

## Segments and attribution

| Segment | Attempts | Raw passes | Raw infrastructure exclusions | Published additional non-model failures |
|---|---:|---:|---:|---:|
| Original script-isolation condition | 169 | 117 | 1 | 0 |
| No-OS-sandbox continuation | 83 | 59 | 1 | 0 |
| Same-condition final six | 6 | 1 | 0 | 1 |

All 86 model/suite/scenario groups have repetitions 1, 2 and 3 across the
campaign. The 43 suite entries represent 41 distinct scenarios; shared
members are separate suite observations. No prior cancelled samples or
retries are included. Neither execution condition independently contains
three repetitions of every task. Original and continuation conditions must
not be pooled. The report's explicitly labeled C + F comparison is supported
by verified source, runtime, catalog, model and environment equivalence;
the product dataset still keeps all three journals as separate rounds.

The first raw exclusion is an isolated-home sandbox-launcher resolution
failure. The launcher existed on the machine. The second is an undefined
`workPath` in a model-authored recipe classified as an unevaluable gate;
its authoring origin remains explicit. The final Gemma fanout attempt never
started inference because capacity was reserved by a preceding model claim.
The published table attributes that attempt to infrastructure, reducing
attributable observations from 256 to 255. Its raw model-default failure and
3.5 fixed score are unchanged in the companion and analytical report. No
passing observation was removed or altered.

## Judging and performance

119 bounded content judgments cover 125 produced declared artifact paths in
112 trials; identical copies share a content judgment. The table selects one
primary review per trial: 106 included, six excluded for a mismatched A/B
rubric, two missing artifacts, and 144 trials with no declared axes. All
secondary and excluded reviews remain downloadable. Exact axes stay grouped
by rubric; there is no pooled public quality score. Reviews used
`codex-inline/current-session`, integer 0–10 axes and at most 20 KiB per
artifact. Source reviews do not establish complete rendered visual quality.

Task performance covers all attempts, including failed and non-model trials,
within each segment. It uses per-trial medians, ranges and sample counts,
not admission-probe estimates. Original analytical aggregate medians use
raw-eligible trials instead, so the populations are explicitly different.
Durations include orchestration and waiting; first artifact may be supporting
work rather than the completed output. RSS, system RAM and GPU memory are
separate measurements. The runtime exposes 23 GB system RAM and 40,960 MB
GPU memory; RSS alone is not the model's whole footprint.

Duration, calls and sampled RAM/GPU fields cover 258/258 attempts; first
tool/action 257/258; first artifact 240/258; real engine input/output and
decode/prefill 257/258. The final Gemma waiting attempt has raw HTTP zero
counters from an unrelated provider bucket. Its analytical local-model
tokens are unavailable; its memory samples measure a waiting daemon and
ambient device state. A separately reconstructed large-PR first-write timing
is retained without replacing the raw null. Two Gemma CUDA incidents and
stalls with cache activity are documented without asserting unproven causes.

## Validation and reproduction

The importer validates raw journal/result/score agreement, existing final
audit hashes, fixed review axes, integer scores, means, artifact hashes and
review bounds. It imports existing observations only, records the explicit
publication correction, and validates all output shards against
`ScorecardDatasetSchema`. Raw trials and the two stopped journals are not
modified. Workstation paths and hostname are redacted; hashes refer to the
original unsanitized evidence.

Run from a checkout with the original ignored `evals/runs` archive:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-native-054-scorecard.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/gen-scorecard-barrel.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-spark-native-054-scorecard.mjs --check
```

The source archive is required only to regenerate or check the import.
Checked-in shards and the complete structured companion are sufficient for
report rendering. Individual evidence links in the copied reports open the
companion, where their original archive paths and content are retained.
Raw transcripts, generated artifacts, native binaries, process logs and
credentials are not included in the download.
