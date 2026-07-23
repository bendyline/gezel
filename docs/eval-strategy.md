# Eval strategy

This is the perspective doc for everything in [evals/](../evals/). Read this **before** adding a new scenario, tuning an existing one, or changing the success criteria. Tactical advice for *running* an eval lives in the [evals README](../evals/README.md) and the [eval-run skill](../.agents/skills/eval-run/SKILL.md); strategy lives here.

## The frame

The eval framework is a **coverage matrix, not a leaderboard**. Each scenario tests a specific *capability axis* — single-file JS generation, multi-tool routing, long-context handoff, self-correction. Adding scenarios fills coverage gaps; the goal is **never** "make this one model pass tankcombat."

Three things follow from that frame:

1. **The anchored scenarios stay frozen.** `tictactoe`, `petshop`, `tankcombat` keep their prompts + success criteria. They're the longitudinal "did anything regress?" signal across model bumps, native-bundle bumps, and framework upgrades. If a model fails one of them, the answer is **not** to make the scenario easier — but it's also **not** "use a bigger model." The answer is to identify and fix the specific tuning, prompt, or framework gap that's costing the points.
2. **Coverage is gained by adding scenarios, not relaxing existing ones.** If a current model can't do `tankcombat` but can do a hypothetical `tank-render-only` (no game-loop), that's a new scenario, not a tankcombat tuning.
3. **Strategy lives in cross-model comparison, not single-model runs.** A single-model trial is a debugging tool. A model decision (which tier ships to which device, which framework hosts which model) needs a matrix.

## The "medium model should pass" principle

The anchored scenarios are deliberately scoped to be within reach of medium-tier local models — Gemma 4 in the 26B–31B range, Qwen at comparable size, etc. **The product target is "this works well on a medium local model on a typical developer Mac"**, not "this works well on the largest hosted model." Every eval finding feeds back into one of three lanes:

1. **Catalog tuning** — temperature, repetition penalty, max-tokens, top-p, reasoning budget, and family-specific hints resolved by [model-profile/tuning.ts](../packages/service/src/model-profile/tuning.ts) from the chat-model manifests in the external
[@bendyline/gilde](https://github.com/bendyline/gilde) content package
(`data/chat-models/`).
2. **Framework changes** — team composition (fewer/multimodal gezels), toolset ergonomics (file I/O surface, validation tools, replace-section APIs), salvage layer, role-tool-filter coverage, planner/voorman behavior, craftbook (about.md) tightening for roles that struggle.
3. **Hardware/hosting changes** — engine choice (llama.cpp vs MLX vs Ollama), GPU vs CPU, native variant.

"Recommend a stronger model" is **not** one of the lanes. It's the answer of last resort, only after every concrete tuning + framework hypothesis has been exhausted on the existing model. A postmortem that concludes "this model can't do it" without naming specific catalog + framework changes is producing low-value work — the eval matrix is here to *drive product improvement*, not to triage models into tiers.

## Capability axes the matrix should cover

Each scenario maps to one or more axes. New scenarios should explicitly state which axis they fill in their description.

| Core axis | What it tests | Core scenario |
|---|---|---|
| Single-file interactive JS | Produces a working offline page and closes the runtime loop | `tictactoe` |
| Multi-role + image-tool orchestration | Routes image work and assembles cross-role outputs | `petshop` |
| Interactive game loop | Implements rendering, state, keyboard input, and runtime behavior | `tankcombat` |
| Multi-file refactor | Evolves a typed codebase without breaking its compile contract | `schema-migration` |
| Tests as specification | Infers and implements behavior from a failing test suite | `failing-tests-spec` |
| Symptom-led debugging | Finds an undocumented semantic bug from observed output | `symptom-debug` |
| Precision ETL | Preserves records and derives exact checked data | `data-wrangle` |
| Dense read → cited structured write | Grounds a report in several source files | `incident-postmortem` |
| Runbook execution + anomaly stop | Follows a procedure and stops at the required boundary | `ops-runbook-anomaly` |
| Planning decomposition | Produces a checkable dependency-aware estimate | `plan-and-estimate` |
| Conflict synthesis | Reconciles sources while preserving explicit disagreement | `conflict-synthesis` |

The extended suites add deeper probes for image/retrieval routing, real-codebase debugging, API authoring, requirement changes, grounding, and research verification. Long-context handoff and refusal correctness still lack isolated core probes; those remain deliberate signposts for future scenarios.

## Suites — standardized units of evaluation

The registry has grown well past the point where "run everything" is a routine act, and the three anchored scenarios alone no longer differentiate current models (they mostly saturate). [evals/src/suites.ts](../evals/src/suites.ts) names the curated sets (membership pinned by `suites.test.ts`; run via `pnpm eval:all --suite <id> --count <N>`):

- **`core`** — THE standard model scorecard: the 3 frozen anchors (kept for longitudinal comparability) + 8 scenarios each covering a distinct capability axis (multi-file refactor, tests-as-spec, undocumented-bug debugging, ETL precision, dense read → structured write, runbook execution with stop-on-anomaly, planning, conflict synthesis). Hermetic, medium-model-passable. "Evaluate this model" means this.
- **`smoke`** — 3 fast probes for a pulse check before/after a risky change. Never a scorecard.
- **`extended-coding` / `extended-grounding` / `extended-retrieval`** — per-axis deep dives, reached for when core surfaces a weakness on that axis or a change targets it.
- **`headroom`** — deliberately hard probes (arcade-deluxe, squisq-review) that are NOT expected to pass 100%; they keep a saturated scorecard honest and separate frontier-class from medium-class execution.

Suite membership changes are deliberate: adding to `core` taxes every future scorecard's wall-clock, and removing breaks comparability across time. Grow the extended suites freely; promote into `core` only when an axis has proven to differentiate models and is missing there.

## What a matrix run looks like

The primary cadence is `pnpm eval:all --suite core --count <N> --model gemma4-e4b-q8` — the standardized scorecard × N trials × one model. `--count` is required; use 1 for a diagnostic pass and at least 3 for a comparative scorecard. Omitting `--suite` runs every registered scenario and is reserved for an explicitly exhaustive sweep. For a real strategy signal:

- Run the matrix across **multiple model tiers per family** — e.g. `gemma4-e2b-q8` × `gemma4-e4b-q8` × `gemma4-26b-q4`.
- Run it across **at least two families** — gemma + qwen, or gemma + a llama variant.
- Include **at least one cloud baseline** (Claude / GPT) so the on-device numbers always have a reference point. Without that the "is e4b good enough?" question has no anchor.

Cross-device comparison is a separate axis enabled by [evals/src/perf-collector.ts](../evals/src/perf-collector.ts) — every trial writes `host.json` + `metrics.json` capturing CPU, RAM, GPU, framework, and runtime metrics. Comparing the same scenario+model run on a MacBook MLX vs a DGX Spark CUDA is what tells you whether a hardware investment pays off.

## What we DO NOT do

- **Don't tune anchored scenarios** to make a specific model pass. The scenarios are the measurement; the model + framework are what we vary.
- **Don't conclude "use a stronger model."** If a medium-tier model is failing one of the anchored scenarios, the eval has surfaced a tuning or framework gap, not a model ceiling. Identify it. Stronger models are last-resort signal, never a recommendation in a postmortem.
- **Don't add prompt-engineering hints to anchored scenarios.** The prompt is the experiment; the model's response is the measurement. Adding "remember to close your script tags" turns the test into a homework assistant.
- **Don't optimize sniff thresholds against one model run.** Sniffs catch *classes* of failure (no script tag, parse error, missing image asset). When a sniff fails, the question is "did the sniff correctly identify a real problem?" If yes — keep it. If no — tune the sniff *with explanation in the comment*, never silently.
- **Don't overtune `test.json` sidecars.** Every bundled craftbook ships its eval descriptor (`versions/<v>/test.json`: sample data, mocks, kickoff prompt, static gates, advisory rubric — enforced by catalog CI, consumed by `evals/src/craftbooks/`). Its checks and rubric axes inherit the same anti-overtuning rule as craftbook step gates: encode the genuine quality bar for the task CLASS ("a real runbook names rollback steps"), never a specific scenario's sniff vocabulary. The rubric is always advisory — deterministic checks alone decide pass/fail. Anchored hand-authored graders stay in `evals/src/scenarios/`, linked via `overrides.ts`, and are unaffected by test.json edits.
- **test.json prompts are plain human asks — the craftbook carries the rigor.** A sidecar's `prompt` must read like something a real (non-technical, hurried) user would type: short, conversational, a little underspecified, typos and all. Name the input and the output file naturally ("the numbers are in source/records.csv — put some results in analysis.md") and stop there. Do NOT enumerate required sections, spell out quality criteria, or announce that a craftbook is available — that's "leading the witness": it measures instruction-following when the product question is whether the craftbook system turns a casual ask into a quality deliverable. The deliberate gap between a vague prompt and class-level gates IS the measurement. When a book fails under a plain prompt, the fix is a better craftbook (steps, gates, about.md), not a more exacting prompt.
- **Don't ship eval-only product changes.** The petshop fix added `'image-generator'` to `SPECIALIST_ROLES` — that's a real product bug the eval surfaced. Adding "ifTrial: skipImageGenRoute" anywhere in product code would be the anti-pattern.

## When to add a new scenario

Ask yourself, in order:

1. **Is there a capability axis not covered today?** If yes, write it.
2. **Are we seeing a class of model failure in production that no scenario reproduces?** If yes, write a minimal repro scenario.
3. **Did a recent fix have no test that would catch its regression?** If yes, write the scenario the fix needs.

If the answer to all three is no, don't add a scenario. The matrix has a real maintenance cost — N scenarios × M models × P trials at K minutes each. Quality matters more than quantity.

## When to retire a scenario

- The capability it tests is now structurally guaranteed (e.g. the role-routing scenario could be retired if `image-generator` becomes part of the default toolset for every gezel role — but that hasn't happened, so the scenario stays).
- The success criteria have drifted away from what we actually care about, AND no clean update is possible. Retire and write a replacement.
- It's been failing every run for ≥ 4 months with no plausible fix path. Document the lesson and remove it.

## Reporting + history

Every trial writes its `result.json` to [evals/runs/](../evals/runs/). The `/eval-run` skill produces a `postmortem.md` per trial with a 0-10 capability composite + a separate performance section. Postmortems are the unit of strategic review — read a sample after every matrix run, look for patterns (same red flag across scenarios? same auto-answer choice driving runs off course? same host beating another host on the same scenario+model?).

The performance metrics deliberately **do not** feed into the composite capability score. They answer a different question. A run that scores 9/10 on capability at 2 tokens/sec on a slow CPU is strategically very different from a run that scores 9/10 at 60 t/s on a fast GPU — but neither is "better"; they answer different questions. Don't conflate them in a single score.

## Pointers

- Trial harness: [evals/src/runner.ts](../evals/src/runner.ts)
- Scenarios: [evals/src/scenarios/](../evals/src/scenarios/)
- Static judgment (sniffs + JS validation): [evals/src/success-check.ts](../evals/src/success-check.ts), [evals/src/html-validation.ts](../evals/src/html-validation.ts)
- Performance collector: [evals/src/perf-collector.ts](../evals/src/perf-collector.ts)
- Fact extractor for postmortems: [evals/src/bin/score-trial.ts](../evals/src/bin/score-trial.ts)
- Skill (preflight, run, score, and postmortem flow): [.agents/skills/eval-run/SKILL.md](../.agents/skills/eval-run/SKILL.md)
- Role + toolset map (where missing-role bugs hide): [packages/service/src/chat/role-tool-filter.ts](../packages/service/src/chat/role-tool-filter.ts)
