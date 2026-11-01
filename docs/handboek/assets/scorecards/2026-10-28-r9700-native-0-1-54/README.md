# October 28–30, 2026 R9700 scorecard

The frozen comparison completed **258 trials**: 43 suite entries across core,
productivity, developer and complex-work, two models, exactly three repetitions.
Qwen 3.8 27B Q4 passed 104/125 eligible attempts; Gemma 4 12B Q4 passed 81/127.
Six raw exclusions remain recorded. A separate six-trial DocBlocks activation
condition completed three repetitions per model and is published as a subset,
without replacing or merging into the baseline.

## Downloads

- [scorecard.json](scorecard.json): the standard `ScorecardDatasetSchema` v1
  data used by the website. Both rounds are included with separate identities.
  The `runs/` files contain those same rounds individually; do not count both
  representations. The activation subset cannot become a full-suite headline.
- [scorecard-details.json](scorecard-details.json): all **264** structured
  trial records, original results, fixed-score axes and evidence, facts,
  metrics, timing, tool and continuity observations, both complete judge
  ledgers, scenario rubrics, per-model/suite/scenario/repetition statistics,
  comparative report, postmortems and final review audits.
- [verification.json](verification.json): reconciled populations and coverage.
  [manifest.json](manifest.json): generated file sizes, SHA-256 hashes and
  reproducible import/check commands.

The JSON companion also includes all 37 final review evidence files plus
additional coverage and activation audits. Reports inside the JSON contain
references to the retained local archive. These are evidence references,
not public artifact URLs. Raw transcripts, process logs and generated binary
artifacts remain in that archive. Personal home and checkout paths are
redacted in the download; hashes identify original evidence before redaction.

## Outcomes and exclusions

The baseline has 185 passes, 67 task failures and six raw infrastructure-class
exclusions. Three Qwen custom-gate attempts could not enforce Windows
`denyNet`. The other three exclusions arose from model-authored gate
configuration: Gemma's second parameter and custom-gate attempts, and Qwen's
third export attempt. Their raw `infra/gate-unevaluable` classifications are
preserved, with their causes disclosed separately from Windows failures.

Qwen's complex-work suite has zero eligible custom-gate attempts. The website
therefore withholds that suite headline; the 20/23 eligible raw aggregate
and all 27 recorded attempts remain in the download. No trial was replayed,
no gate was relaxed, and no counterfactual pass was added for evaluator defects.

All six original DocBlocks theme attempts lacked DocBlocks tools. The
activation condition exposed all 19 tools by adding the supported binary
deliverable contract to the original kickoff. Qwen passed 2/3; Gemma passed
0/3. Repair messages were rejected before delivery, so failures cannot be
described as ignored nudges or clean model-only failures. The condition
postmortem separates initial schema/grounding errors from unavailable repair.

The frozen capability implementation is `eval-run-fixed-v1`. It differs
from the skill's prose, including 18 partial-quality scores above the prose
cap. Those scores and the detailed mismatch audit remain unchanged.

## Judging

The download preserves **99 scored inline artifacts and three noArtifact
records**, plus **124 scored CLI artifacts and 140 CLI noArtifact records**.
These are overlapping reviewer populations, not 223 distinct scored outputs.
Inline judging used `codex-inline/current-session`; its exact model version
was not recorded. CLI judging used `anthropic-cli/claude-sonnet-4-6`.
Both use the frozen 20 KiB input limit and the recorded task axes.

The website's artifact-review tables select one opinion per trial: Codex
inline for declared axes, or Claude CLI for the three game HTML scenarios.
Different scenario rubrics are separate columns; there is no pooled quality
score. The detailed download retains the other reviewer's opinion as well.

- Six A/B reviews use axes for a mock-service plan, so their scores are
  excluded from task-quality interpretation for both reviewers.
- Six routing-page CLI reviews and one incidental fanout UI review are also
  excluded. Five routing pages are unchanged seeded fixtures.
- Another 137 baseline trials have no applicable artifact review. They count
  under **Excluded reviews**, which does not mean their required deliverables
  were missing. CLI `noArtifact` in these cells means its default HTML
  selection found nothing to judge.
- Three Gemma spreadsheet CLI reviews were corrected to the actual declared
  task artifact. Superseded opinions and correction evidence remain included.

Across both rounds the table accounts for 111 eligible reviews, three missing
declared reports and 150 excluded/not-applicable reviews. Quality is
conditional on producing an artifact; the counts must travel with the means.

## Performance and provenance

The host was Windows x64, Ryzen 9 7950X3D, 64 GiB RAM and Radeon AI PRO R9700,
using llama.cpp Vulkan from verified Gezel native 0.1.54. The actual baseline
started October 28 UTC (October 27 Pacific); the original archive directory
retains its October 27 name. Source, service, catalog, engine and local model
identities are preserved with the frozen conditions, including generalist
auto and the validated Chrome override.

Task measurements use all attempts, including failures and exclusions.
Decode and prefill come from engine logs, not admission probes or an
input-plus-output throughput fallback. Core performance covers all 264
trials; GPU telemetry covers 263. Qwen's second Squisq trial lacks GPU
telemetry and is not replaced with a zero or guessed value.

Wall time includes tools and recovery. First-token, first-turn TTFT,
first-tool and first-write timing remain distinct. First artifact is a write
proxy, not completed-deliverable latency; the reconstruction audit and
missing-data qualifications are included. Process RSS, whole-host RAM and
discrete GPU memory are different measurements; do not sum their medians.
Launch context and KV precision are recorded per trial, not inferred from
the catalog maximum. Local zero billing excludes hardware, energy and judge
costs.

## Reproduction

From the Gezel repository with the retained run archive available:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-r9700-scorecard.mjs
node scripts/gen-scorecard-barrel.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-r9700-scorecard.mjs --check
```

The importer verifies completion, exact repetitions, unique trials, raw
results/scores, unchanged baseline hashes, declared artifact hashes, judge
axes and coverage, plus the public schema. It performs no inference, judging,
reclassification or rescoring. The normal Handboek site export includes the
registered rounds and these downloadable assets.
