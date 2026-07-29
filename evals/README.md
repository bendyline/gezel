# gezel-evals — long-run eval suite

End-to-end evaluation harness for gezel. Each scenario spawns a fresh `gezeld` against an
isolated temp `GEZEL_HOME`, drives the Meester via `GezelClient`, polls for completion,
and writes a comprehensive per-trial log + final state snapshot to `evals/runs/`.

The whole harness is a thin orchestrator over the public service HTTP API — no production
code in `packages/service` or `packages/cli` is touched.

For the operational preflight, monitoring, scoring, and postmortem workflow, use the
[eval-run skill](../.agents/skills/eval-run/SKILL.md). Strategy and suite-design rules live
in [docs/eval-strategy.md](../docs/eval-strategy.md).

## Available scenarios

Run `pnpm eval:all --list` for the complete live registry. The standardized `core` scorecard
pins these 11 scenarios in run order:

- Frozen anchors: **`tictactoe`** (single-file interactive JS), **`petshop`** (multi-role + image-tool orchestration; defaults to `sdxl-lightning-4step`), and **`tankcombat`** (interactive game-loop execution).
- Coding/data axes: **`schema-migration`** (multi-file refactor), **`failing-tests-spec`** (tests as specification), **`symptom-debug`** (undocumented semantic bug), and **`data-wrangle`** (precision ETL).
- Grounded execution axes: **`incident-postmortem`** (dense read → cited structured write), **`ops-runbook-anomaly`** (procedure execution + stop on anomaly), **`plan-and-estimate`** (checkable planning), and **`conflict-synthesis`** (explicit multi-source reconciliation).

## Run a single trial

```bash
pnpm eval:run tictactoe
# or with options
pnpm eval:run tictactoe --model gemma4-e4b-q8 --timeout 20m

# Image-gen scenario; provider-specific chat default + SDXL Lightning. Override either:
pnpm eval:run petshop --image-model sdxl-lightning-4step --timeout 25m
```

Per-trial output lands at `evals/runs/<trialId>/`:

```
evals/runs/tictactoe-2026-05-04T22-13-09-abc1/
├── log.txt          human-readable timeline (chat turns, tool calls, status changes)
├── history.jsonl    full audit-log copy (all gezel/project/task/tool events)
├── daemon.log      chronological daemon stdout + stderr
├── result.json      { success, scenario, durationMs, reason, model }
├── sessions/        full ChatSession JSON dump for every gezel involved
└── artifacts/       snapshot of every project's artifacts/ directory
```

## Run a batch (one scenario × N trials)

```bash
pnpm eval:batch tictactoe --count 5
```

Writes a top-level `evals/runs/batch-<isoTs>/summary.json` plus per-trial dirs.

## Run a matrix (multiple scenarios × N trials)

`pnpm eval:batch` also accepts multiple positional scenarios — two or
more positionals trigger matrix mode:

```bash
pnpm eval:batch tictactoe petshop --count 5
```

For a standardized set, run a named suite from
[src/suites.ts](src/suites.ts) — `core` is the 11-scenario model
scorecard (3 frozen anchors + 8 diverse capability axes) and the default
answer to "evaluate this model"; `smoke` is a fast pulse check;
`extended-coding` / `extended-grounding` / `extended-retrieval` are
per-axis deep dives; `headroom` holds the deliberately hard probes:

```bash
pnpm eval:all --suite core --count 3 --model gemma4-e4b-q8
```

`--count <N>` is required for every `eval:all` run (except `--list`); there is no implicit
trial-count default. For "every registered scenario × N trials", omit `--suite` deliberately:

```bash
pnpm eval:all --count 5
# Optional: filter to an ad-hoc subset (mutually exclusive with --suite)
pnpm eval:all --count 3 --scenarios tictactoe,petshop
# List scenarios and suites
pnpm eval:all --list
```

Both write a top-level `evals/runs/matrix-<isoTs>/`:

```
evals/runs/matrix-<ts>/
├── summary.json                 ← MatrixSummary (overall + per scenario)
├── tictactoe/
│   ├── summary.json             ← BatchSummary
│   └── tictactoe-<ts>-aaaa/     ← per-trial dir (log.txt, history.jsonl, …)
└── petshop/
    ├── summary.json
    └── petshop-<ts>-cccc/
```

Scenarios run sequentially even when `--parallel K > 1` is set —
`--parallel` applies *within* a single scenario's batch. Two large
models on the same box cross-saturate VRAM and the per-scenario
success rate would lie.

### Local-device exclusivity

Real eval CLIs reserve one user-scoped device lock before starting a local chat
or image engine. The default is `~/.gezel-eval-device.lock/owner.json`, outside
the cache and runs trees, so changing `--cache-root` or `--runs-dir` cannot
accidentally permit a second GPU workload. The owner record includes the PID,
start time, host, and command. A competing command fails immediately and prints
those details rather than waiting invisibly behind a multi-hour run.

The next command atomically recovers a stale lock only after the recorded PID is
proven dead. Recovery leaves a tiny owner-specific `.stale-*` tombstone beside
the lock; retaining it closes the delayed-two-reclaimer race and one is created
only after an abnormal exit. Normal completion and process exit remove the live
lock; SIGKILL or a machine crash is handled by stale-owner recovery. A
cloud-only text eval does not take the lock. A cloud chat eval that uses local
image generation does.

`GEZEL_EVAL_LOCK_PATH=/path/to/lock` overrides the coordination path for an
unusual shared-device setup. `GEZEL_EVAL_ALLOW_CONCURRENT=1` is the explicit
escape hatch, but is unsafe: concurrent native engines can invalidate timings,
exhaust shared VRAM, or interfere with lifecycle cleanup. Do not use it for
scorecard runs.

The aggregate `summary.json` carries one entry per scenario plus a
cross-scenario success rate, suitable for diff-against-yesterday
analysis:

```json
{
  "modelId": "gemma4-e4b-q8",
  "status": "complete",
  "count": 5,
  "requestedScenarios": [
    { "scenarioId": "tictactoe", "trials": 5 },
    { "scenarioId": "petshop", "trials": 5 }
  ],
  "scenarios": [
    { "scenarioId": "tictactoe", "trials": 5, "successes": 4, "successRate": 0.8, "summaryPath": "tictactoe/summary.json" },
    { "scenarioId": "petshop",   "trials": 5, "successes": 3, "successRate": 0.6, "summaryPath": "petshop/summary.json"   }
  ],
  "totalTrials": 10,
  "totalSuccesses": 7,
  "overallSuccessRate": 0.7
}
```

## Add a scenario

1. Create `evals/src/scenarios/<name>.ts` exporting an `EvalScenario`.
2. Register it in `evals/src/scenarios/index.ts`.

The scenario provides a `prompt` (sent to the Meester), a `successCheck` that the runner
polls every 5s, and a `timeoutMs`.

## Driving non-local providers

The harness ran against `llama-cpp` and `mlx` only for a long time. It now
accepts every chat provider gezel itself supports via `--provider <name>`
(the legacy `--engine` spelling still works as an alias):

```bash
pnpm eval:run tictactoe --provider codex-cli --model gpt-5.5
pnpm eval:run tictactoe --provider copilot   --model claude-sonnet-4.6
pnpm eval:run tictactoe --provider anthropic --model claude-sonnet-4-6
pnpm eval:run tictactoe --provider openai    --model gpt-5
pnpm eval:run tictactoe --provider anthropic-cli --model claude-sonnet-4.6
```

Providers fall into three categories ([providers.ts](src/providers.ts)),
each with its own trial-runner contract:

| Category | Providers | Warm cache? | Process / GPU perf? | Auth source |
|---|---|---|---|---|
| `local-engine` | `llama-cpp`, `mlx` | Yes (model weights on disk) | Yes (model runs inside the daemon) | None |
| `cli-wrapper` | `codex-cli`, `anthropic-cli` | No (model is remote) | No (per-turn subprocess, nothing meaningful to sample) | `~/.codex/auth.json` or `CODEX_API_KEY` / `OPENAI_API_KEY`; `~/.claude/.credentials.json` or `ANTHROPIC_API_KEY` |
| `cloud-sdk` | `copilot`, `anthropic`, `openai` | No | No | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `gh` login state (`GH_TOKEN` / `GITHUB_TOKEN`) |

The runner does a cheap pre-flight auth probe before warming anything,
so missing credentials fail in seconds with a clear message — not
fifteen minutes into a trial.

The image side is decoupled: any chat provider can drive scenarios
like `petshop` / `tool-routing-image`, since image generation goes through
the local `sd-cpp` sidecar regardless of which chat provider is
active. SDXL warm-cache still applies for image-using scenarios.

The postmortem's "Performance" section reports `n/a` for `peakRssMb`
and `peakGpuUtilPercent` on `cli-wrapper` and `cloud-sdk` providers —
those values would only reflect the daemon's idle footprint, not any
real model work.

## Prerequisites

- A built workspace: `pnpm install && pnpm build`.
- **For llama.cpp trials only** — a `gezel-llama-server` binary (legacy
  `llama-server` also resolves) at `native/build/<platform>-<backend>/` or
  `packages/app/native-bin/<platform>-<backend>/` (CUDA preferred, then Vulkan,
  Metal, and CPU). The harness also checks an installed `Gezel.app` on macOS.
- **For llama.cpp trials only** — one-time `gemma4-e4b-q8` download (~8 GB).
  The first trial primes
  `~/.gezel-eval-cache/engines/llama-cpp/models/gemma4-e4b-q8/`; subsequent
  trials reuse it via filesystem links.
- **For Apple Silicon MLX trials** — the platform-aware default provider is
  MLX, and its complete `qwen3.5-4b-q4` source must already exist under
  `~/.gezel-dev/engines/mlx/models/qwen3.5-4b-q4/`; the eval runner links it
  into each trial.
- **For `petshop` / image-tool trials** — `sdxl-lightning-4step` may live in
  either `~/.gezel-dev/engines/sd-cpp/models/sdxl-lightning-4step/` or
  `~/.gezel-eval-cache/engines/sd-cpp/models/sdxl-lightning-4step/`. A first
  warm is about 7 GB.
- **Playwright Chromium** for the post-sniff runtime layer:
  `npx --prefix evals playwright install chromium` (one-time, ~100 MB).
  Without it, game-scenario trials fall back to sniff-only verification — the trial
  logs `BOOTSTRAP_FAIL` and the trial may be promoted despite the page being broken
  on actual interaction. Verify with `ls ~/.cache/ms-playwright/chromium_headless_shell-*/`.
- **For local-engine trials, GPU perf data** on Linux/Windows: `nvidia-smi`
  must be on `PATH`. Without it the `perf.gpu.available` field on every trial
  reads `false` and tokens/sec / VRAM peaks are blank in the postmortem (the
  trial still runs fine).
- **For cloud / CLI providers** — the matching credentials (see the
  table above). The pre-flight probe will tell you exactly which env var
  or login command is missing.
