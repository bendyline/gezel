# Generalist mode — spec and status

**Status:** v2 runtime shipped 2026-09-18 (this document); eval campaign pending
(see §8). Supersedes `frontier-adaptive-execution.md`, whose original spec is
kept as an appendix below.

## 1. What it is

One switch, `config.generalistMode: 'auto' | 'on' | 'off'`, decides how much
orchestration wraps a piece of work. Two things hang off it:

| Facet | `on` | `off` | `auto` (default, incl. unset) |
|---|---|---|---|
| **Task execution** (`resolveTaskExecutionMode`) | `generalist` | `stepwise` | `generalist` for hosted frontier providers (copilot, anthropic, anthropic-cli, openai, codex-cli); `stepwise` for every on-device model at every tier |
| **Kickoff shape** (`resolveGeneralistKickoff`, the Meester's `start_project`) | solo lead (Builder template) | crew | solo for frontier providers **and** local `medium` (the measured 2026-07-17 rule); crew otherwise |

Both live in [core/src/generalist-mode.ts](../packages/core/src/generalist-mode.ts).
The resolver ignores the tier for task execution on purpose: the single-session
plus union-tool-surface semantics are unmeasured on local engines, where tool
schemas dominate prompt mass. The eval campaign (§8) decides whether local
`medium` joins.

The Settings switch is under Artificial Intelligence → "Run in generalist mode".
The pre-v2 key `executionDensity` (`flat` ≙ `on`, `scaffold` ≙ `off`) is
migrated once by `Store.ensureLayout` and is never written by current code.

## 2. The contract of a generalist task

- **One owner.** Every step of the task — and every fanout child — is pinned
  to one gezel. Generalist mode overrides *role resolution* (a `suggestedRole`
  that would recruit a specialist), never an explicit pin: a task whose caller
  named an assignee keeps that gezel as the owner, `assignee.kind === 'user'`
  steps stay with the user, and a step explicitly pinned to another gezel is
  left alone. An auto-assigned task gets the **Generalist** gezel (gilde
  template `generalist`, one per install, reused by template id, pulled onto
  the project roster).
- **One continuous session.** Adjacent steps already shared a session when the
  same gezel owned them; a generalist task extends that to every step,
  including when a send is queued behind the current turn (the re-pin waits
  for the queue to drain) and when the caller did not label the handoff as a
  self-handoff. A fresh session is opened only when the provider or model
  changed under the task (logged as `generalist continuity broken`), or on a
  retry whose prior transcript ended in a context overflow or a
  compaction-loop halt — resuming that transcript would replay the failure.
- **Steps and gates are unchanged.** The active step still advances one at a
  time through `advance_task_step`; every step gate is still evaluated. There
  is no tier-collapse and no gate union in this mode.
- **The whole outline is in view.** The task block carries `### Task outline`
  — the book's goal and every step marked done / active / pending, with
  fanout steps annotated — and the recency anchor says the owner owns every
  step while only the active step's procedure is in force. It lives inside the
  task block so the `focused` prompt profile keeps it.
- **The tool surface is the union.** The deliverable kit, the tools every
  step's procedure mandates, the conditional built-ins and the research-intent
  flag are unions over all of the task's steps, under the same `mode: 'never'`
  security ceiling. The active step's authored `toolPolicy` still applies
  afterwards — fixed-action steps depend on it for auto-advance. The union is
  invariant across steps, so the tools block stays prefix-cache-stable on local
  engines; only the task block changes per step.
- **No per-step model routing.** The runner passes no `capabilityFloor` for a
  generalist task: one model per run, the owner's pin or the install default.
  Routing per step would move the owner between models, and a model change is
  exactly what breaks the shared transcript.
- **Fanout is preserved.** A `spawnFanout` step still spawns one child task
  per item; each child inherits `executionMode` and the pinned owner, and runs
  in its own session (that is the parallelism). The host's session is held by
  the fanout barrier and re-engaged — same session — when the last child
  settles.
- **Resolved once.** The mode is decided at task create (or at `activate()`
  for a draft, which carries an explicit request through) and stamped as
  `Task.executionMode`; children copy it. Flipping the setting never changes a
  running task.

## 3. Where it lives

| Concern | Code |
|---|---|
| Setting, resolvers, legacy mapping | [core/src/generalist-mode.ts](../packages/core/src/generalist-mode.ts); schema docblock in `core/src/schemas/api.ts` |
| Task stamp and per-invocation override | `Task.executionMode`, `CreateTaskRequest.executionMode` in [core/src/schemas/task.ts](../packages/core/src/schemas/task.ts) (not on the model-facing MCP schemas) |
| Resolution + owner pinning | `TaskManager.applyExecutionMode` / `setExecutionModeResolver`, `pinCraftbookOwner` in [tasks/craftbook-instantiation.ts](../packages/service/src/tasks/craftbook-instantiation.ts); the closure in `product-service.ts` beside the role resolver; `ChatManager.classifyExecutionTier` |
| Generalist gezel | `ensureGezel({ templateId: GENERALIST_TEMPLATE_ID })` in [gezels/ensure.ts](../packages/service/src/gezels/ensure.ts); role `generalist` in `core/src/roles/registry.ts` |
| Session continuity | `ChatManager.startHandoffSession` (`generalistTask`, `compatibleTranscript`); `sessionContextPoisoned`, `renderEntryPreface`, `classifyExecutionTierFor` in [chat/generalist-continuity.ts](../packages/service/src/chat/generalist-continuity.ts); resolver types + `applyExecutionMode` in [tasks/execution-mode.ts](../packages/service/src/tasks/execution-mode.ts) |
| Routing skip | `TaskRunner.tickOnce` floor derivation |
| Outline + anchor | `renderTaskOutline` in [chat/instructions.ts](../packages/service/src/chat/instructions.ts) |
| Union surface | `generalistSteps` / `unionStepKit` in [chat/session-tool-surface.ts](../packages/service/src/chat/session-tool-surface.ts) |
| Kickoff env to the MCP child | `GEZEL_GENERALIST_KICKOFF=on|off` (was `GEZEL_EXECUTION_DENSITY`) |
| Log marker (evals read it) | `[tasks] <ref> generalist-mode resolved=<mode> setting=<s> provider=<p> tier=<t>` |

## 4. Why the kickoff keeps a local-medium exception

The 2026-07-17 paired A/B (llama.cpp, N=3 core) measured *solo kickoff* for
local 12–45B models: flat ≥ scaffold on every scenario, zero regressions over
24 paired trials. That mechanism is unchanged, so its rule is kept. The v2
task-execution semantics are a different mechanism and are unmeasured on local
engines; they stay off under `auto` until §8 says otherwise. A consequence to
know about: `anthropic` / `openai` SDK installs on `auto` now get solo kickoff
as well (the frontier rule applies to every hosted provider); `off` is the
escape hatch.

## 5. Known gaps

- **Anthropic SDK replays without compaction.** `checkContextPressure` returns
  early for non-local providers while the `anthropic` provider replays the
  whole transcript. A long generalist run on that provider can overflow. The
  fix is to give `AnthropicSession` a `numCtx` (from the catalog context
  window) and an `estimatePromptChars()` and admit it to the pressure gate;
  tracked, not yet built. The eval campaign uses `anthropic-cli`, whose CLI
  owns its own compaction.
- **CLI providers and a rebuilt system prompt.** anthropic-cli re-spawns each
  turn with `--resume` plus a freshly written `--append-system-prompt-file`,
  codex-cli writes `instructions` per `codex exec resume`. Whether the new
  step block takes effect on a resumed session is to be verified empirically;
  the seed message and the outline make a stale system prompt survivable.

## 6. Evaluation

**Lever.** `--generalist auto|on|off` (`TrialOptions.generalistMode`, stamped
on `result.json` and `facts.json`). Arms force `on` / `off`; `auto` is never an
arm (for task-driven scenarios it equals `off` on local models, and for the
Meester-driven `schema-migration` the `off` arm means crew kickoff — read that
member as the kickoff-shape canary).

**Facts.** `facts.continuity` ([evals/src/continuity-facts.ts](../evals/src/continuity-facts.ts)):
steps activated/completed and per-step timings, gate rejections, sessions per
step and sessions reused across steps (the generalist signature, joined
through `tool.called` events), compactions between-turn / mid-turn / force-fit
with the max context fill, fanout children spawned/completed with barrier
holds and releases, and budget trips. Compaction is `observable: false` for
CLI wrappers and Copilot — their zeros are `n/a`. Failure classes gained
`cloud-context-overflow`, `fanout-skipped`, `fanout-barrier-stuck`,
`cli-resume-failed`, `compaction-degraded` (infra) and `compaction-loop`,
`task-budget-hard-pause`, `tool-repeat-abort-storm` (model).

**Suites.** `generalist` (7 members, cheapest-first: `fanout-tally`,
`fanout-stories`, `schema-migration`, `craftbook-invoice-run`,
`craftbook-author-linear`, `craftbook-codemod-sweep`,
`craftbook-refactor-module`) and `generalist-smoke` (`fanout-stories`,
`craftbook-invoice-run`, `craftbook-codemod-sweep`). The two `fanout-*`
scenarios are hermetic create-time fanouts (no gilde book) that grade fanout
mechanics: N children spawned and completed, each deliverable written by its
own child, the host writing none of them, the barrier held until the last
child settled.

**Bin.** `pnpm eval:ab-generalist` ([evals/src/bin/ab-generalist-mode.ts](../evals/src/bin/ab-generalist-mode.ts))
runs the arms interleaved per scenario (drift hits both arms), lays them out as
`evals/runs/ab-generalist-<ts>/<model>/<stepwise|generalist>/<scenario>/<trial>/`,
and writes `ab-summary.json` + `ab-summary.md` with pass n/N, median
wall-clock, steps, sessions per step, compactions, max context fill, fanout
integrity, failure classes and bug-watch flags per cell, plus the gilde data
dir, git sha and host so arms are provably comparable. The harness's per-gezel
toolset override applies in both arms and the craftbook scenarios pin an
explicit assignee, so the campaign measures the mode mechanics with the same
worker; the Generalist persona itself is not exercised (a follow-up run drops
the explicit assignee).

### Campaign runbook (this Mac, MLX, serial, A/B/A)

Preconditions: `pnpm build`; `qwen3.8-27b-q4` and `gemma4-12b-q4` installed
under `~/.gezel-dev/engines/mlx/models/`; `claude login` (or
`ANTHROPIC_API_KEY`) for the Opus arm; while the Generalist template is
unpublished, `export GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data` for every
arm (never `link:gilde` mid-campaign — the bin records which content root was
used). Only `failureClass: model` trials count toward pass rate; n=1 deltas are
leads, the smoke n=3 cells are quotable; compaction columns are `n/a` for the
CLI arm.

1. Dry run (~3-4 h): `pnpm eval:ab-generalist --suite generalist-smoke --model qwen3.8-27b-q4 --count 1 --arms off,on --aba`
2. Breadth, local (~7-9 h each, one per day): `pnpm eval:ab-generalist --suite generalist --model qwen3.8-27b-q4 --count 1 --count-strict`, then `--model gemma4-12b-q4`
3. Cloud reference (overnight): `pnpm eval:ab-generalist --suite generalist --provider anthropic-cli --model opus --count 3 --arms on,off` (the CLI default is Sonnet; `opus` must be explicit; dot-form ids fail)
4. Rates, local: `pnpm eval:ab-generalist --suite generalist-smoke --model qwen3.8-27b-q4,gemma4-12b-q4 --count 3 --count-strict` (~15 h, two nights)
5. Reports: `pnpm eval:postmortems <root>`, then `pnpm --filter @bendyline/gezel-evals run postmortems:enrich -- --out <root>/MATRIX-SUMMARY.md <root>/*/stepwise <root>/*/generalist`, then read the bin's `ab-summary.md`; write one narrative postmortem per arm root citing `facts.continuity.*`, and append the readout to §7 below. Revisit the `auto` rule for local `medium` on that evidence.

## 7. Results

_To be filled by the campaign: qwen3.8-27b-q4 and gemma4-12b-q4 (MLX) in
stepwise vs generalist; Claude Opus (anthropic-cli) in generalist vs forced
stepwise. Success rate, wall-clock, tokens, sessions per step, compactions,
fanout integrity. The `auto` rule for local medium is revisited on this
evidence._

---

## Appendix — original spec: frontier-adaptive execution (2026-07)

The design that preceded v2. Its "flat" density shipped as solo kickoff; its
collapse renderer for pinned craftbooks was never built and is superseded by
the contract above (steps and gates kept, one session, union tools).

## 0. Motivation and design rationale

Self-orchestrating providers bring their own read/edit/verify loop: codex runs that loop inside
one CLI invocation, while Copilot does so inside its SDK. Wrapping every such invocation in a
full `meester → klerk → specialist` relay can duplicate orchestration that the provider already
supplies. Raw local providers do not bring that loop, so the gezel scaffold remains
load-bearing for them.

Objective gates remain valuable at either density: they define the quality floor independently
of whether a task is executed by one Builder or a larger crew.

**Thesis:** scaffold density should be **elastic**, scaled to the provider's self-orchestration and the task size — not a binary "frontier mode." Frontier/agentic providers need the **quality bar** (gates), not the **team relay** or the **step-by-step recipe**. Keep one task model across the whole capability range so a task stays portable (same definition runs on a 2B local model and on Sonnet).

## 1. Core concept — one task model, two renderings

A task is invariantly `{ goal/end-state, deliverables, acceptance criteria → gates }`. The same task definition renders at two **execution densities**:

| Density | Who executes | Craftbook shape | For |
|---|---|---|---|
| **scaffold** (today) | `meester → voorman → specialists` | granular per-step recipe, per-step gates | raw-completion local models (the loop *is* the agent) |
| **flat** (new) | a single **Builder** | collapsed: goal + unioned criteria + **gates at end**, procedure demoted to advisory | self-orchestrating / frontier providers |

**Gates are the invariant floor across both densities.** Density is chosen by `orchestrationClass(provider) × taskSize`; it never changes *what* "done" means, only *how* the work is staffed and sequenced.

## 2. The decision function — `executionDensity(provider, task)`

Add a small classifier (new shared helper; service currently categorizes by name at `chat/manager.ts:5887`):

```
orchestrationClass(providerName):
  'self-orchestrating'  // brings its own agent loop: codex-cli, anthropic-cli, copilot
  'raw-strong'          // strong, but no built-in loop: anthropic, openai (cloud SDK)
  'raw'                 // no loop, weaker: llama-cpp, mlx (local engines)
```

```
executionDensity(provider, task, config):
  if config.executionDensity != 'auto': return config.executionDensity   // escape hatch / A/B
  cls = orchestrationClass(provider)
  if cls == 'self-orchestrating': return taskFitsOneContext(task) ? 'flat' : 'flat-phased'
  if cls == 'raw-strong':         return taskFitsOneContext(task) ? 'flat' : 'scaffold'
  return 'scaffold'
```

- `flat-phased` = collapse to a *few coarse phases* rather than one step (the collapse spectrum, §4).
- `taskFitsOneContext(task)` heuristic: deliverable count + estimated bytes + craftbook step count under a threshold. Conservative default; large/multi-file projects stay phased even for frontier.
- Config: `executionDensity: 'auto' | 'flat' | 'flat-phased' | 'scaffold'` at **global** and **per-project** scope, plus a **per-task** override. `auto` is the default and the only one that consults the classifier.

**Where:** the classifier belongs in `@bendyline/gezel` (core) so the eval harness and runtime share one definition (mirrors how `categorizeProvider` lives in `evals/src/providers.ts` today — unify them).

## 3. Component A — the Builder (flat team)

**What:** a single generalist gezel owns a task end-to-end (plan → execute → self-verify), with the full tool surface, replacing `meester → voorman → specialists`. It uses the existing solo project storage mode internally, selected by `start_project` from the effective execution density rather than by a model-facing “job” type.

**Integration points:**
- `gezels/roster.ts` `deriveGezelRoster:30` — when density is flat, return a single **Builder** instead of a derived crew.
- `gezels/roster.ts` `pickRosterVoorman:115` — short-circuit (no voorman in flat mode).
- `gezels/ensure.ts` `resolveGildeTemplateForRole:171` — resolve the `builder` template.
- Builder role template `<gilde>/data/gezel-templates/bu/builder/` (bendyline/gilde repo) — about.md: a generalist who owns the whole task, plans briefly, executes, and **runs/verifies before declaring done**. All tools in schema.
- The **meester** layer stays only as a *thin* multi-task scheduler/coordinator (or is skipped entirely for solo projects); it assigns the task to the Builder rather than recruiting a crew.

**Design constraints:**
1. **Per-task bounded context + project memory** — do NOT run one infinite per-project conversation (it will blow the window on long projects). Each task gets a fresh Builder context; cross-task continuity comes from project memory/summary (existing `memory/` machinery).
2. **Second-perspective safety** — a single executor reviewing its own work has the self-review blind spot. Offset with (a) the objective **gates** (already impartial) and (b) an optional final **fresh-context skeptical self-review** turn — not a per-step Reviewer role.
3. **Team escalation exceptions** — even in flat mode, spawn a team when there is genuine **parallelism** (independent workstreams → concurrency + separate contexts) or a genuine **tool/permission boundary**. Default flat; escalate on those signals only.
4. **Tool surface** — broad by default (frontier models handle large schemas); scope by task type only if tool-selection noise is observed.

## 4. Component B — Craftbook collapse (outcome rendering)

**What:** render a granular (local-authored) craftbook into a collapsed form for flat density. Source of truth is unchanged — **craftbooks are still authored granularly, assuming local models.** The collapse is a render-time transform.

**The transform** `collapseCraftbook(book, density) → TaskCraftbookStep[]`:
- **end-state**: from the book's explicit end-state / acceptance-criteria block (see §4.1).
- **criteria**: the union of all steps' acceptance criteria.
- **gates**: the union of all steps' `gate.checks` → attached to the collapsed step's **completion** gate (run once at the end). On reject, hand back the **full** failed-criteria list at once (frontier models fix a batch in one pass — preserves "one fix-pass").
- **procedure**: the per-step `prompt`s concatenated into a single **"Recommended approach (advisory)"** block — sequencing wisdom ("write characterization tests *before* refactoring", "lock the schema *before* the pipeline") is **preserved as guidance, not enforced as steps.** Demote, don't delete.
- **suggestedRole**: `builder`.

**Integration point:** `tasks/manager.ts:~94-143`, where `book.steps` is mapped into the task's `craftbook.steps`. Apply `collapseCraftbook` before materialization when density ≠ scaffold.

**Collapse spectrum (`flat` vs `flat-phased`):**
- `flat` → one collapsed step (bounded task).
- `flat-phased` → group the book's steps into a few coarse phases (e.g., {design, build, verify}) with a gate per phase — checkpoints to bound context and catch a wrong direction early on large work. Heuristic on step count / deliverable size.

### 4.1 New authoring requirement — explicit end-state block

Collapse is only faithful if the book declares its goal + acceptance criteria explicitly rather than only implicitly through steps. Most books already carry a "numbered acceptance-criteria checklist of 5–9 items" in the plan step — formalize it:
- Add `endState` / `acceptanceCriteria` to the craftbook manifest schema (`core/src/schemas/craftbook.ts`).
- Add a **lint** (`packages/catalog` `lint-manifests`) requiring every book to declare it.
- `collapseCraftbook` reads that block + the union of step gates.

## 5. Component C — Gates stay universal (near-zero change)

No change to the gate engine (`tasks/gate-eval.ts`, `tasks/step-gate.ts`, `tasks/manager.ts` completion-gate at `:1122-1488`). The only adaptation is that in flat mode the collapsed step's completion gate is the **union** of the source steps' gates, evaluated once at the end. `maxAttempts` and pause-for-help behavior unchanged. This is the cheap-local-compute floor that stays on for every provider and remains load-bearing for local execution.

## 6. Component D — Provider-class-aware progress tolerance ✅ DONE (eval harness)

Self-orchestrating providers emit gezel-visible "turns" infrequently (one long CLI/SDK invocation
can represent an entire work loop), so watchdogs tuned for chatty local cadence need a
provider-aware silence window.

**Implemented (eval harness):**
- `isSelfOrchestratingProvider(p)` in `evals/src/providers.ts` — codex-cli / anthropic-cli / copilot (a finer cut than `categorizeProvider`: copilot is `cloud-sdk` but self-orchestrates; raw `anthropic`/`openai` do not).
- `defaultSoftProgressTimeoutMsForModel` in `evals/src/runner.ts` now floors the **silence** window at **20 min** for self-orchestrating providers (`SELF_ORCHESTRATING_MIN_SOFT_PROGRESS_MS`), on top of the existing size-based + MLX×2 logic. The 45-min HARD progress watchdog (real product progress) stays the true backstop. Tests in `providers.test.ts` + `runner.test.ts`.
- The **daemon spawn timeout** was already 120s + a one-shot batch retry (`runner.ts:417-422`, `runTrialWithSpawnRetry`) — the copilot spawn-timeout artifact is already covered.

Deferred (lower priority): the *runtime* chat-stall watchdog (if any) should get the same class-aware treatment; and the proper long-term fix is a **streaming-aware** watchdog that doesn't fire while the provider reports active token decode.

## 7. The A/B validation (do this before/with rollout)

- Eval flag `--render-mode flat|flat-phased|scaffold|auto` → sets `executionDensity` for the trial.
- **Instrument: codex-cli** (partial tool-call diagnosability — tc 1–26 visible — vs copilot's opaque built-ins).
- Run a representative subset (e.g. `tictactoe, data-wrangle, bookstore-openapi, codebase-evolution, squisq-review, refactor-style`) **flat vs scaffold**, count ≥3 each.
- **Compare:** pass rate (hypothesis: equal), gezels/turns/tokens (hypothesis: large reduction), and **quality on sequencing-sensitive scenarios** (refactor / test-first) — the place where demoting procedure could regress.
- **Success criteria:** flat matches scaffold pass rate at materially fewer gezels/turns/tokens, with no quality regression on the sequencing-sensitive set.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Self-review blind spot (Builder reviews own work) | Objective gates + optional fresh-context skeptical review turn |
| Context-window blowout on long projects | Per-task bounded context + project memory (not one infinite thread) |
| Lost sequencing wisdom (collapse drops "test-first") | Demote procedure to *advisory*, don't delete |
| Tool-schema bloat (all tools) | Broad default; scope by task type only if selection degrades |
| Portability / local fallback | Collapse is a render-time transform; granular source retained → a flat task still falls back to scaffold for local models |
| Collapse infidelity | Mandatory explicit end-state block + lint (§4.1) |
| Over-collapsing large work | `flat-phased` spectrum (coarse phases, not always one step) |
| Losing parallelism on big projects | Team-escalation exception (§3.3) |

## 9. Rollout plan (phased, each independently shippable)

- **Phase 0 — plumbing (no behavior change at default):** `orchestrationClass` + `executionDensity` config + `--render-mode` eval flag. Unify with the eval's `categorizeProvider`.
- **Phase 1 — collapse renderer:** `collapseCraftbook` + mandatory end-state block + lint, gated behind `--render-mode flat`. A/B it (§7).
- **Phase 2 — Builder:** role template + flat `deriveGezelRoster` + thin/skipped meester. A/B it.
- **Phase 3 — progress tolerance** (§6).
- **Phase 4 — enable `auto` by default** for self-orchestrating providers; monitor pass rate + cost (tokens/turns/quota) on the next frontier matrix.

## 10. Open questions

1. Exact home for `orchestrationClass` (core, shared with eval) and how `raw-strong` cloud SDKs (anthropic/openai direct — strong but no built-in loop) should render: flat team but gezel still provides the turn loop. Confirm classification.
2. `taskFitsOneContext` heuristic — what inputs (deliverable count/bytes, book step count, model context window) and thresholds?
3. Project-memory strategy for the per-task Builder (what carries across tasks, how summarized).
4. Should `flat-phased` reuse the existing phase machinery or a lighter grouping?
5. Does removing the per-step Reviewer measurably lower quality on subjective deliverables? (the A/B's quality check should answer this).

## Appendix — file / integration map

| Concern | File(s) |
|---|---|
| Provider classifier | new in `packages/core/src` (unify with `evals/src/providers.ts` `categorizeProvider`); service categorizes by name at `chat/manager.ts:5887` |
| Execution-density config | `core` config schema; consumed in `gezels/roster.ts` + `tasks/manager.ts` |
| Builder roster | `gezels/roster.ts` `deriveGezelRoster:30`, `pickRosterVoorman:115`; `gezels/ensure.ts` `resolveGildeTemplateForRole:171`; template `<gilde>/data/gezel-templates/bu/builder/` |
| Craftbook collapse | `tasks/manager.ts:~94-143` (materialization); new `collapseCraftbook`; manifest `endState` in `core/src/schemas/craftbook.ts`; lint in `catalog` |
| Gates (union at collapse) | unchanged engine (`tasks/gate-eval.ts`, `tasks/step-gate.ts`, `tasks/manager.ts:1122-1488`); union built in `collapseCraftbook` |
| Progress tolerance | `evals/src/runner.ts` (soft-progress, generalize MLX "T2"); runtime stall watchdog |
| A/B harness | `evals/src/bin` + `evals/src/runner.ts` (`--render-mode`) |
