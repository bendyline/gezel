# Frontier-Adaptive Execution — Spec

**Status:** **shipped (default-on for self-orchestrating providers)**

## Implementation status

Built, tested, and **default-on**:
- **Density switch + plumbing** — `executionDensity: auto|flat|scaffold` on `GezelConfig`; `resolveExecutionDensity` / `isSelfOrchestratingProvider` in `core/execution-density.ts`; eval `--render-mode` flag. **`auto` is the default (incl. unset):** flat for codex-cli/anthropic-cli/copilot, scaffold for local + raw-cloud (untouched). Set `executionDensity: 'scaffold'` to force the crew back (escape hatch).
- **Flat = the existing solo path** — the meester's routing prose (`manager.ts buildInstructions`) routes concrete asks to `start_job` (solo **ambachtsman**, which already collapses the craftbook onto the one specialist). Verified end-to-end: codex with no flag now routes solo by default and passes.
- **(a) Concision nudge** — universal (the over-write-summary tendency appears in BOTH arms): an upper-bound/length-limit bullet added to the Developer + Researcher `about.md`.
- **(b) Gate floor kept** — gates are unchanged and universal across densities, preserving an objective completion check when flat execution omits a separate Reviewer role.
- **Optional reviewer pass** — the flat routing prose explicitly allows `start_project` (crew) for a separate review/second-opinion pass on high-stakes deliverables.
- **Watchdog** (Component D) — self-orchestrating providers get a 20-min silence floor (`evals/src/runner.ts`).

Not yet done: the collapse renderer for the **pinned-craftbook** path (needed for the local/pinned case), and broader comparative validation across self-orchestrating providers.

---

(Original spec below.)

## 0. Motivation and design rationale

Self-orchestrating providers bring their own read/edit/verify loop: codex runs that loop inside
one CLI invocation, while Copilot does so inside its SDK. Wrapping every such invocation in a
full `meester → klerk → specialist` relay can duplicate orchestration that the provider already
supplies. Raw local providers do not bring that loop, so the gezel scaffold remains
load-bearing for them.

Objective gates remain valuable at either density: they define the quality floor independently
of whether a task is executed by one ambachtsman or a larger crew.

**Thesis:** scaffold density should be **elastic**, scaled to the provider's self-orchestration and the task size — not a binary "frontier mode." Frontier/agentic providers need the **quality bar** (gates), not the **team relay** or the **step-by-step recipe**. Keep one task model across the whole capability range so a task stays portable (same definition runs on a 2B local model and on Sonnet).

## 1. Core concept — one task model, two renderings

A task is invariantly `{ goal/end-state, deliverables, acceptance criteria → gates }`. The same task definition renders at two **execution densities**:

| Density | Who executes | Craftbook shape | For |
|---|---|---|---|
| **scaffold** (today) | `meester → voorman → specialists` | granular per-step recipe, per-step gates | raw-completion local models (the loop *is* the agent) |
| **flat** (new) | a single **ambachtsman** | collapsed: goal + unioned criteria + **gates at end**, procedure demoted to advisory | self-orchestrating / frontier providers |

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

## 3. Component A — the Ambachtsman (flat team)

**What:** a single generalist gezel owns a task end-to-end (plan → execute → self-verify), with the full tool surface, replacing `meester → voorman → specialists`. It is the elevation of the existing solo **Builder** (`start_job`) path from per-job to a first-class per-project staffing model.

**Integration points:**
- `gezels/roster.ts` `deriveGezelRoster:30` — when density is flat, return a single **ambachtsman** instead of a derived crew.
- `gezels/roster.ts` `pickRosterVoorman:115` — short-circuit (no voorman in flat mode).
- `gezels/ensure.ts` `resolveGildeTemplateForRole:171` — resolve the new `ambachtsman` template.
- New role template `<gilde>/data/gezel-templates/am/ambachtsman/` (bendyline/gilde repo) — about.md: a generalist who owns the whole task, plans briefly, executes, and **runs/verifies before declaring done** (port the verify-before-done machinery already in the Developer/Builder about.md: "Done means proven", "Test what you build", "After a failing check"). All tools in schema.
- The **meester** layer stays only as a *thin* multi-task scheduler/coordinator (or is skipped entirely for solo projects); it assigns the task to the ambachtsman rather than recruiting a crew.

**Design constraints:**
1. **Per-task bounded context + project memory** — do NOT run one infinite per-project conversation (it will blow the window on long projects). Each task gets a fresh ambachtsman context; cross-task continuity comes from project memory/summary (existing `memory/` machinery).
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
- **suggestedRole**: `ambachtsman`.

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
| Self-review blind spot (ambachtsman reviews own work) | Objective gates + optional fresh-context skeptical review turn |
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
- **Phase 2 — ambachtsman:** role template + flat `deriveGezelRoster` + thin/skipped meester. A/B it.
- **Phase 3 — progress tolerance** (§6).
- **Phase 4 — enable `auto` by default** for self-orchestrating providers; monitor pass rate + cost (tokens/turns/quota) on the next frontier matrix.

## 10. Open questions

1. Exact home for `orchestrationClass` (core, shared with eval) and how `raw-strong` cloud SDKs (anthropic/openai direct — strong but no built-in loop) should render: flat team but gezel still provides the turn loop. Confirm classification.
2. `taskFitsOneContext` heuristic — what inputs (deliverable count/bytes, book step count, model context window) and thresholds?
3. Project-memory strategy for the per-task ambachtsman (what carries across tasks, how summarized).
4. Should `flat-phased` reuse the existing phase machinery or a lighter grouping?
5. Does removing the per-step Reviewer measurably lower quality on subjective deliverables? (the A/B's quality check should answer this).

## Appendix — file / integration map

| Concern | File(s) |
|---|---|
| Provider classifier | new in `packages/core/src` (unify with `evals/src/providers.ts` `categorizeProvider`); service categorizes by name at `chat/manager.ts:5887` |
| Execution-density config | `core` config schema; consumed in `gezels/roster.ts` + `tasks/manager.ts` |
| Ambachtsman roster | `gezels/roster.ts` `deriveGezelRoster:30`, `pickRosterVoorman:115`; `gezels/ensure.ts` `resolveGildeTemplateForRole:171`; new template `<gilde>/data/gezel-templates/am/ambachtsman/` |
| Craftbook collapse | `tasks/manager.ts:~94-143` (materialization); new `collapseCraftbook`; manifest `endState` in `core/src/schemas/craftbook.ts`; lint in `catalog` |
| Gates (union at collapse) | unchanged engine (`tasks/gate-eval.ts`, `tasks/step-gate.ts`, `tasks/manager.ts:1122-1488`); union built in `collapseCraftbook` |
| Progress tolerance | `evals/src/runner.ts` (soft-progress, generalize MLX "T2"); runtime stall watchdog |
| A/B harness | `evals/src/bin` + `evals/src/runner.ts` (`--render-mode`) |
