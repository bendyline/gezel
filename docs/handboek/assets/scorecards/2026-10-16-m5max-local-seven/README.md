# October 2026 M5 Max local-model evaluation

The campaign recorded **601 observations: 476 passes, 119 task failures and
6 infrastructure exclusions**. No score, failure class or exclusion was
changed for publication.

The scorecard compares **600** of them: 476 passes, 118 task failures and 6
infrastructure exclusions. One failed observation's comparison identity
changed after the trial ran. It stays in the details file, marked
`includedInScorecard: false`, rather than being dropped or reclassified.

## Rounds

- `2026-10-16-m5max-local-seven-completed-arms`: four models, each with all
  129 cells (516 observations); `scope: suite`. This is the headline table.
- `2026-10-21-m5max-ornith-observed-subset`: 84 Ornith observations with a
  stable comparison identity, out of 85 recorded and 129 planned;
  `scope: subset`. Its tasks ran fewer than three times each, so it reports
  raw counts, not percentages.
- Nemotron and MiniCPM were not run, so they have no result rows.

## Files

- [scorecard.json](scorecard.json): the dataset behind the Handboek's model
  scorecard (`ScorecardDatasetSchema` v1), with 600 observations in the two
  rounds above.
- `runs/*.json`: the same data split by round. Use the combined file or the
  round files, not both.
- [scorecard-details.json](scorecard-details.json): all 601 observations, the
  248 scored artifacts, the 18 rubrics with their exact axes, every missing or
  ungraded disposition, per-trial and aggregate performance, provenance and
  caveats. [scorecard-details.schema.json](scorecard-details.schema.json) is
  its JSON Schema.
- [manifest.json](manifest.json) lists each file's size and SHA-256.
  [verification.json](verification.json) records the reconciliation and
  validation checks.

## Judging

Quality is reported per rubric, never as one number. Averaging scores from
different rubrics would produce a misleading quality score, so the
scorecard's single judge mean and `judgeModelId` are deliberately empty. Read
`judging.rubricAggregates` (by suite, scenario and model) and `trials[].judge`
in the details file instead.

Coverage: 248 scored artifacts, 4 trials with no artifact, 14 rubric
mismatches (the A/B readout), 335 trials with no applicable rubric, and none
pending. Artifacts were scored after deterministic failures as well as
successes.

An AI reviewer working in an interactive Codex session wrote the reviews,
with a 20 KiB input limit per review. They are recorded as
`codex-inline/current-session`; the reviewer's exact model version was not
recorded. The reviewer could see which model produced each artifact, so the
reviews are not blind: treat them as advisory. Their original integer axes
and justifications are preserved.

## Performance

The scorecard's `performance` fields are means of short admission probes:
nine probes across five models. **Every probe generated fewer than 256
tokens**, and Ornith's only probe generated 84, so treat these rates as
preliminary, not as sustained throughput. Suite rows reuse the same probes;
they are not additional samples.

For sustained comparisons, use `performance.models[modelId].comparisonObservations`
or `bySuite` in the details file: median, minimum and maximum decode and
prefill rates from the engine logs, with row counts and wall times. Wall times
include startup, file copies and tool work. `allRecorded` keeps the full
population, including the flagged observation.

Context size and f16 KV cache are the settings each engine actually launched
with. Memory is the median peak RSS of the trials that launched an engine. GPU
utilization was not available. Trials ran one at a time, some copied models
across volumes, and another app's engine sometimes ran at the same time; one
trial failed memory admission before inference. The details file records
each of these.

## Provenance

These files were prepared from the closed campaign with no new inference,
judging or score changes. Evidence paths in the details file refer to
Bendyline's retained evaluation archive, which is not included. The files
contain no credentials, raw chat transcripts or home-folder paths; temporary
folders in failure messages are shown as `<tmp>`.
