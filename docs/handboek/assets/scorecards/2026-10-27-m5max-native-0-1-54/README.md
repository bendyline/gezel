# M5 Max · MLX and llama.cpp · native 0.1.54

Completed October 27–November 2, 2026: Qwen 3.8 27B Q4 and Gemma 4 12B Q4
on both engines, four suites and three repetitions of every treatment.
All 516 attempts are preserved: 349 passes, 165 model-classified failures
and two infrastructure exclusions. No inference or new judging was needed
to publish this report.

| Download | Contents |
| --- | --- |
| [Report](report.md) | Final model/engine/suite comparison, fixed scores, quality, timing, throughput and memory |
| [Failure evidence](failure-evidence.md) | Concrete diagnoses and the complete failed-trial inventory |
| [Judgments](judging.md) | Human-readable advisory reviews |
| [Judge data](judging.json) | Every trial's review disposition, exact reviewed prompts and axes, scores, reasons and source hashes |
| [Performance](performance.json) | Per-trial timings, actual engine rates, tokens, sampled process RSS, system RAM and availability flags |
| [Aggregate analysis](analysis.json) | Model/engine/suite/treatment aggregates, coverage and matched-success comparisons |
| [Scorecard](scorecard.json) | Dataset used by Gezel and the website tables |
| [Complete companion](scorecard-details.json) | All trial results, fixed scores, facts, metrics, host records, postmortems, review specifications and diagnosis replays |
| [Trials CSV](trials.csv) | Original tabular trial export with portable paths |
| [Runner report](runner-report.md) | Original deterministic runner report |
| [Supervision notes](supervision-notes.md) | Recovery and observation history |
| [Native provenance](native-provenance.json) | Engine versions and original native binary checksums |
| [Completion audit](completion-audit.json) | Frozen completion checkpoint and per-trial evidence hashes |
| [Publication verification](verification.json) | Reconciled counts and publication invariants |
| [Manifest](manifest.json) | Public file hashes and regeneration/check commands |

There are 172 treatments with repetitions 1, 2 and 3 each. The 43 suite entries
represent 41 unique scenarios because two scenarios intentionally occur in both
core and productivity. Engine configurations retain their different quantization
and speculative decoding settings; they are not interchangeable baselines.

The 215 numeric source reviews include 80 failed trials. Twelve incompatible A/B
specifications, one missing artifact and 288 non-judgeable trials have no numeric
quality score. Scores are advisory, independent of fixed scores and performance;
compare like rubrics. Source reviews use at most 20 KiB of each artifact and do
not claim complete visual or interactive inspection.

Performance covers all attempts, including failures and exclusions. MLX prefill
and granted context are unknown. macOS GPU telemetry is unavailable: raw zero
counters accompanied by `available: false` are not measurements. Decode rates
use different engine estimators, explained in the report. First-artifact latency
means first write; system memory includes other processes. All unknown values
and sample coverage are retained.

Workstation names, home paths and temporary paths are removed from public copies.
Repository-relative archive references inside JSON are evidence identifiers, not
public download URLs. Individual evidence links in reports open the companion,
which embeds all 516 postmortems. Raw transcripts, logs, generated artifacts and
model binaries remain in the local archive. Hashes of original evidence refer
to the unsanitized source; the manifest hashes the public copies. Completion
records describe the checkpoint before publication and remain unchanged.

Regenerate or verify using the commands in [manifest.json](manifest.json), then
run `node scripts/run-with-dependency-lease.mjs --direct-node scripts/gen-scorecard-barrel.mjs`
to refresh Gezel's dataset registry and combined CSV. The source archive is
required for regeneration; published files and their manifest stand alone.
