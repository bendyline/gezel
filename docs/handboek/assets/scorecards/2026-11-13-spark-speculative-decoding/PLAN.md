# Does speculative decoding change quality? (llama.cpp v0.9.0)

Written 2026-11-13, before any trial ran. Owner's question: do DFlash2 or MTP
change result quality, compared with plain one-token-at-a-time decoding?

## Setup

- DGX Spark (GB10, 121 GB unified), linux-arm64 CUDA, native 0.1.62 = llama.cpp
  v0.9.0 b12110 (cd959bae). gezel 9e5fd58f, dist built 2026-11-13 07:04-07:06,
  gilde 0.3.10 (qwen3.8-27b-q4 1.0.7 with the DFlash2 drafter; content floor 1.26317).
- Driver: `run.sh main`. Trials land in `evals/runs/scorecard-spec-ab-2026-11-13-r{1,2,3}/<arm>/<suite>/`.
  Not ingested into the scorecard dataset.

| Arm | Model | Speculation | How it is set |
| --- | --- | --- | --- |
| `qwen3.8-27b-q4.none` | Qwen 3.8 27B Q4 | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` |
| `qwen3.8-27b-q4.mtp` | Qwen 3.8 27B Q4 | MTP, built-in head, n=4 | `GEZEL_EVAL_LLAMA_SPEC_TYPE=draft-mtp` |
| `qwen3.8-27b-q4.dflash` | Qwen 3.8 27B Q4 | DFlash2 drafter, n=4 | catalog default on CUDA |
| `gemma4-12b-q4.none` | Gemma 4 12B Q4 | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` |
| `gemma4-12b-q4.mtp` | Gemma 4 12B Q4 | MTP assistant sidecar, n=4 | catalog default |

Gemma 4 12B has no DFlash drafter in the catalog, so it has two arms.

Suites: core (11), productivity (13), developer (10), complex-work (9) = 43
scenarios. Three rounds; each round runs every suite once per arm (count 1),
with the arm order rotated per suite and round, so a stopped sweep still
leaves balanced arms. 645 trials in total.

## What to expect, and what would break it

llama.cpp verifies a draft by sampling the target model at each drafted
position and keeping drafted tokens only while they equal that sample. The
target's output distribution is therefore unchanged in principle. Differences
can still come from:

1. Batched verification changing floating-point reduction order, which flips
   near-tie tokens. That changes individual outputs, not expected quality.
2. Bugs: KV/recurrent-state rollback after a rejected draft (Qwen 3.8 is hybrid,
   Gemma 4 uses sliding-window attention), draft state saved and restored with
   slots, or the drafter's memory narrowing the context window.
3. Wall-clock effects: the `none` arms decode slower, so any time-based
   watchdog fires more often there. Progress-based terminations are the
   capability signal; a wall-clock termination is a harness artifact.

## Validity check (every trial)

The trial's `daemon.log` must show the arm's speculation: no
`common_speculative_init` and no `draft acceptance` lines for `none`, an MTP
draft context for `mtp`, the DFlash2 drafter for `dflash`. A trial that ran
the wrong mode is excluded and counted in the report.

## Endpoints

Primary, per model, each speculation arm against that model's `none` arm:

1. **Pass rate** (each scenario's own gate). Paired by scenario: the per-scenario
   mean over 3 trials, difference averaged over scenarios, 95% CI from a
   bootstrap over scenarios. Resolution at this n is roughly +/-9 points, so
   "no effect" here means "no effect larger than about 10 points".
2. **Judge mean**, Claude Sonnet 5.5 (`claude-sonnet-5-5` via the Claude CLI) on
   the scenarios with a judge rubric (21 of 43: the anchored games and the
   craftbook scenarios), same pairing and CI. Practical margin +/-0.5.

Secondary: failure modes by arm (progress-based vs wall-clock), trial wall time,
output tokens, decode tokens/s, draft acceptance rate and mean accepted length,
and a scenario-by-scenario table that flags any scenario whose pass count moves
by 2 or more of 3 between arms.

## Verification before round 1 (2026-11-13 07:34-08:07)

- Every trial daemon refused to start until `pnpm deps:install` synced
  `@bendyline/docblocks-cli` 2.7.13 -> 2.7.16 (pin bumped in 6a678408; the
  daemon checks the installed version). Synced at 07:34 after the owner's
  `pnpm all` released the dependency lease. That `pnpm all` also rebuilt
  `packages/core/dist` at 07:30; every verify and main cell uses that build.
- The first Qwen warm topped up the eval cache with the DFlash2 drafter and
  `mmproj-F16.gguf` (the vision encoder, absent from the October cache). One
  attempt failed on a Wi-Fi drop; the next completed at 07:57. All three Qwen
  arms now run with the vision encoder loaded, unlike the October sweep.
- One tictactoe trial per arm, read back from llama-server's own lines:
  qwen none "runs none (Settings)", no draft context; qwen mtp "runs draft-mtp
  (Settings)", MTP draft context on the built-in head; qwen dflash "runs
  draft-dflash (catalog)", loads Qwen3.8-27B-DFlash2-Q4_K_M.gguf; gemma none,
  no speculation lines; gemma mtp loads mtp-gemma-4-12B-it-Q4_0.gguf. All five
  passed. Decode: gemma 29.4 t/s none vs 92.5 mtp; qwen 10.9 none vs 36.2 mtp vs
  43.0 dflash. Speculation triples decode on both models here, so the `none`
  arms will take roughly twice the wall-clock of the others (whole trials
  include prefill): estimate about 60 h per round, 7-8 days in all.
- Judge path checked: `eval:judge-sweep` with `GEZEL_JUDGE_MODEL=claude-sonnet-5-5`
  judged all five through the Claude CLI and recorded the model per trial.

## Amendment 1 (2026-11-13, during round 1's first cell, before any main-run result was read)

Owner asked to add Muse Glimmer 30B Q4, the only other catalog model with a
true DFlash2 drafter (same conv/selector design as Qwen's; Gemma 4 12B's only
drafters are first-generation DFlash community GGUFs, and the Nemotron Bolt
drafters are DFlash v1 or the LiLiCorr variant). It has no MTP head, so two arms:

| Arm | Speculation | How it is set |
| --- | --- | --- |
| `muse-glimmer-30b-q4.none` | none | `GEZEL_EVAL_LLAMA_SPEC_TYPE=none` |
| `muse-glimmer-30b-q4.dflash` | DFlash2 drafter, n=4 | catalog default on CUDA |

Cached weights and vision encoder match catalog 1.0.4; the harness tops up the
1.65 GB drafter. The driver was paused at a cell boundary and restarted as
`run2.sh` (same cells, plus these two arms in every round and suite; complete
cells skipped; preflight/setup failures retried up to 4 times). New primary
comparison: Muse DFlash2 vs Muse none, same endpoints. Muse's September x3
scorecard without speculation took 60 h, so the run grows by about 4 days.
