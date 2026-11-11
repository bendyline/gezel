# Saluki native 0.1.57 scorecard

This download records 128 attempts from 129 planned entries on a Windows laptop with a 12 GB RTX 5070 Ti. It preserves three separately journaled segments and the original versus continuation environment boundary. There are 126 terminal verdicts, two administratively excluded unscored interruptions, and one unattempted entry.

[Scorecard](scorecard.json), [all trial evidence](scorecard-details.json), [report](report.md), [trial table](trial-scorecard.md), [Sonnet reviews](judging-sonnet-5-5.json), [original Codex reviews](judging-codex.json), [offload audit](offload-frequency.json), and [verification](verification.json) are included. No raw prompts, transcripts, credentials or model weights are published. Archive paths in structured evidence are references, not public URLs.

CPU offload occurred in 128/128 attempts: 39/64 dense FFN layers on GPU and 25 on CPU. The 126 completed trials had a median decode rate of 8.35 tokens/s (range 2.57–9.41). This is generation speed during decoding, not end-to-end output divided by task wall time. Context was 65,536 tokens with one slot and f16 KV. Shared GPU memory and paging were not measured.

The source-only Sonnet 5.5 pass uses exact declared rubrics, integer scores, and a 20 KiB cap per artifact. Missing artifacts and results without applicable axes have no invented numeric scores. Fixed capability scores remain unchanged; qualitative reviews are advisory. Separate rubrics and judges are never averaged into one quality score.

Regenerate with `node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-saluki-native-057-scorecard.mjs`, then `node scripts/gen-scorecard-barrel.mjs`. Add `--check` to the importer to verify byte-for-byte reproducibility. Publication refuses incomplete Sonnet coverage. `--prepare` writes a draft under the local campaign archive only.
