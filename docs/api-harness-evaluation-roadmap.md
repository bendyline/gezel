# API harness guidance evaluation roadmap

Status: proposed testing roadmap, 2026-10-09. This document does not change runtime defaults or launch evals.

Find the least intrusive Gezel guidance that reliably completes real work with the Anthropic and OpenAI API providers. Start with `claude-sonnet-5-5` and `gpt-6-luna`, compare settings within each model, and preserve useful support for smaller local models. Treat generalist execution as the current frontier default and a hypothesis to verify, not as a predetermined winner.

The primary score must measure the product a person actually gets. The eval runner supplies fixtures, user requests, observation, and grading; Gezel supplies all autonomous execution and recovery. An explicitly assisted diagnostic can measure how much the runner's old repair channel changes outcomes, but that score must remain separate.

## Current implementation and evidence

- The raw API providers own their tool loops in Gezel and use its prompts and MCP bridge. They do not invoke the Claude Code or Codex agent harnesses. See [Anthropic](../packages/service/src/providers/anthropic.ts), [OpenAI](../packages/service/src/providers/openai.ts), and [the bridge pool](../packages/service/src/providers/mcp-bridge-pool.ts).
- `generalistMode: auto` already resolves to generalist task execution and solo kickoff for both API providers. Steps, gates, fanout barriers, and permissions remain active. Generalist mode changes ownership, session continuity, and the available tool union; it is not a switch that removes all management. See [the resolver](../packages/core/src/generalist-mode.ts) and [generalist semantics](generalist-mode.md).
- Cloud tier defaults contain no small-model behavior entries. Universal behaviors, shared conduct, task context, routing, and runtime nudges can still apply; catalog entries and environment overrides can add more. Read the resolved profile and actual prompt, not just the tier label. The canonical sources are now [core defaults](../packages/core/src/model-profile/defaults.ts) and [core registry](../packages/core/src/model-profile/registry.ts); service modules re-export them.
- Both providers passed the three initial smoke scenarios once. Both `symptom-debug` trials received eval-generated test-failure feedback. Those runs prove basic integration, not independent recovery or a statistical reliability rate. They also ended when artifact checks passed, sometimes while a turn was still running. The summaries are local, untracked run artifacts: Claude at `evals/runs/matrix-2026-10-09T15-43-23-255Z/summary.json` and OpenAI at `evals/runs/matrix-2026-10-09T15-52-33-912Z/summary.json`.
- `--repair-policy runtime` suppresses evaluator repair feedback and leaves product gates, retries, and recovery in charge. `harness` enables the evaluator's assistance on top of product behavior. Neither means “disable Gezel repair.” The [auto-answerer](../evals/src/auto-answer.ts) is currently started separately, even under `runtime`.
- The [generalist A/B runner](../evals/src/bin/ab-generalist-mode.ts) already interleaves modes and defaults to runtime repair. The [prompt A/B runner](../evals/src/bin/ab-prompt-conduct.ts) supports behavior addition/removal, but is not yet the combined campaign runner described below. Do not assume unrecognized flags reach its trials.

## Separate the controls

Use separate experimental axes before exposing any simplified product dial. Bundling them would obscure which change helped.

| Axis | Comparisons | What stays fixed |
|---|---|---|
| Execution | Explicit `generalist on` versus `off` | User request, task procedure, gates, permissions, model |
| Advisory guidance | Current, lean, and targeted prompt profiles | Required role/task information, tool contracts, evidence and access boundaries |
| Product recovery | Current management versus bounded recovery triggered by concrete failures | Validation, error reporting, cancellation, hard limits, and required task transitions |
| Evaluator assistance | `runtime` versus legacy `harness` | All product settings, simulated-user policy, fixtures, grading |

The three guidance profiles and the product-recovery switch are proposed experimental controls, not existing CLI flags. Define each as a versioned, explicit list of changes:

- **Current:** the actual resolved profile and rendered shared prompt, captured before modification.
- **Lean:** remove selected redundant advice and examples while preserving identity, the user's brief, workspace scope, live tool contracts, active task state, and authored procedures. Do not obtain this arm by blindly truncating `about.md`, selecting the phone footprint, or removing project requirements.
- **Targeted:** lean plus a small, declared set of guidance motivated by observed errors, such as interpreting tool errors or verifying a deliverable before claiming completion. Add only guidance that is useful beyond the discovery fixture.

Keep schema transformations and tool-surface changes separate from prose-only experiments. For example, `tools.gezels-as-roles` changes the delegation interface; removing it is not merely shortening a prompt. Likewise, forcing a small-model cookbook may be inert because a behavior self-gates on tier. Verify that each treatment actually reaches the API request.

Essential controls are never experimental “help”: authorization, project isolation, cancellation, truthful tool results, protocol-correct histories, signed-thinking handling, and bounded execution remain enabled. Model reasoning effort is a separate axis; hold it fixed within each model during this campaign. The OpenAI GPT-6 reasoning-family detection gap should be corrected before testing explicit effort overrides.

## Where repair belongs

The eval runner should be minimal in how it intervenes, while its grading can be extensive.

| Behavior | Owner and treatment |
|---|---|
| Seed a workspace, send the brief, collect traces, evaluate output, enforce a trial ceiling | Eval runner |
| Return an actual tool error or an authored craftbook gate rejection | Product runtime; identical behavior outside evals |
| Retry a transient provider failure or recover a stalled task from product-visible state | Product runtime, with bounded attempts and observable reasons |
| Supply a predefined clarification, changed requirement, or approval decision | Explicit simulated-user script; record it separately from repairs |
| Tell a model what a hidden assertion expects, identify the exact required fix, or recruit a rescuer solely because grading failed | Assisted diagnostic only; exclude from product qualification |
| Copy a scenario-specific solution into a global model guide | Neither; remove it |

Move an existing evaluator repair into the product only if its trigger is available in ordinary Gezel use, it addresses a reusable failure, and it improves unrelated tasks. A real compiler diagnostic from a user-visible test command can legitimately reach the model. A private grader's answer key cannot. Runtime gates must not become a back door for hidden eval answers.

Do not replace heuristic auto-answering with blanket approval. Autonomous scenarios should start with sufficient information; unexpected questions are recorded as user assistance required. Interaction scenarios use the same frozen user script in every arm and score whether the question was appropriate. Permission tests must preserve denials.

Keep old assisted results and their policy metadata for historical comparison. After qualification, make runtime repair the explicit default for the new suite, migrate the general runner default with regression coverage, and retain `harness` as an opt-in diagnostic. Never combine their scores into one pass rate.

## Phase 0 Establish trustworthy measurement

Deliver an observer-oriented campaign mode before drawing conclusions from larger runs.

1. **Record the actual treatment.** Save source revision plus working-tree diff identity, service build identity, Gilde version/content digest, fixture revision, provider/model identifiers, effective reasoning settings, generalist resolution, resolved behavior IDs, prompt section estimates, tool-schema names/hashes, and every experiment setting. Version scenario variants and exact prompts. Never record keys.
2. **Prove independence.** Record each worker's effective provider/model, including helper calls. Detect or prevent calls to Claude/Codex CLI harnesses and fallback to another model. Ordinary Gezel tools such as script execution remain available. A mixed-provider or assisted trial is classified explicitly rather than silently counted as independent.
3. **Account for every intervention.** Label model-visible synthetic messages by source: product runtime, evaluator, or simulated user; record reason, task/session, and count. Audit scenario-specific send paths as well as the common sniff/runtime posters. Under the primary policy, reject undeclared evaluator repairs.
4. **Make user simulation explicit.** Add a policy for disabled, scripted, or legacy heuristic answers; use disabled/scripted for qualification. Apply it at initial launch and controlled restart. `runtime` alone is insufficient today.
5. **Observe completion.** Keep the fixed artifact check, then observe natural turn completion and task completion where the scenario creates a task. Verify final claims against the artifact and task state. Bound the additional wait and report valid-artifact/incomplete-lifecycle separately. This is an additional qualification gate; do not silently redefine historical smoke results.
6. **Complete API observability.** Extend shared prompt/tool reporting where API providers do not expose the same data as local providers. Record tool rounds, failures/retries, runtime interventions, token usage including cached/reasoning fields when supplied, and whole-trial latency. Missing usage is unknown, not zero. Record actual provider-native failures separately from task failures.

Acceptance: a short dry run under each API shows the expected provider, resolved settings, zero undeclared evaluator repairs, observable task/turn completion, and a trace proving each active treatment. An arm with identical prompts, behavior and runtime settings when a difference was intended is an invalid experiment, not evidence of no effect.

Implementation: the opt-in `--qualification` mode and its evidence files are
documented in [evals/README.md](../evals/README.md#qualify-the-api-harness-phase-0).
It adds measurement and qualification gates without changing legacy smoke
semantics. The provider dry runs remain an acceptance step; passing unit tests
does not substitute for those runs. Arbitrary subprocess provenance, SDK-internal
retry counts, and semantic claims in unrestricted final prose have the explicit
observability limits documented there.

## Phase 1 Quantify evaluator assistance

Hold generalist **on**, current product guidance/recovery, and a frozen user-simulation policy. Compare `runtime` and `harness` on `tictactoe`, `symptom-debug`, and `craftbook-codemod-sweep` for each API model. These span artifact creation, debugging, and a multi-step workflow.

Run one trial per cell first: **2 models × 2 policies × 3 scenarios = 12 trials**. If viable, extend to three per cell, **36 total**, not 36 additional. Interleave paired cells and balance which policy runs first.

This measures the contribution or interference of evaluator repairs. It does not compare product recovery on versus off. A pass gained only with evaluator hints is a product gap to diagnose; a loss introduced by hints is interference to remove. If neither arm triggers a repair, report that this fixture did not exercise the difference.

Exit: primary results use runtime repair; assisted deltas remain a separate diagnostic. Label all interventions, even in successful trials.

## Phase 2 Compare execution and prompt guidance

Hold evaluator assistance off and product recovery at its current setting. Cross generalist **on/off** with **current/lean/targeted** guidance within each API model. This small factorial reveals whether guidance helps stepwise execution but harms a continuous generalist session.

Use six frozen discovery scenarios:

| Scenario | Purpose |
|---|---|
| `bugfix-meester-e2e` | Ordinary request through routing, execution, and deliverable |
| `schema-migration` | Multi-file work; plain-chat negative control for generalist mode |
| `fictional-sdk` | Reading unfamiliar documentation and using tools from evidence |
| `fanout-tally` | Child attribution, completion, and host barrier integrity |
| `craftbook-codemod-sweep` | Multi-step execution and repair |
| `incident-postmortem` | Non-code, evidence-grounded structured output |

The initial screen is **2 models × 2 modes × 3 profiles × 6 scenarios = 72 trials at n=1**. This is diagnostic breadth, not a release-quality pass-rate claim. Audit and freeze targeted guidance before starting this screen; adaptations start a new version and require new validation.

Keep default/explicit assignee and persona treatment clear. Existing generalist mechanics tests may pin the same worker in both arms; a second product-shaped check must exercise actual default Generalist staffing. Plain chat does not become a task because generalist mode is on, so do not attribute changes on `schema-migration` to task continuity.

Use the effective tool union that each mode is intended to have; record that difference as part of the mode treatment. During prose comparisons within a mode, keep tool schemas and capability restrictions identical. Follow promising bundled differences with one-component ablations to identify which advice earns its place.

Exit: shortlist a setting per model, retain current settings where results are ambiguous, and carry candidate/current pairs into repeated validation. Do not average the two models into a single universal winner.

## Phase 3 Measure runtime recovery and long work

With the strongest credible guidance/mode candidate fixed, compare current runtime management with a conservative policy that responds to concrete failures and limits speculative nudges. This new control needs explicit boundaries and per-trigger logging; changing the eval repair policy does not implement it.

Preserve ordinary tool errors, gate checks, necessary task transitions, and hard limits. Vary only optional continuation, premature-write pressure, heuristic stall interpretation, and related retry budgets, one family at a time. Success should not come from simply giving one arm a larger timeout or more attempts.

Use at least three contrasting probes, including a failure requiring recovery, a long legitimate read/analysis phase that should not be interrupted, and a workflow with handoffs or fanout. Three repetitions across two models and two policies is **36 trials per selected comparison**. Run this phase only for triggers observed or gaps identified earlier.

Extend coverage with controlled interruption/restart, follow-up requirement changes, context pressure, tool outages, and permission-denial fixtures. Check duplicate side effects and correct resumptions. Exercise the API adapters near and beyond their current 12-round per-send tool-loop boundary: the required outcome is explicit bounded failure or correct continuation, never silent incomplete success. Use deterministic fault injection for transport/backoff tests rather than consuming repeated live API calls unnecessarily.

Treat protocol bugs, missing tools, or broken history as correctness fixes. Repair them and rebaseline affected arms; do not disguise them as prompt-tuning wins.

## Phase 4 Validate and choose defaults

Repeat candidate versus current on the discovery set, then evaluate a frozen holdout set not used to tune guidance. Suggested holdout families are `redline-revision`, `conflict-synthesis`, `ops-runbook-anomaly`, and a longer craftbook workflow. Freeze exact members and variants before tuning starts; avoid near-duplicate procedures where feasible.

Two models × two settings × four holdouts × three repetitions is **48 holdout trials**. Three trials per cell provide a first repeatability check, not proof of a small advantage. Allocate further trials to close or inconsistent comparisons within a declared spend ceiling; inconclusive evidence keeps the current default.

Also run a compact regression set on one installed small and one installed medium local model. Keep their own profiles as controls. A cloud improvement must not remove support they rely on. The no-assistance evaluator boundary should apply to these qualification runs too, even if local models expose more gaps.

Use these decision rules, declared before reading holdout results:

- No introduced authorization/isolation failures, corrupted state, false completion, skipped required gates, or broken fanout attribution. Any such regression blocks promotion regardless of aggregate score.
- Completion and artifact quality take precedence over speed or fewer tokens. Choose a simpler/cheaper profile only when task quality is sufficiently comparable under a predeclared non-inferiority margin and adequate sample size. At low n, show paired counts and uncertainty rather than claiming equivalence.
- For equally reliable settings, prefer lower cost per successful task, fewer unnecessary interventions, and lower median/tail latency. Fewer interventions alone are not a win: a silent abandoned task has zero nudges.
- Report per scenario and per model. Keep both end-user success over all attempts and a separate provider-healthy diagnostic view, with every exclusion and retry visible. Infrastructure failures still matter to the product experience.
- Any adopted guidance must help an unrelated task family. Keep fixed anchors and hidden grader criteria unchanged; do not encode scenario names, selectors, or answer recipes in profiles.

Generalist **on** with restrained, evidence-driven support is the starting hypothesis for these models. The outcome may be different defaults per model or workload. Prefer a small number of evidence-backed profiles over a user-facing slider with many unvalidated combinations. Requalify when model versions, shared prompts, tool contracts, or task execution change.

## Implementation sequence and reporting

Implement as small, reviewable changes in this order:

1. **Measurement boundary:** user-simulation policy, intervention provenance, API provider/tool provenance, lifecycle qualification, and metadata in [runner](../evals/src/runner.ts), [types](../evals/src/types.ts), [facts](../evals/src/continuity-facts.ts), and shared reporting. Tests should catch forbidden evaluator sends and honest completion classification.
2. **Experimental controls:** versioned prompt-section/behavior selections and scoped runtime recovery policy, using the existing [prompt assembly](prompt-stack.md) and [profile override path](../packages/service/src/model-profile/runtime.ts). Keep required contracts out of optional selections. Add contract coverage for treatment differences and unchanged permissions.
3. **Campaign orchestration:** reuse the generalist runner's interleaving and prompt runner's non-vacuity checks. Make provider/model, mode, guidance, recovery, repair policy, and user simulation explicit, validated fields. Inherit no ambient behavior overrides silently. Produce a costed run plan before executing it.
4. **Boundary migration:** make product qualification unassisted by default, document legacy assisted use, and move only proven reusable recovery into the product. Keep prior result semantics intact.
5. **Default promotion:** publish the per-model decision and evidence, retain a rollback setting, and schedule a bounded regression suite for future changes.

Each report should show completed/attempted counts, artifact and lifecycle outcomes, user interventions, gate/tool errors and recovery, provider failures, mode/continuity evidence, token and schema costs, and latency. Estimate monetary costs only with a recorded price source/date; do not infer comparative model prices from token counts alone. Compare changes within a model first. Optional CLI reference runs must be labeled separately; different model versions, tools, and vendor prompts prevent attributing their whole difference to Gezel guidance.

Run phases sequentially with explicit trial/spend limits; the counts above are staged ceilings or checkpoints, not authorization for one large unattended campaign. Use scenario-appropriate frozen timeouts rather than carrying the smoke run's ten-minute limit into every long task. Stop on systemic setup failures, repair them, and resume under a new recorded build identity.
