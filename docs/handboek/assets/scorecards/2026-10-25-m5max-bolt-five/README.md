# October 25–26, 2026 M5 Max five-model core scorecard

All **165 trials** are complete: 110 raw passes and 55 task failures. Each
of five models attempted all 11 core scenarios three times. All trials were
reviewed, including failures: 158 artifacts have scores and seven missing
outputs have explicit null scores. No inference or judging was repeated for
publication, and no raw verdict or classification was changed.

## Downloads

- [scorecard.json](scorecard.json): the standard `ScorecardDatasetSchema` v1
  dataset used by the site's tables, including task performance and four
  separate artifact-review rubrics. `runs/` contains the same data as a single
  round file; use one representation, not both.
- [scorecard-details.json](scorecard-details.json): the full report JSON,
  all 165 trial records, original judging axes and rationales, reviewed byte
  ranges and artifact hashes, fixed-score breakdowns, per-trial and aggregate
  performance, model identities, narrative report, 32 diagnostic findings
  and their limitations. Six excluded historical judgments are retained in
  a separate field and do not enter the comparison.
- [verification.json](verification.json): reconciled counts and validation.
  [manifest.json](manifest.json): generated file sizes, SHA-256 hashes and
  reproducible import/check commands.

## Interpretation

Bolt and Gemma E4B each passed 26/33; Gemma E2B passed 14/33, Gemma 12B
23/33 and Qwen 9B 21/33. These are automatic gate outcomes. Artifact review
found incomplete websites and broken game behavior among passes, as well as
false-negative gates and framework recovery defects. The frozen results
remain intact. The findings establish current defects, not when recent
updates introduced them. A corrected comparison needs a separate round.

Judging was unblinded, advisory and performed by `codex-inline/current-session`;
the exact reviewer model version was not recorded. The frozen 20 KiB review
limit and individual clipping/omission notes are retained. HTML, code, data
and document rubrics are never combined into one quality score. Missing
outputs remain in pass denominators but outside artifact means. This makes
quality conditional on producing an artifact, and the counts matter.

## Performance

This compares installed integrations on one Apple M5 Max with 128 GiB RAM:
Bolt on llama.cpp Metal, the Gemma and Qwen models on MLX. Exact installed
quantizations and manifest identities are in `modelMetadata`; they are not
assumed identical because the catalog IDs all end in Q4.

The site's task tables show medians, ranges and sample counts across all
attempted tasks. Bolt's decode and prefill are request-derived; MLX decode
is an **active-stream estimate**, and MLX prefill is unavailable. No admission
probe numbers or total-token-throughput fallbacks were substituted. The full
JSON also includes successful-task times, first-token/tool/write timing,
tool counts and separate engine-generation and tracker-token streams with
their incomplete coverage.

Wall time includes failures and recovery. First-artifact timing is an
attributed-write proxy, not completion latency; four trials saved images
before that metric recorded a write. Peak process RSS is not GPU telemetry.
GPU memory/utilization were unavailable. Installed context limits are
recorded as model metadata, not as measured session allocations.

## Provenance and availability

Only the frozen `isolated` cohort belongs to this round. Five old-build
tic-tac-toe trials, one interrupted/background-contaminated Bolt trial and
other admission/routing diagnostics remain outside the 165-trial denominator.

Bolt used NVIDIA revision `1db54d5b12533ff1bcaa8e42cf4c667988a1f1be`,
the October 23 update verified on October 25. Its full GGUF SHA-256 is
`c8af2b8aea10a690a1d9491db744a9446660173cb38fc489612b556615a69612`.
The local Gilde model release and eval cache were updated; catalog publication
and the normal application model store were separate from that work.

Evidence references are repository-relative paths in the retained evaluation
archive, not public artifact URLs. Markdown links inside the JSON's narrative
fields refer to that archive. This download excludes raw transcripts,
generated artifacts, credentials and workstation home paths/hostname. The
importer validates the captured source hashes and reviewed artifact hashes
before exporting, and `--check` verifies byte-for-byte publication stability.

The new run is registered in the core scorecard barrel and linked from the
Handboek. It is ready for the ordinary repository/site deployment process;
generating these source files does not itself deploy the website.
