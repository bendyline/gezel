# Local-model strategy — full eval-history synthesis

> **Status / provenance.** Written from a full mining pass over the on-device eval
> history — **2,274 trials across 711 run dirs, 18 models, 220 scenarios, ~395 hours of
> wall-clock** — plus a code-state audit at HEAD `98a169b0`. Runs
> older than ~3 days predate the current codebase and are treated as era data, not current
> signal. Companion docs: [eval-strategy.md](eval-strategy.md) (the coverage-matrix frame),
> [task-completion-strategy-2026-06.md](task-completion-strategy-2026-06.md) (the five laws +
> structure roadmap), [frontier-adaptive-execution.md](frontier-adaptive-execution.md)
> (execution density), [prompt-stack.md](prompt-stack.md) (prompt layers + the Grand A/B),
> [kv-prompt-caching-strategy.md](kv-prompt-caching-strategy.md) (prefill economics).

---

## 1. Where we stand

### 1.1 The arc

| Era | Trials | Raw pass | Ex-operator | Infra share of failures |
|---|--:|--:|--:|--:|
| May (15–31) | 268 | 50.7% | — | ~20% |
| Jun 1–14 | 958 | 58.1% | 61.9% | ~18% |
| Jun 15–30 | 798 | 61.0% | **76.5%** | **0.6%** |
| Jul (1–6) | 250 | 62.4% | 66.1% | ~2% |

Two structural wins are visible in that table. First, **infra failures were engineered out**
(capacity-broker denials, chat-template 500s, GPU-arbiter-vs-watchdog kills, the MCP-bridge
401): from one in five failures to under 2%. Second, the **scoreboard became trustworthy** —
failure-class tagging (`pass|model|infra|grader|operator`), the preflight admission gate,
grader linting, and behavioral graders mean a "fail" today is almost always a real model
failure. Only **4 trials in the entire history** failed as `success-check-false` (wrong
output); among recent non-operator failures, **~97% are convergence-shaped** — `model-stuck`,
`timeout`, stall. **The fleet's problem is finishing, not producing.**

### 1.2 Current standings (current codebase, Jul 3+, n small — directional)

| Model | Jul 3+ pass | Latest full-suite anchor | Note |
|---|--:|---|---|
| qwen3.6-27b-q4 | 75% (9/12) | 17/21 (06-23); core 3/3 @ 9.6; expanded 5/8 (07-06) | **best local all-rounder; the QA baseline** |
| gemma4-e4b-q8 | 75% (n=18 era) | 16/21 (06-22); 54%→88% ex-op across eras | workhorse (42% of all trials ever) |
| gpt-oss-20b-q4 | 73% (11/15) | **19/21** after thinkingBudget 6144 (was 15/21) | biggest single tuning win |
| nemotron3-nano-30b-q4 | 73% (11/15) | 14/21 → schema-migration 3/7→7/7 post-fix | completeness lever works |
| ds4 deepseek-v4-flash-284b-q2 | 59–63% | core 3/3 @ 10.0; catalog 82/122; expanded 2/8 | capability-strong, execution-fragile (§3) |
| gemma4-31b-q4 | 58% (7/12) | core 2/3 @ 9.1; expanded 4/8 | repair-loop plateau on tankcombat |
| qwen3.5-9b-q4 | 60% (9/15) | — | tiny-tier measurement noise applies |
| gpt-5.5 (codex-cli) | — | 21/21; 88% on 25-scenario comprehensive | the cloud ceiling reference |

Excluded at preflight on this host (correctly): `mistral-medium-3.5-128b-q4` (2.02 gen t/s <
3 floor — dense-decode bandwidth-bound on GB10) and `nemotron3-super-120b-q4` (25,177 tokens
needed > 24,576 context). Triaged out earlier: mistral-7b 5.8%, llama3.2 7.1%, deepseek-r1
13.6% (true capability floors, useful only as canaries).

### 1.3 The hard cells (all-time)

| Scenario | All-time | Even the ceiling model | Failure class |
|---|--:|---|---|
| codebase-evolution | **5/106 (5%)** | gpt-5.5: 2/5 | long phased evolution; phase-4 ES-module wall |
| craftbook-rest-api | 2/42 | — (5-hour fix grind, ended in a pass) | boot→test→teardown lifecycle |
| bookstore-openapi | 23/148 | qwen passes; others 6/7 walls | exact contract execution |
| data-wrangle | 12/64 | v15 fix: DS4 10/10 | row-identity precision ETL |

No scenario with n≥3 has *never* passed. Core anchors are effectively saturated for admitted
models (recent: tictactoe 12/13, petshop 11/11, tankcombat 10/11) — the frontier has moved
entirely to multi-deliverable, exact-contract, and long-phased work.

### 1.4 Cost asymmetry

Failures burn **3–10× the wall-clock of passes** (e.g. gemma4-e4b median 1.1 min pass vs 4.4
min fail; DS4 10.5 vs 12.3 with p90 ~30 min). Every improvement in *early, accurate failure
detection* multiplies eval throughput — and its product mirror is a user watching a stalled
gezel for half an hour. Also notable: **operator interrupts are 25% of all recorded failures**
(235) — a human babysitting iteration loops is the scarcest resource in the whole program.

---

## 2. The validated playbook

These levers have before/after evidence. They are the "keep doing this" list, ranked roughly
by measured impact per unit effort.

1. **Cap the thinking, always.** `thinkingBudget` is the single highest-ROI knob in the
   program: gpt-oss 15→19/21 (cap 6144); deepseek-r1 0/19→3/3 (cap 512); mistral-128b
   flipped from failing preflight `writeFile` (12-minute over-reason) to acting in 22 tokens
   (cap 4096); nemotron coding profiles ≤6144. The manifest lint's `unbounded-reasoning`
   error makes this structural. Corollary shipped 06-23: launch budgets resolve from the
   *coding profile*, not base tuning.
2. **Name the model's own mistake.** Feedback that quotes the model's specific error beats
   generic warnings, consistently: fabricated-citation naming took squisq-review 0/3→2/3;
   verbatim vitest collection errors took failing-tests-spec 0/3→1/3; the wrapper-return
   hint recovered perf-budget 1/3→3/3. This is Law 3 of
   [task-completion-strategy](task-completion-strategy-2026-06.md) and it keeps being re-proven.
3. **State the full deliverable inventory up front.** Spec-omission is the default failure
   mode of unscaffolded small models (Law 4). Kickoff spec facts eliminated bookstore's
   omitted-paths wall (15 occurrences → 0).
4. **Admission gates + manifest lint.** The eval preflight (spawn/capacity, tool round-trip,
   profile resolution, finite budget, ≥3 t/s) caught a live unbounded-budget regression on
   its first run and correctly excludes throughput/context-unfit models today. The lint
   ratchet (`KNOWN_GAPS`) keeps manifests honest.
5. **Failure-class accounting.** Reclassifying 446 historical failures (286 model / 96 infra
   / 58 operator / 6 grader) changed several model verdicts entirely (nemotron-super 25%→57%
   adjusted) and is why §1's trends are believable.
6. **Structure that fires: the craftbook/gate stack.** After the pin-floor fix, embeddings
   restore, and retargeting of all three macro kickoff paths, gates now demonstrably fire and
   auto-advance works from plain chat sessions. Semantic pinning produced
   interface-contract's first-ever pass. The June macro A/B: ON 16/18 vs OFF 14/18, with the
   deltas exactly in the predicted headroom cells.
7. **Right-size the scaffold to the model.** Execution density (flat vs scaffold) shipped
   default-on for self-orchestrating providers: same pass rate, −36–46% tokens. Solo team
   shape flipped interface-contract 0/3→pass for *all four* local families. Role templates
   for workers (the 06-11 de-overfit migration) made results product-shaped.
8. **Prompt diet, evidence-driven.** The Grand A/B: the condensed tool-cookbook is dead
   weight at 27B (removal: 84%→92% cumulative, stall-class failures 10→2, ~700 tok/turn
   saved) but load-bearing at 8B (fabrication detectors 15→22 when removed — keep);
   developer template 10,924→3,395 ch with no regression (88.9% vs 87.0%). Measured
   decomposition shows **tool-schema structure, not prose, dominates local prompt cost**
   (17 clamped tools ≈ 12.8K tok ≈ 3.5× all standing text).
9. **Clamp the tool surface at the turn level.** DS4's direct-file-work surface (64 tools /
   74,315 schema chars → 10 tools / 9,716) flipped stale-workspace-rescue 3/6→6/6 outright.
   Load-bearing-tool floors prevent the eviction pathology that made a 12B meester inoperable.
10. **Transform-by-execution.** The v15 script-helper: for derived data deliverables, force
    "write a small Node script, run it" instead of hand-serializing through
    `writeFile.content`. Data-wrangle went from an 18-minute hand-serialized *fail* (v14) to
    **10/10 in 12 min at 10% token budget, 5 tool calls, zero repair**. Hand-emission of
    precision data is both slow *and* semantically error-prone (invented IDs, wrong dedupe
    dates); execution is the right channel.
11. **Fit the engine to the host.** DS4 host-RAM-aware expert cache (32→64 GB on the Spark):
    +25–30% decode. CUDA sd-server: renders 220s→5.6s. MoE beats dense at equal quality on
    bandwidth-bound hardware (gpt-oss/nano/DS4 usable; dense 128B is not).

---

## 3. The open failure frontier

Ranked by cross-model evidence. The July trials (current codebase) failed with **zero tool-use
red flags and zero routing errors** — these are execution/closure failures, not behavior
failures.

1. **The last-criterion plateau** (top cross-model class). Models reach N−1 of N checks, then
   make 3–5 rewrites that never touch the named defect — while receiving correct, specific
   feedback. July examples: gemma tankcombat (static sniff 9/9, runtime never passed, 22 tool
   calls); qwen bookstore (`ReferenceError: omitted is not defined` surfaced verbatim every
   cycle, never grepped); qwen data-wrangle (one golden date away, 3 rewrites around it); DS4
   habit-counter/priority-filter stalls. Mirror-image mechanics per model: gemma **under-edits**
   (broad rewrites that lose the good 90%), gpt-oss **over-edits** (fixes the target, breaks
   adjacent code), DS4 **plateaus**. The miss is *edit localization*, not diagnosis.
2. **Never-really-acted (inspection-to-mutation gap).** Reads the inputs, never writes: DS4
   expanded data-wrangle/stale-workspace (0 tool calls), 16/40 "no primary deliverable" in the
   07-02 catalog sweep, plus 14 "stale no-write repair" (file exists, checker names a small
   defect, no second write ever comes). Compact surfaces + write-now forcing closed much of
   this; not all.
3. **Idle-stall + re-engage ignored.** The #1 finding of the June sweeps, still visible in
   July as 12-minute team-idles after partial progress. The product's nudge ladder
   (CONTINUATION/VOORMAN_IDLE/scheduler redrives) exists and fires; what's missing is
   *escalation* when the nudge is ignored (§4-B).
4. **Mid-turn plateau on slow engines.** A DS4 redline phase sat ~19 minutes "mid-turn" before
   a no-op rewrite; busy-state fooled the deferral logic. `98a169b0` fixed the harness side
   (`engineRecentlyActive` gates the idle-retry path); the **product has no streamed-bytes
   progress accounting at all** — the harness still scrapes `daemon.log` for slot/stream
   pulses.
5. **Hidden-THINKING burn on constrained turns** (DS4-specific but instructive): an entire
   1024-token write-only turn spent reasoning, `finish=length`, no tool call — even with
   thinking nominally off. Mitigations that stuck are structural (early abort corrective,
   forced tool sequence, bigger budget for data writes, script-helper), not prompt-only.
6. **The three hard scenario classes.** Long-phased evolution (codebase-evolution's
   modularization phase — models churn `index.html` instead of creating `src/app.js`), exact
   contract execution (bookstore's server-vs-test envelope mismatches), row-identity precision
   (data-wrangle). These need scenario-shaped affordances (phase gates, contract-test
   skeletons, row-diff feedback), not generic nudging.
7. **Writing-judgment work.** The DS4 catalog sweep's failure cluster on blog-post /
   case-study / board-deck / copy-review confirms the
   [task-completion-strategy](task-completion-strategy-2026-06.md) Part 1.3 prediction: the
   gate vocabulary for non-code deliverables is the biggest coverage gap. (Note: the gate
   *engine* already has 16 declarative kinds including `recordSchema`, `tableShape`,
   `unsupportedClaims` — the vocabulary is further along than the June doc assumed; what's
   missing is eval pressure + judge-gates.)
8. **Tiny-tier measurement noise.** At a ~50% base rate every cell is a coin flip; pass-rate
   deltas at n=1 are unreadable. Count metrics (detector firings, nudge counts) are the only
   high-power signal down there.

---

## 4. Strategy — five themes

### Theme A — Ship the outer loop (the product is the harness's biggest unshipped customer)

The eval harness has quietly become a working prototype of the missing product layer. Today,
**harness-only**: byte-level progress accounting (log-scraped), plateau/stall watchdogs that
act, sniff→named-defect repair feedback, failure classification. **Product**: gates,
nudges, timers — sensing by text heuristics, no instrumented progress signal, and recovery
that stops at "post a message and hope."

For gezel's mission — non-technical users — this is the gap that matters most: a real user
cannot be the harness. They won't notice the stall, won't diagnose the wrong-file edit, won't
phrase the named-defect feedback. Every convergence failure in §3 is something the harness
detects and the product does not.

- **A1. Streamed-progress telemetry in the service.** Per-session counters: streamed content
  bytes, tool-argument bytes, tool calls, file mutations. The llama-cpp provider already
  observes all of it (`stream-active` debug lines); make it a first-class session signal
  consumed by (a) the product's stall logic, (b) the UI (§5.4), and (c) the eval harness —
  deleting the daemon.log-scraping in `progress-fingerprint.ts`.
- **A2. A product stall ladder with escalation.** Provider abort+salvage (exists) →
  re-engage nudge (exists) → **plateau detection** (new: sniff/artifact signature frozen
  across k attempts) → **escalation** (new: switch repair strategy per B1, or pause the task
  with the full attempt history as diagnosis — the productive-pause from
  task-completion-strategy 1.1). Product parity with the harness's FAST/LONG/STALL/CHATTER
  guards, but recovery-oriented instead of kill-oriented.
- **A3. Gate verdicts that name the mistake.** Port the eval feedback lessons into gate
  verdict text (quote the failing observation verbatim, name the artifact + location) and
  wire the existing named-mistake detectors (fabricated IDs, wrapper-shape, invented rows) as
  product-side gate feedback. Law 3, applied at the contract layer.
- **A4. Gate telemetry as the calibration loop.** Per-book never-fires / always-holds rates
  (the arcade `html-game` sniff miscalibration was caught this way on run #1). This is also
  the prerequisite for gate-coupled growth XP (§5.6).

### Theme B — Close the last mile (repair discipline)

The single largest pass-rate lever left for the current fleet. Every piece below is aimed at
§3.1–3.2.

- **B1. Plateau detector → strategy escalation.** When static signatures stop moving but the
  gate still fails: stop micro-patching, escalate to **one complete-file rewrite** with the
  full spec + named defect in-prompt (the 07-05 postmortem recommendation). If the rewrite
  also plateaus: pause-with-diagnosis. Implement in the eval feedback loop *and* the product
  nudge ladder.
- **B2. Surgical-edit affordance.** The inverse escalation for under-editors: when a nudge
  names a specific gap, instruct the smallest `replaceInFile` edit that fixes it (don't
  re-emit the file), with a low-temperature repair turn. The llama-cpp repair/edit-mode
  suffixes are the right delivery channel; `prompt.prefer-writefile-edits` already exists as
  a behavior for sub-20B coders — extend the family.
- **B3. Generalize transform-by-execution.** v15 is validated on one scenario — validate on
  a second data scenario + one non-data direct-file scenario (keeping stale-workspace-rescue
  as the regression canary), then promote: any derived/precision deliverable (JSON, CSV,
  transforms of existing files) defaults to script+run. Consider a first-class
  `derive_file`/transform tool so the pattern doesn't depend on prompt matching.
- **B4. Repair context carries the diff.** Bookstore/data-wrangle-class feedback should
  include the offending snippet and the exact replacement target (compact row-diff tables for
  data; expected-vs-got assertion pairs for contracts). The model should never have to
  re-derive *where* the defect lives.

### Theme C — Fitness-based model operations

The preflight gate proved that admission control works. The product has none of it: today a
user can select a model that over-reasons, overflows context, or decodes at 2 t/s, and gezel
will happily let it flail — indistinguishable from gezel being bad.

- **C1. Product preflight parity.** At model install/first-select: one probe turn (tool
  round-trip), finite-budget check, measured decode t/s, context fit vs the model's typical
  prompt mass. Surface as a fitness badge on the model picker (extend `computeModelFit`,
  which already does the RAM axis) rather than a hard refusal — but warn loudly.
- **C2. Fleet policy on this hardware class.** MoE over dense (bandwidth-bound GB10);
  qwen3.6-27b as the expanded-QA baseline; DS4 only where wall-time tolerance is real
  (long-form/catalog work) until §3.2 closes; keep excluded models excluded until hosting
  changes (don't burn matrix hours re-litigating).
- **C3. Fix the verified drift bug:** the eval capacity-denial log regex expects
  `capacity broker denied … budget exhausted` which no product code emits anymore (denials
  still classify via `spawn-error`, but the log leg is dead).
- **C4. Capability floors → routing (the endgame).** Craftbook steps declare a
  `capabilityFloor`; the engine assigns the cheapest installed model that clears it, using
  preflight + gate history as evidence. "27B plans and repairs, 4B executes, gates verify" is
  the cost structure that makes a local fleet beat a single big model. (Spec already in
  task-completion-strategy 2.3 — the evidence for it has only strengthened.)

### Theme D — Finish the structure wiring

- **D1. Single-channel kickoff.** Verified today: the gate stack is *live* (auto-advance
  from plain sessions, task-scoped handoff sessions for step 2+, idle sweeps, tasks complete)
  — but the *kickoff* is still dual-channel: `start_job` creates the task and separately
  chat-notifies the worker; the worker's kickoff session carries no `taskRef`. Step-1
  execution therefore leans on the assignment-keyed auto-advancer instead of having the step
  prompt + gate context in-prompt from turn 1. Make the kickoff notification *be* the
  task-scoped handoff session (`startHandoffSession` already exists — use it at create).
- **D2. Non-code eval pressure.** Six scenario classes from task-completion-strategy Part 4
  (research-verify, multi-doc-synthesis, plan-and-estimate, ops-runbook, constrained-comms,
  forms-and-records). The DS4 catalog sweep's writing-judgment failures are the standing
  evidence this is where the next coverage frontier is. Judge-gates ship advisory-first.
- **D3. Tier-collapse rendering for small models.** Flat/scaffold shipped for the frontier
  end; the small end (≤3 steps, one artifact each, single-action imperatives, narrowed tool
  surface) is specced but unbuilt. The DS4 turn-level clamp wins are the small-scale proof.
- **D4. Step-scoped tool surfaces with clamp lifetime.** Derive the kit from the active
  step's deliverable type + gate checks; and fix the observed bug where the repair surface
  widens back to 64 tools mid-repair — the clamp must persist until the validator passes.

### Theme E — Eval program hygiene

- **E1. Statistical discipline stays**: ≥3 trials/cell for pass-rate claims (single-trial
  noise ±7pp); count metrics at tiny tier; failure-class + preflight on every sweep.
- **E2. Auto-triage repeated failure signatures.** 235 operator interrupts = a human doing
  by hand what the runner should do: stop a batch when k consecutive trials die with an
  identical signature and surface the cluster. Directly attacks the 3–10× fail wall-clock tax.
- **E3. Probe craftbook-rest-api (2/42)** with the bookstore toolkit (import-cascade rewrite,
  exit-code cleanup, port-discovery classification) — same boot→test→teardown class; decide
  scenario calibration vs genuine gap.
- **E4. Keep anchors frozen; expand by adding.** The eval-strategy frame held up — the
  anchored trio is now the regression floor and the expanded set is where the signal lives.
  Refresh `current-model-coverage` style rollups monthly; carry `facts.json` on every trial.

---

## 5. Concept changes

The question behind the eval program: does gezel's *concept model* — gezels, meester,
voorman, projects, tasks, craftbooks, gates, sessions, memories — set local models up to
succeed? Verdict: **the concepts are right; three of them need promotion from internal
machinery to first-class, user-visible concepts, and two new ones have earned a place.**

### 5.1 Verified done ("done means proven") becomes the product's core loop

The data is unambiguous: local models' dominant failure is *claiming* done without *being*
done (~97% of current failures are non-convergence; done-claims-without-proof was the #1
prompt-attributable behavior). The gate machinery now works — but it's invisible plumbing.
Promote it:

- Every handoff — chat or task, scripted or ad-hoc — carries an `expectedDeliverable` **with
  a check list** (the task-completion 3.1 unification): the same contract shape whether it
  came from a craftbook step or a casual "have Piet write the brief."
- The UI distinguishes **proven done** (gate-verified, show the evidence) from **claimed
  done**. A gezel saying "klaar!" with a green verified mark is a different product than a
  chat log. This is also the honest-UX answer for non-technical users: they can't audit
  work, so the system must show them what was checked.
- Guild framing writes itself: the gate verdict is the **keurmerk** (hallmark) — work
  inspected before it leaves the bench.

### 5.2 Model fitness as a first-class concept (the proeve)

Local-model UX today treats every model as interchangeable; the history says capability,
throughput, context fit, and reasoning discipline vary so much that *most* historical "gezel
is broken" moments were actually "this model can't run this shape of work on this hardware."
Concept: every installed model passes a **proeve van bekwaamheid** (competence trial — the
product-side preflight, C1), earning a fitness profile that the roster, the meester's
delegation, and eventually per-step routing (C4) consume. Users see it as "this companion
can take on: focused builds, repairs, documents; not yet: large multi-file projects" — warm,
capability-honest, and it converts silent failure into informed choice.

### 5.3 Repair as a first-class move (not another chat turn)

The last-mile evidence (§3.1) says the *shape* of a repair attempt matters more than the
model's raw ability: scoped surface, named defect, right strategy (surgical edit vs full
rewrite vs transform-by-execution), escalation when a strategy plateaus. Today repair is an
undifferentiated chat turn. Make it a distinct execution mode with its own affordances (B1–B4)
and its own craftbook vocabulary — books gain pre-authored **recovery steps** the way they
have build steps. (The DS4 series is the existence proof: structural repair modes fixed what
prompt-only nudging could not.)

### 5.4 Progress honesty: the heartbeat

A session's "busy" state is currently a boolean that fooled even our own watchdogs. With A1's
telemetry, "working" becomes measurable (bytes streamed, tool args accumulating, files
mutating) and the UI can be honest: a gezel visibly *werkend* (progress heartbeat) vs
*vastgelopen* (stalled, with a one-click re-engage/escalate). For local models with
minutes-long writes this is the difference between trust and abandonment — and it's the same
signal the stall ladder (A2) consumes. One instrument, three customers.

### 5.5 Transform-by-execution: scripts are the precision channel

Concept-level lesson from v15: **token emission is the wrong transport for precision
artifacts.** When the deliverable is derived data (or a mechanical multi-site edit), the
gezel's job is to express the *transformation*; deterministic execution produces the bytes.
Elevate from a DS4 prompt-mode to a first-class tool/affordance (`derive_file`, or
"transform" steps in craftbooks) available to every model tier — small models benefit most
(correctness moves from their weakest muscle, long-form exact emission, to their strongest,
short program synthesis).

### 5.6 Roles as capability contracts + gate-coupled growth

Already specced (task-completion 2.1/2.4); the evidence strengthened: role templates
measurably change outcomes (npm-image flailing 5→0), role nouns gate tool kits (the
Designer/Builder lottery), and XP currently rewards chat volume. Land `gateAffinity` /
`capabilityFloor` / `defaultBooks` on roles, and award growth **only for gate-approved
completions** — which the now-live gate stack finally makes meaningful. Growth then feeds
routing (5.2) as a tie-breaker: the gezel who has repeatedly cleared citation gates *is* the
better pick for research steps, and now the system knows it.

### 5.7 One task model, tier-rendered

Keep the single task/craftbook model; finish the rendering spectrum
(frontier-flat shipped → medium as-authored → **small-collapsed**, D3) and add step-scoped
tool surfaces (D4). Structure density is a dial priced per executor tier (Law 5) — never a
fork of the task model itself. This is what keeps a task portable from a 4B local model to a
frontier CLI without redefinition.

### 5.8 Single-channel handoff

The one place the June "structurally inert" critique still half-applies: kickoff (D1). The
concept-level rule worth adopting permanently: **there is no "tell a gezel about work"
separate from "hand a gezel the work."** A handoff *is* a task-scoped session with the step
prompt and contract in-prompt. Chat remains for conversation; work travels as work.

### 5.9 What NOT to change

The eval history *validates* the soul of the product — don't churn it:

- **Gezels as warm, named characters** — role templates carry measurable weight; the crew
  metaphor maps cleanly onto capability contracts.
- **The meester as front door + macro router** — routing quality is now high (zero red-flags
  fleet-wide in recent sweeps); the build-prelude behavior fixed the mechanics.
- **Files-all-the-way-down / local-first** — the whole verification stack (sniffs, gates,
  transforms) exists *because* deliverables are inspectable files. This is the moat.
- **"A medium local model on typical hardware should pass"** — the north-star principle
  survived contact with 2,274 trials; the current fleet clusters at 60–75% with clearly
  identified, addressable failure classes, and every point of it was won by tuning/framework
  work, not model upgrades.
- **Craftbooks/gates/tasks as the structure spine** — they went from inert to live to
  measurably useful in three weeks; the remaining work is wiring (D1) and rendering (D3),
  not rethink.

---

## 6. Two-week priority list

| # | Item | Theme | Where |
|---|---|---|---|
| 1 | Streamed-progress session telemetry (product) + harness consumes it | A1 | `providers/llama-cpp/provider.ts`, `chat/manager.ts`, `evals/src/progress-fingerprint.ts` |
| 2 | Plateau detector → whole-file-rewrite escalation (eval + product ladder) | B1 | `evals/src/sniff-feedback.ts`, `chat/manager.ts` nudge selection |
| 3 | v15 generalization runs (2nd data scenario + non-data; stale-workspace canary) | B3/E1 | `evals/` targeted runs |
| 4 | Single-channel kickoff: `start_job`/`start_project` hand off via `startHandoffSession` | D1 | `packages/mcp/src/server.ts`, `chat/manager.ts` |
| 5 | Product preflight badge (probe turn, t/s, budget, context fit) | C1 | extend `core/model-fit.ts`, provider pool |
| 6 | Batch auto-triage on repeated failure signatures | E2 | `evals/src/runner.ts` batch loop |
| 7 | Gate-verdict wording pass (quote observations; named-mistake detectors) | A3 | `tasks/step-gate.ts`, gate note text |
| 8 | Clamp-lifetime fix (repair surface stays compact until validator passes) | D4 | `providers/llama-cpp/provider.ts` |
| 9 | Capacity-denial log-regex drift fix | C3 | `evals/src/failure-class.ts` or broker log line |
| 10 | codebase-evolution phase gates (imperative phase-4 ask; module-wiring checklist as craftbook recipe) | §3.6 | `evals/src/scenarios/codebase-evolution.ts` + craftbook |

**The governing metric** (unchanged from June, now measurable): **gate-verified completions
per model-tier per hour.** Convergence-shaped failures and wall-clock asymmetry are the two
denominators to attack; §4-A/B move the numerator.

---

## Appendix — sources

- Run-history inventory: 2,274 `result.json` trials mined (inventory JSONL in the
  session scratchpad; per-era/per-model tables in §1).
- Primary run reports (local artifacts under `evals/runs/`, which is
  gitignored — not part of the repository): the matrix postmortem at
  `evals/runs/matrix-2026-07-17T19-40-15-029Z/postmortem.md` and the
  DeepSeek-V4 tuning report at
  `evals/runs/tune-deepseek-v4-flash-284b-q2/REPORT.md`.
- Earlier cross-model sweep reports were working artifacts and are summarized
  in this document; their raw run directories are not part of the repository.
- Code-state audit at `98a169b0`: craftbook/gate wiring live
  (`chat/manager.ts` auto-advance ~:1026, `startHandoffSession` ~:1886, `tasks/scheduler.ts`
  sweeps), dual-channel kickoff (`packages/mcp/src/server.ts` ~:5544/:5576), stall machinery
  and DS4 provider modes (`providers/llama-cpp/provider.ts`), preflight-vs-product gap table
  (§4-C), 36 model-profile behaviors, manifest lint.
