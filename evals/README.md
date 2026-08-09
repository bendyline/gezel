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
pnpm eval:run tictactoe --model gemma4-e4b-q4 --timeout 20m

# Image-gen scenario; provider-specific chat default + SDXL Lightning. Override either:
pnpm eval:run petshop --image-model sdxl-lightning-4step --timeout 25m

# Slow model on a single scenario: scale the authored ceiling by measured decode rate.
pnpm eval:run conflict-synthesis --model qwen3.6-27b-q8 --decode-rate 4.8
```

Scenario `timeoutMs` values are hand-authored against a ~20 tok/s reference
machine, so a slower model can hit the wall while still making forward
progress — the capability verdict inverts with hardware. Batch and matrix
runs scale each ceiling automatically from the preflight probe's measured
throughput; a single `eval:run` has no probe, so pass `--decode-rate` when
the model is well under the reference. An explicit `--timeout` is absolute
and is never scaled.

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
`extended-coding` / `extended-grounding` / `extended-retrieval` /
`extended-writing` are per-axis deep dives; `productivity` is the
office/knowledge-work scorecard (with `productivity-smoke` as its pulse
check); `headroom` holds the deliberately hard probes:

```bash
pnpm eval:all --suite core --count 3 --model gemma4-e4b-q4
```

**`productivity`** grades the artifacts a non-technical user would
recognize — communications, meeting follow-through, planning, a research
brief, an A/B readout, a spreadsheet model, a PowerPoint deck, a Word
document. It is fully hermetic: its Wikipedia, calendar, and DocBlocks
dependencies are deterministic local mocks, `webSearch` is pinned to a
mock backend, and the research scenario *asserts* that no live-retrieval
tool was called rather than trusting configuration.

Three kinds of gate carry the suite, and they are worth knowing apart:

- **Prose/structure gates** — ordered sections, word bands, required
  content. These mostly measure brief-compliance.
- **Arithmetic oracles** — `craftbook-ab-test-readout` and
  `craftbook-spreadsheet-model` write a locked-schema JSON of computed
  figures which is checked field-by-field against values derived from the
  seeded data. A structurally perfect readout with a wrong p-value fails.
- **Binary container gates** — the three DocBlocks members produce a real
  PPTX or DOCX through `convert_document` → `preview_document` →
  `save_artifact`, and the gate verifies the ZIP signature. Writing the
  Markdown source to the `.pptx` path no longer passes.

Two things to know before starting it. Worst case is **6h05m at
`--count 1`**, so a `--count 3` scorecard is a ~18h job — and below n=3
the harness refuses to quote a pass *rate* at all (it prints a raw count),
so `--count 1` is a spot check, not a score. And most members carry an
advisory judge, so `--llm-judge` is where the qualitative signal lives.

```bash
# Full scorecard. Budget the wall-clock first.
pnpm eval:all --suite productivity --count 3 --model gemma4-e4b-q4 --llm-judge

# ~1h15m pulse check instead — one of each gate kind (prose, arithmetic
# oracle, real DOCX through DocBlocks).
pnpm eval:all --suite productivity-smoke --count 1 --model gemma4-e4b-q4 --llm-judge

# Or a named subset of any suite — runs in suite order, and an id that
# isn't a member of that suite is an error rather than a silent no-op.
pnpm eval:all --suite productivity --scenarios meeting-followup,wikipedia-research-brief \
  --count 3 --model gemma4-e4b-q4 --llm-judge
```

## The published scorecard

`core` and `productivity` results ship inside the product: the handboek's
**How we test models** and **Model scorecard** articles render them for end
users. Use `eval:scorecard` rather than two `eval:all` invocations — it
stamps every model in one sweep with the same device, git sha, catalog pin,
and trial count, so the resulting table is comparable by construction.

```bash
# Plan first: which models are cached, and what the wall-clock ceiling is.
pnpm eval:scorecard --list

# The sweep. Both suites, every cached model, 3 trials (the floor for
# quoting a rate at all).
pnpm eval:scorecard --count 3

# A new model arrives later — join it to the SAME round so it lands in the
# same table rather than starting a fresh, incomparable one.
pnpm eval:scorecard --count 3 --run-id 2026-08-09-mac-apple-m4-max --models qwen3.6-27b-q4

# Rebuild the dataset from runs already on disk, without re-running anything.
pnpm eval:scorecard --ingest-only --run-id 2026-08-09-mac-apple-m4-max
```

It writes [packages/core/src/scorecard/data/scorecard.json](../packages/core/src/scorecard/data/scorecard.json).
That checked-in file is the published record; the articles carry no numbers
of their own, so a re-run updates what ships with no article edits.

The ceiling `--list` prints is the sum of authored timeouts, not an
estimate — healthy models finish far inside them. For a full model set it is
normal to accumulate the sweep across several sittings under one `--run-id`.

Only `failureClass: 'model'` trials count toward a score. Infra, operator,
and grader failures show in a separate "not measured" column and are removed
from both sides of the ratio. See [docs/eval-strategy.md](../docs/eval-strategy.md)
for the full comparability rules and the judge-drift policy.

`--count <N>` is required for every `eval:all` run (except `--list`); there is no implicit
trial-count default. For "every registered scenario × N trials", omit `--suite` deliberately:

```bash
pnpm eval:all --count 5
# Optional: filter to an ad-hoc subset of the whole registry
pnpm eval:all --count 3 --scenarios tictactoe,petshop
# List scenarios and suites (suite descriptions carry their wall-clock budget)
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
  "modelId": "gemma4-e4b-q4",
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
- **For llama.cpp trials only** — one-time `gemma4-e4b-q4` download (~8 GB).
  The first trial primes
  `~/.gezel-eval-cache/engines/llama-cpp/models/gemma4-e4b-q4/`; subsequent
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
