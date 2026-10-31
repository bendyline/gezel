# Final coverage audit

**Complete: 258/258 unique planned cells, three repetitions for all 86 model/suite/scenario groups.** The three immutable journals contain 169 + 83 + 6 records. There were no retries or samples from the cancelled campaign. The final launcher exited 0 at 09:25 PDT, October 30; the 10:07 PDT process snapshot found no campaign or native processes.

## Review coverage

| Segment | Attempts | Artifact judgments | Cells judged | Missing artifact | No declared axes |
|---|---:|---:|---:|---:|---:|
| original | 169 | 79 | 76 | 0 | 93 |
| continuation | 83 | 40 | 36 | 2 | 45 |
| final-six | 6 | 0 | 0 | 0 | 6 |

125 produced declared artifact paths map to 119 distinct contents and 119 judgments across 112 cells. Six identical copies share their content judgment. Two declared outputs are missing (Qwen week-plan r3 and Gemma refactor-module r3); they are noArtifact, not zero-valued judgments. The remaining 144 cells have no declared axes. All six final cells received diagnostic review without invented qualitative scores.

The independent audit checked each declared axis name, integer 0–10 scores, arithmetic mean, bounded review size (at most 20 KiB), artifact hash, provider/model metadata, and specific justification. Nine artifact judgments across six primary A/B cells have a documented HTML-rubric/Markdown-output mismatch; raw scores remain visible and applicable means exclude only those primary cells.

## Performance evidence across all attempts

| Metric | Available / 258 |
|---|---:|
| durationSeconds | 258/258 |
| firstActionSeconds | 257/258 |
| firstArtifactSeconds | 240/258 |
| toolCalls | 258/258 |
| engineInputTokens | 257/258 |
| engineOutputTokens | 257/258 |
| decodeTokensPerSec | 257/258 |
| prefillTokensPerSec | 257/258 |
| peakRssMb | 258/258 |
| peakGpuMemMb | 258/258 |
| peakGpuUtilPercent | 258/258 |
| peakSystemRamMb | 258/258 |

The final Gemma fanout attempt never started inference. Its raw HTTP counters are 0/0 in an unrelated anthropic-cli bucket; engine-derived local-model tokens are unavailable. The final analytical JSON/CSV correct this availability interpretation without changing raw metrics. Its memory/utilization samples describe the waiting daemon and ambient device, not loaded Gemma. First-artifact timings are 240/258; one Qwen large-PR write timing is documented separately in the continuation performance-supplement.json and does not overwrite the raw null.

## Identity and raw evidence

All 358 frozen source/build/catalog/native manifest files and six profile fingerprints matched at final verification. Both prior journal hashes are unchanged. The two no-OS-sandbox segments have byte-identical hooks and equal source/runtime/catalog/models/environment; campaign-local profile metadata differs. All expected per-trial result, score, facts, metrics, host and postmortem files exist, and every weighted fixed composite was recomputed successfully. Raw classifications and scores remain untouched: 256 raw-eligible records and two exclusions, plus one additional diagnostic admission issue.

[Independent machine-readable audit](scorecard-details.json) · [Frozen-identity checkpoint](scorecard-details.json) · [Process snapshot](scorecard-details.json) · [Overall report](report.md)


Publication note: individual evidence and postmortem links open the bundled scorecard-details.json, which preserves the original archive references. The raw analytical scorecard keeps the final Gemma admission attempt eligible; product tables apply the documented infrastructure attribution correction.
