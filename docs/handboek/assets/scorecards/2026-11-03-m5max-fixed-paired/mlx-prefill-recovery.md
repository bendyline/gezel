# MLX prefill recovery and telemetry repair

Recovered 126 observed prefill rates from all 37 recorded MLX trials without running inference. Of those, 121 observations belong to the 36 matched, included MLX trials. The remaining five belong to the identity-flagged, unpaired PowerPoint trial and do not enter comparison aggregates.

| Model | Included MLX trials | Observations | Median of per-trial median prefill rates, tok/s |
|---|---:|---:|---:|
| Qwen3.8 27B Q4 | 18 | 55 | 604.75 |
| Gemma4 12B Q4 | 18 | 66 | 1332.25 |

These are rounded first-token diagnostic rates, not exact prefill durations or a duration-weighted aggregate of every request. Internal tool-loop requests and cancelled turns may be absent. Time to first token includes work beyond prompt processing, so it cannot safely substitute for pure prefill time. No duration was invented. The scorecard keeps recovered MLX observations in a separate column from llama.cpp's aggregate request timings; these figures alone do not establish that either engine prefills faster.

## Evidence and method

The immutable trial recordings contain `engine_phase` events such as `First token in 19.5s · prefill 819 tok/s`. Only MLX generating-phase diagnostics with this exact provider format were read; generated model text was never interpreted as telemetry. Every retained observation includes its recording line, receive time, session ID and rate in [mlx-prefill-recovery.json](mlx-prefill-recovery.json). Recording and original metrics SHA-256 hashes are included per trial. There were no malformed lines or exact duplicate observations in this recovery.

Within each trial the estimate is the median of observed rates, and the comparison table takes the median across included trial estimates. No trial receives extra aggregate weight because it ran more turns. The parser removes only exact duplicate recorded events. Reconnect replay without stable event IDs cannot be distinguished from a new event, and full request coverage is not asserted.

The [recovery script](scorecard-details.json) uses the same [parser as future eval collection](scorecard-details.json). The [report generator](scorecard-details.json) verifies source hashes and reads the separate recovery file. Original `campaign.json`, per-trial `metrics.json`, event recordings, gates, scores, judgments and exclusions remain unchanged. The October 27 campaign was not modified. Earlier derived reports are retained in [report-revisions/pre-mlx-prefill](scorecard-details.json).

## Why ordinary collection lost the data

1. The MLX provider already populated internal `TurnStatsEvent.promptTokensPerSec`, `cachedPromptTokens` and `ttftMs`.
2. Normal chat and one-shot forwarding selected a smaller field set, dropping all three. The public chat schema also omitted them.
3. The remote inference sender, wire schema and receiving session omitted the same fields.
4. The eval collector only parsed daemon logs. MLX's legacy log parser has prompt counts but no prefill duration, so it correctly could not produce an aggregate prefill rate. It never consulted the available event recording.

The source fix forwards all three optional fields through chat and remote inference. The runner now flushes its recorder before collecting metrics, and the collector reads structured `turn_stats` rates into `metrics.mlxPrefill`. It retains source, sample counts and observations, prefers structured terminal samples over historical rounded descriptions, and never mixes the two request boundaries. The existing aggregate `derived.promptTokensPerSec` remains unknown when total timing is unavailable. Normal scorecard reports, CSV exports and per-trial postmortems expose the observed MLX measurements separately.

This repairs telemetry transport and reporting. It does not change model permissions, inference behavior, token accounting, pass/fail classifications or judgments. It applies to subsequent runs using the rebuilt source; it was not retroactively installed into the frozen completed evaluation.

## Updated outputs

- [Final scorecard](report.md) and [JSON](analysis.json)
- [Performance CSV](performance.csv) and [audit JSON](performance.json)
- [Recovery observations and provenance](mlx-prefill-recovery.json)
- [Paired conclusions](paired-analysis.md) and [judgments](judging.md), unchanged in substance

The condensed comparison remains inconclusive for the user-selected ±5 percentage point equivalence margin. Recovering throughput does not alter the 16/18 versus 18/18 pass counts for either model.


Publication note: portable copy of the completed, user-curtailed report. Archive-only links open scorecard-details.json, which embeds trial facts, postmortems and review specifications. Publication-status statements describe the original closeout.
