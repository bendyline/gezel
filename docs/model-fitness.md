# Model fitness — the *proeve van bekwaamheid*

Gezel runs whichever local model you point it at. But "installed and loads" is
not the same as "can do agentic work on this hardware": a model can over-reason
until it never emits an answer, overflow its context mid-tool-loop, or decode at
2 tokens/second — and when it does, gezel *flails indistinguishably from being
broken*. Most historical "gezel is broken" moments were really "this model can't
run this shape of work on this box."

The eval harness already had the answer: a **preflight admission gate**
([evals/src/preflight.ts](../evals/src/preflight.ts)) that runs a scripted trial
against a model and refuses to benchmark it if it can't spawn, can't land a tool
call, reasons unbounded, or decodes below a floor. It caught real manifest
regressions before they wasted a whole matrix. This document describes bringing
that thinking into the product: every installed model earns a **fitness
profile** — a *proeve van bekwaamheid* (a journeyman's competence trial) — that
the UI shows as capability-honest badges and that per-step routing consumes.

The guiding rule: **fitness is advisory, never a gate.** Badges warn; routing
prefers; nothing ever stops you from selecting a model. You own your fleet.

## The proeve

When a local model finishes downloading, a fitness probe runs automatically in
the background. You can also re-run it any time from Settings → Local models
("Run fitness check"). The probe spins up one real session against the model —
no gezel, no project, no MCP subprocess, zero user-state pollution — and runs
three turns:

1. **A short-generation turn** absorbs the cold model load and records the
   engine's own decode-loop throughput as a raw baseline.
2. **A representative-context turn** adds a deterministic neutral payload
   targeting a 20K-token prompt, then records the observed prompt tokens,
   prompt-cache reuse, time to first output, prefill throughput, and decode
   throughput. This is the practical speed used by the badge and throughput
   check. `GEZEL_FITNESS_REPRESENTATIVE_TOKENS` overrides the target (`0`
   disables this turn for diagnostics/tests).
3. **A tool-round-trip turn** advertises one synthetic `write_file` tool and
   asks the model to call it. The call is captured and validated but never
   executed.

Native engines' own generation timing is authoritative. Wall-clock
`completionTokens / generationDuration` is only a compatibility fallback for
older engines that do not report decode timing; deriving it from the first SSE
fragment can badly overstate thinking models whose hidden reasoning is counted
as completion tokens but is not streamed from its first token.

From that it computes five checks (mirroring the eval preflight, minus the
harness-only profile-resolution check):

| Check | Passes when |
|---|---|
| **spawn** | the engine came up and served the probe session (capacity budget not exhausted) |
| **tool round-trip** | the model emitted a well-formed call to the advertised tool |
| **throughput** | representative-context decode rate ≥ 3 t/s (`GEZEL_FITNESS_MIN_TPS` to override; short-prompt fallback when representative telemetry is unavailable) |
| **reasoning budget** | the manifest caps `thinkingBudget` finitely, OR the model shows no thinking — never the unbounded 2³⁰ sentinel |
| **context fit** | `min(GGUF train context, launch numCtx)` ≥ 16K tokens |

A model is **admitted** when all five pass. Every probe — success, failed
checks, or machinery error (spawn throw, timeout) — produces a **persisted
record**; a probe never silently vanishes.

The probe runs against the engines gezel supervises itself — **llama.cpp, ds4,
and MLX** — so an Apple Silicon install gets the same check its Windows/Linux
counterpart does. Externally-managed engines (Ollama) and cloud providers are
out of scope: we neither launch them nor own their context/reasoning settings,
so the checks would measure someone else's configuration. The launch context the
`contextFit` check reasons about is per-engine (`config.mlxNumCtx` for MLX,
`config.llamaCppNumCtx` plus `GEZEL_LLAMA_NUM_CTX` for the GGUF engines).

Records live in `config.modelFitness`, keyed `"<provider>:<modelId>"`, read and
written through the Store by
[ModelFitnessManager](../packages/service/src/fitness/manager.ts). The config
field is deliberately loosely typed (`z.record(z.unknown())`) so a hand-mangled
or future-versioned record can never fail the whole-config parse; the strict
shape ([ModelFitnessRecordSchema](../packages/core/src/schemas/model-fitness.ts))
is enforced per entry at the manager boundary, and invalid entries are skipped.

A record goes **stale** when the model's weights sha256 or catalog version
changes (an "Update" re-fires the probe automatically). A material change in
host memory (>10% RAM drift, or a GPU appearing/disappearing) flags
`hardwareChanged` — the badge softens with a "re-run" nudge rather than
invalidating.

An install-triggered probe that would have to **evict a resident model** to
spawn defers (retrying for ~20 minutes, then persisting a `deferred` record);
a manual probe proceeds immediately — you asked for it. Probe turns ride the
background queue lane, so a probe never preempts your chat. When a manual
probe *does* need to evict a resident engine and that engine will not drain in
time (it is mid-turn), the pool refuses to kill live work and the probe
records a `blocked` result ("did not run") rather than a `failed` one — the
model is fine; the machine was just busy. Run it again once turns finish.

## Capability-honest badges

The proeve result renders as a single badge, composed from the RAM-axis fit
([computeModelFit](../packages/core/src/model-fit.ts)) plus the fitness record by
the pure [composeFitnessBadge](../packages/core/src/fitness-badge.ts):

- **Representative responsiveness** — admitted records show both perceived
  startup and loaded-context decode, for example `starts ~31s · 25 t/s`. The
  tooltip adds observed prompt size, prefill rate, cache reuse, and the raw
  short-prompt decode baseline. The same decode bands still determine pill
  severity: ≥100 t/s fast, ≥30 well, ≥2 slow, and below 2 a warning. Older
  records remain readable but say `short prompt · 128 t/s` and invite a re-run
  instead of presenting the microbenchmark as practical speed.
- **A named warning** — the first failing axis names it: `slow decoding`,
  `tool calls failed`, `unbounded reasoning`, `small context`, `did not start`.
- **`checking fitness…`** — a probe is running.
- **`did not run`** — the check could not run because the engine was busy
  serving other requests and could not be freed in time (a `blocked` record).
  Transient, not a model defect — a neutral pill, not a warning; run it again
  in a moment.
- **`not checked yet`** — no fresh record; run the check.

Badges appear on the installed-models table (Settings → Local models) with the
run/re-run action, and as a warn pill on the ModelPicker when a selected local
model has a fresh non-admitted record. They never disable a model — a warn pill
next to a model you deliberately want is information, not a veto.

## Fleet policy by hardware class

Which model to run is a function of *your* hardware, and the biggest lever is
**dense vs Mixture-of-Experts (MoE)**:

- **Low-acceleration Windows/Linux hosts** — no GPU, a consumer integrated
  GPU sharing system RAM, or a discrete GPU below 8 GiB VRAM — receive the
  smallest curated first-run model (currently Gemma E2B). A larger MoE may
  technically load by streaming experts from RAM, but observed decode is
  effectively CPU-paced and is not a usable default. Integrated adapters'
  reported shared allocation is part of system RAM and is never added to it.
  NVIDIA GB10 / DGX Spark is the explicit unified-memory exception: its large
  CUDA-addressable pool remains on the normal high-capacity path.
- **Bandwidth-bound hosts** — Apple Silicon (unified memory), NVIDIA GB10 / DGX
  Spark (unified memory pool), and small discrete GPUs (≤24 GB VRAM that must
  stream weights from RAM) — should **prefer MoE over a large dense model of
  similar size**. A sparse MoE activates only a few experts per token, so it
  reads far less memory per word and responds faster where bandwidth, not
  compute, is the ceiling. The model browse surfaces a "good match for this
  machine" hint on MoE entries here, and a "dense — may respond slowly" caution
  on large dense ones.
- **Big discrete GPUs** (>24 GB VRAM, non-unified) run a dense model fully
  resident, so MoE expert-offload buys nothing — prefer dense outright.
- **qwen3.6-27b** is the expanded-QA baseline where it fits; the DS4 engine
  (SSD-streamed DeepSeek-V4) is worth it only where a long wall-time per turn is
  genuinely acceptable.
- Keep models the proeve excludes (sub-floor throughput, context-unfit) excluded
  until the hosting changes — that's exactly the signal the badge exists to
  give you.

The predicates behind the browse hint —
[isUnifiedMemoryDevice / isBandwidthBoundHost / hardwareHint](../packages/core/src/recommendation.ts)
— are **hint-only**. They do not change the first-run auto-pick.

> **Known follow-up.** The first-run auto-pick's `excludesMoE` predicate reads
> "non-Mac + VRAM > 24 GB" as "big discrete GPU" and so misfires on unified
> non-Mac hosts (GB10 reports its whole ~119 GB pool as VRAM), *excluding* MoE
> on exactly the bandwidth-bound box that should prefer it. The browse hint
> routes around this with the separate unified-memory predicate; fixing
> `excludesMoE` itself changes the first-run pick and is deferred to a
> deliberate review of that flow.

## Capability floors → per-step routing

The payoff: **"27B plans and repairs, 4B executes, gates verify."** Eval data
shows small models execute well-scoped steps fine but fail planning and repair —
so routing each craftbook step to the right-sized model is the multiplier that
makes a heterogeneous local fleet worth assembling.

A craftbook step declares a **`capabilityFloor`** (a `ModelTier`:
`tiny|small|medium|large|cloud`). When a step doesn't set one, its
`suggestedRole`'s registry floor applies
([roles/registry.ts](../packages/core/src/roles/registry.ts) — developer/designer
= small, reviewer/planner/voorman/meester = medium, image/video = tiny). No
floor and no role → no routing.

At step handoff the TaskRunner derives the effective floor and the engine picks
the **cheapest installed local model that clears it**
([chat/model-routing.ts](../packages/service/src/chat/model-routing.ts)):

1. Keep models whose tier clears the floor.
2. Drop a model only on **fresh, completed negative fitness evidence** (probed
   and not admitted, or a measured decode rate below the floor). Missing,
   stale, failed, deferred, or blocked records exclude nothing — advisory only.
3. **Demote** (never exclude) a model with a poor gate-history against this book
   (≥2 pauses, or ≥6 attempts with zero approvals). Ordinary repair-loop holds
   are *not* a demotion signal.
4. Sort cheapest-first: tier ascending, then the config default within its tier
   (a deliberate deviation from strict-cheapest — don't second-guess a same-tier
   choice or force a third resident engine), then already-resident, then
   parameter size, then resident bytes.

An explicit gezel frontmatter model **pin always wins** — routing only replaces
the config-default fallback. Routing is **default-on for craftbook worker
sessions** on the llama-cpp engine family (mlx/ds4 are a symmetric follow-up;
cloud providers are exempt). Interactive chats are never routed. Any routing
failure degrades silently to normal resolution — a step is never blocked on it.

Kill switch: `GEZEL_DISABLE_MODEL_ROUTING=1`. Every applied route emits a
`task.step.routed` history event (`{ref, stepId, provider, model, tier,
capabilityFloor, reason, defaultModel}`) and a `[chat] model-routing:` log line;
a route that equals the default emits nothing.

Gate outcomes are stamped with the working model+provider
([logStepGated](../packages/service/src/tasks/manager.ts)), which
[aggregateModelGateEvidence](../packages/service/src/tasks/gate-telemetry.ts)
rolls up per model — that's the gate-history evidence the ranker consumes,
closing the loop from "which model ran this step" to "how did it fare."

> The ranker takes the floor as a plain input, so a future gate-escalation
> caller (Theme A stages 2/3) could pass `floor + 1` to re-route *repair* to a
> stronger model — "27B repairs." That escalation hook is not built yet; the
> seam is deliberately left open.

### Evals

Capability-floor routing is **forced OFF in every eval trial**
(`GEZEL_DISABLE_MODEL_ROUTING=1` in `evalDaemonEnvForTrial`): a trial home links
several models (chat + image + enrich), and default-on routing would swap
craftbook worker steps off the model under evaluation and corrupt the result. A
dedicated routing eval opts back in via `TrialOptions.enableModelRouting`.

## Where things live

| Concern | File |
|---|---|
| Fitness record schema | [packages/core/src/schemas/model-fitness.ts](../packages/core/src/schemas/model-fitness.ts) |
| Badge composer (pure) | [packages/core/src/fitness-badge.ts](../packages/core/src/fitness-badge.ts) |
| Hardware hint predicates | [packages/core/src/recommendation.ts](../packages/core/src/recommendation.ts) |
| Probe + checks | [packages/service/src/fitness/probe.ts](../packages/service/src/fitness/probe.ts), [checks.ts](../packages/service/src/fitness/checks.ts) |
| Probe orchestration + persistence | [packages/service/src/fitness/manager.ts](../packages/service/src/fitness/manager.ts) |
| HTTP surface | [packages/service/src/http/routes/model-fitness.ts](../packages/service/src/http/routes/model-fitness.ts) |
| Routing ranker (pure) | [packages/service/src/chat/model-routing.ts](../packages/service/src/chat/model-routing.ts) |
| Floor derivation + threading | [packages/service/src/tasks/runner.ts](../packages/service/src/tasks/runner.ts), [chat/manager.ts](../packages/service/src/chat/manager.ts) |
| UI badges + hints | [packages/ui/src/components/LlamaCppModelManager.tsx](../packages/ui/src/components/LlamaCppModelManager.tsx), [ModelPicker.tsx](../packages/ui/src/components/ModelPicker.tsx) |
