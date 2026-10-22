# Local scorecard publication package

Prepared from the closed 601-observation campaign. This maintained copy is shipped by the Handboek website exporter. No new inference, judging or environment restoration occurred; deployment and committing remain separate steps.

## Files

- `scorecard.json`: validates against the current Gezel `ScorecardDatasetSchema` v1. It contains **600 comparison observations** in two explicitly separate rounds.
- `runs/*.json`: the same dataset split into the two existing-reader shard files; import the combined file OR the shards, not both.
- `scorecard-details.json`: companion preserving **all 601 original observations**, all **248 scored artifacts**, the 18 distinct scored rubrics and exact axes, all missing/mismatched/ungraded dispositions, per-trial and aggregate performance, provenance references and caveats.
- `scorecard-details.schema.json`: JSON Schema for the companion, generated from the validator used here.
- `manifest.json` and `verification.json`: file hashes, reconciliation and validation receipts.

## Accounting and comparison scope

The recorded evidence remains **476 passes + 119 task failures + 6 infrastructure exclusions = 601**. Original failure classes and fixed scores were not changed.

The comparable scorecard contains **476 passes + 118 task failures + 6 infrastructure exclusions = 600**. One additional failed observation had post-trial comparison-identity drift; it is retained in the companion with `includedInScorecard: false`, not silently discarded or reclassified.

- `2026-10-16-m5max-local-seven-completed-arms`: four fully recorded 129-cell arms (516 observations); `scope: suite`.
- `2026-10-21-m5max-ornith-observed-subset`: 84 stable-identity Ornith observations out of 85 recorded and 129 planned; `scope: subset`. The reader's headline table remains the completed four-model round. Ornith's claims are raw counts, not percentages, because its tasks ran fewer than three repetitions.
- Nemotron and MiniCPM were not run. MiniCPM's separate experimental engine pin is documented only; there is no MiniCPM result row.

## Judging

The current v1 reader only has a single judge mean per model/suite. That field and `judgeModelId` are intentionally absent/null: averaging different task rubrics would manufacture a misleading quality score. A consumer must read the companion's `judging.rubricAggregates` (keyed by suite/scenario/model) and `trials[].judge` to display quality. **Existing v1 readers do not automatically show companion judging.** No global source/schema or UI extension is part of this data package.

Coverage: 248 scored artifacts; 4 `noArtifact`; 14 `judgeSpecMismatch` (A/B readout); 335 without an applicable declared rubric; zero pending. Produced declared artifacts were judged after deterministic failure as well as success. Provider/model: `codex-inline/current-session`; 20 KiB cap, original integer axes and justifications preserved.

## Performance

The standard scorecard `performance` fields follow the existing contract: arithmetic means of recorded paired admission-probe rates, with `samples` counting probes (nine total across five models). **Every probe generated fewer than 256 decode tokens**, so these short, preliminary rates should not be presented as sustained throughput. Ornith's lone probe generated only 84 tokens. Run notes and companion probe records preserve these warnings. The model probe set is reused across suite rows; suite rows do not constitute additional probes.

For sustained comparisons use companion `performance.models[modelId].comparisonObservations` or `bySuite`: median/min/max engine-derived decode and prefill rates, row counts and wall durations including startup/copy/tool work. `allRecorded` retains the original population including the flagged observation. Runtime context and f16 KV are observed launch settings; memory is the median peak RSS among selected trials that actually launched an engine. GPU-utilization telemetry was unavailable. Sequential runs, cross-volume copies, selected foreign-engine overlaps and the pre-inference memory-admission failure remain caveats.

## Integration

This checkout's existing publication consumer loads round shards from `packages/core/src/scorecard/data/runs`, with the generated barrel in that directory; Gilde does not currently own this scorecard schema. The two round shards are registered in that core dataset and its generated barrel. This package lives in `docs/handboek/assets/scorecards/2026-10-16-m5max-local-seven/`; the Handboek exporter copies it to the site's assets directory. The Model scorecard article links to the combined data and companion. The separate Gilde catalog does not need an edit. No release, commit or live-site deployment has occurred.

When wiring a publisher, retain both round scopes, notes, the 600/601 accounting difference, low-confidence probe labels and per-rubric quality sample counts. The companion paths are repository-relative references to retained evidence, not links to raw artifacts bundled here. No credentials, raw chat transcripts or machine-home paths are included.
