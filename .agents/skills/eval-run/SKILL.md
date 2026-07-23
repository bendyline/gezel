---
name: eval-run
description: Run the gezel eval matrix end-to-end on this device, score trials with the fixed rubric, and produce postmortems focused on improving local-model task handling across diverse scenarios. Use when the user says "run an eval", "kick off a benchmark", names a scenario, asks to evaluate a model, or asks whether eval tuning is overfitting tests.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.


# eval-run

Closes the loop on gezel evaluations: pre-flight → run → score → report → strategic-check.

## Generalization guardrails

Treat evals as probes for local-model hosting quality, not as targets to game. Prefer fixes that make local models better at broad task work: reliable tool calls, complete file writes, repair turns, role routing, context pressure, provider budgets, sampling stability, and runtime validation.

Avoid test overfit:
- Do not add scenario names, exact expected selectors, expected strings, or game-specific recipes to model manifests, family hints, or global local-model prompts.
- Do not tune one model to one eval. A model-specific change needs either evidence from at least two diverse scenarios or a generic low-level pathology in logs, such as truncation, malformed tool args, special-token leakage, repetition, or no-tool fabrication.
- Do not change scenario prompts or assertions just to make the current artifact pass. Only change eval code when the evaluator is unrealistic, ambiguous, or failing to represent the user-facing task.
- If a tactical change is based on one scenario, frame it as an experiment and run at least one unrelated scenario before calling it a general improvement.
- If an eval-specific patch is unavoidable, label it explicitly in the postmortem and propose the framework-level replacement.

## Phase 0 — Pre-flight

1. **Resolve suite, count, and model.** With no scenario or suite named, run the named `core` suite — the standardized 11-scenario scorecard — rather than every registered scenario. Run one scenario only when the user explicitly names it; run the full registry only when they explicitly ask for an exhaustive sweep. `eval:all` requires `--count`; honor a supplied count, otherwise use `--count 1` for the first comprehensive pass (use `--count 3` or more when the user asks for comparative/statistical confidence). Default local model: the exact catalog id `gemma4-e4b-q8`; honor any model the user names.

2. **Resolve the platform-aware provider and binary.** The harness defaults to `mlx` on Apple Silicon (`darwin-arm64`) and `llama-cpp` elsewhere. MLX needs no llama binary. For llama.cpp, check the current platform/variant roots and both the branded and legacy filenames:

   ```bash
   platform="$(node -p "process.platform + '-' + process.arch")"
   find packages/app/native-bin native/build -type f \
     \( -path "*/${platform}-*/gezel-llama-server*" -o -path "*/${platform}-*/llama-server*" \) \
     2>/dev/null
   ```

   The resolver prefers CUDA → Vulkan → Metal → CPU and also checks an installed `Gezel.app` on macOS. An explicit `--provider` or `--llama-bin` overrides these defaults.

3. **Probe the platform-aware Gemma cache.** For the default `gemma4-e4b-q8`, Apple Silicon/MLX reads `~/.gezel-dev/engines/mlx/models/gemma4-e4b-q8/`; llama.cpp reads `~/.gezel-eval-cache/engines/llama-cpp/models/gemma4-e4b-q8/`. A missing MLX source is a hard preflight failure and must be installed in the dev home first. A missing llama.cpp cache is warmed automatically by `ensureWarmModel` (about 8 GB for Q8); if the same complete weights already exist under `~/.gezel-dev`, offer a symlink instead of duplicating them.

4. **SDXL preflight (the core `petshop` scenario).** The current default is `sdxl-lightning-4step`, not SDXL Base. Check both `~/.gezel-dev/engines/sd-cpp/models/sdxl-lightning-4step/` and `~/.gezel-eval-cache/engines/sd-cpp/models/sdxl-lightning-4step/`. If neither is complete, warn before starting: first-time warm is about 7 GB and can take roughly 10 minutes.

## Phase 1 — Run

Single trial:
```bash
pnpm eval:run <scenario> --model <id> --timeout <Nm> [--llm-judge]
```

Matrix (cross-scenario × N):
```bash
pnpm eval:all --count <N> --scenarios <comma,list>
```

Named core scorecard (the default for an unspecified eval request):
```bash
pnpm eval:all --suite core --count <N> --model gemma4-e4b-q8
```

`--count` has no implicit CLI default and must always carry a value. Use `--scenarios` only for an explicitly requested ad-hoc subset; it is mutually exclusive with `--suite`.

`--llm-judge` opt-in: after the trial, sends the final HTML artifact +
the original prompt to Codex Haiku (or GPT-5 mini fallback) for a
qualitative read on visual quality, functional completeness, code
quality, and polish. Output lands at `<runDir>/llm-judge.json` and is
surfaced in the postmortem as a parallel "qualitative" section — it
does NOT change the composite capability score. Costs ~5¢ per call;
silently skipped when no `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in env.

### Inline Codex judge — required for declared judge axes

When a scenario declares `judge.axes`, score those axes inline with the
active Codex session as part of the eval report. Do this for every trial
that produced the declared artifact, even when the deterministic gate
failed. Do not skip qualitative judging because an API key is absent,
and do not require `--llm-judge`; that flag only requests the optional
API-backed comparison.

Use the exact axis names and descriptions from the scenario, the frozen
0–10 rubric in `evals/src/llm-judge.ts`, and the same 20 KiB artifact
limit. Read artifacts blind to model identity where practical. Use
integer axis scores, tend toward 5 for merely delivering the brief, and
reserve 9–10 for genuinely polished work. Keep each justification
specific and at most 400 characters. Record trials without an artifact
as `noArtifact`; do not invent scores for them.

Write the advisory results to `<matrixRoot>/codex-inline-judge.json`
for a matrix or `<runDir>/codex-inline-judge.json` for a single trial.
Include `judgeProvider: "codex-inline"`, `judgeModel: "current-session"`,
scenario id, artifact path, axis scores, mean, and justification. Surface
the results in the aggregate or trial postmortem, clearly separate from
the fixed capability composite. Never write inline results to
`llm-judge.json` or present them as an Anthropic/OpenAI API call.

Runtime layer (no flag — runs automatically when the sniff says ok):
Playwright opens the produced HTML, asserts DOM behavior. For
tic-tac-toe: 9 cells exist + clicking a cell marks it. For tank-combat:
canvas/svg present, no page errors, keyboard input wired. If runtime
asserts fail, the trial keeps polling (the model may iterate); the
sniff alone is not sufficient anymore.

**Always run with `run_in_background: true`**. Scenarios take 10–45 minutes. Tail key events from the trial log every ~2 minutes:

```bash
ls -td evals/runs/<scenario>-* | head -1 | xargs -I{} tail -20 {}/log.txt
```

Useful tail filters during the run:
- `grep -E "\[scenario\]|\[poll\] (terminal|timeout)|FAIL|trial\] meester"` — tracks file states + outcome
- `grep "\[auto-answer\]"` — tracks question-answering interventions (each one is signal that the gezel was confused)

## Phase 2 — Score (objective)

The skill scores via a **fixed 0–10 rubric applied to observable facts**, never freeform judgment. Generate the facts:

```bash
pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts <runDir>
```

This produces a `TrialFacts` JSON object. Apply the rubric below using ONLY fields from that object. Each axis score must cite the specific field that drove it.

### The fixed rubric (weighted composite, max 10)

| Axis | Weight | Source fields | Deterministic mapping summary |
|---|---|---|---|
| **Task completion** | 40% | `outcome.success`, `outcome.failureMode`, `outcome.reason`, `sniff.latest.{score,scoreMax,failReason,signals}` | Success = 10; terminal gate failure = 6; timeout/stall with at least half the gate complete = 3; critical/no-output failure or any other miss = 0. |
| **Output quality** | 25% | `sniff.latest.{score,scoreMax,bytes,signals,failReason}`, `artifacts.htmlFiles[*].finalBytes`, `artifacts.imageFiles[]`, `artifacts.otherFileCount`, `outcome.success`, `outcome.reason` | Critical/no deliverable = 0; a fully satisfied realistic gate = 10; otherwise derive from `score / scoreMax`, with explicit fallbacks when a denominator is unavailable. |
| **Process efficiency** | 20% | `outcome.budgetUsedFraction`, `toolUse.totalToolCalls` | Both efficient = 10; one mild intermediate dimension = 7.5; moderate = 5; one severe dimension = 2.5; both severe = 0. |
| **Behavior soundness** | 15% | `toolUse.redFlags[]`, `team.missingExpectedRoles[]`, `autoAnswer.total`, `autoAnswer.events[*].chose` | Red flag/missing role = 0; ≥3 interventions = 5; exactly 2 = 7.5; ≤1 = 10. |

Apply these rules in the stated order so every possible facts object gets exactly one score:

1. **Task completion precedence**
   1. `outcome.success === true` → **10**.
   2. Combine `outcome.reason` and `sniff.latest.failReason` case-insensitively. If the text contains `no artifact`, `missing artifact`, `no deliverable`, `missing deliverable`, `not found`, `no inline <script`, `no script tag`, `parse error`, or `does not parse` → **0**. (`outcome.reason` is always available; `outcome.failureMode` is optional.)
   3. `outcome.failureMode === "success-check-false"` → **6** (the scenario ended terminally but failed its gate).
   4. When `sniff.latest.scoreMax > 0` and `score / scoreMax >= 0.5` → **3**.
   5. Every other unsuccessful outcome → **0**.

2. **Output quality precedence**
   1. Let `artifactCount = artifacts.htmlFiles.length + artifacts.imageFiles.length + artifacts.otherFileCount`. If it is zero, the combined reason/fail text matches an exact critical-output substring above, or `sniff.latest` exists with both `bytes === 0` and `score === 0` → **0**.
   2. A full gate means either `outcome.success === true`, or `sniff.latest.scoreMax > 0` and `sniff.latest.score >= sniff.latest.scoreMax` (the listed `signals` are the audit evidence). A full non-HTML gate (`htmlFiles.length === 0`, `imageFiles.length === 0`, and `otherFileCount > 0`) → **10** because that scenario's gate already validates its file semantics and realism. A full HTML/image gate → **10** when `(htmlFiles.length === 0 || htmlFiles.some(f => f.finalBytes >= 4096))` and `(imageFiles.length === 0 || imageFiles.some(f => f.real === true || f.bytes >= 50000))`.
   3. Otherwise, when `scoreMax > 0`, score `10 * clamp(score / scoreMax, 0, 1)`, rounded to one decimal and capped at **9.0** because the full-quality rule did not pass.
   4. With no denominator, an artifact plus at least one signal (or a positive score) → **5**; an artifact with no positive gate evidence → **2.5**.

3. **Process efficiency precedence**
   1. Define severe budget as `budgetUsedFraction >= 1.0`, severe calls as `totalToolCalls >= 30`, efficient budget as `budgetUsedFraction <= 0.5`, and efficient calls as `totalToolCalls <= 10`.
   2. Both severe → **0**; exactly one severe → **2.5**.
   3. Both efficient → **10**.
   4. Efficient budget with 11–19 calls, or budget `> 0.5` and `< 1.0` with efficient calls → **7.5**.
   5. Every remaining non-severe combination → **5** (including 20–29 calls or a moderate budget paired with another intermediate dimension).

4. **Behavior soundness precedence**
   1. Any `toolUse.redFlags` entry or any `team.missingExpectedRoles` entry → **0**.
   2. Otherwise `autoAnswer.total >= 3` → **5**; exactly `2` → **7.5**; `0` or `1` → **10**.

**Compute the composite** as `0.4*completion + 0.25*quality + 0.2*efficiency + 0.15*behavior`. Round to one decimal.

**Bands** (frame: every band asks "what do we change so this scores higher next time?"):
- **≥ 8** — `ship-ready`. The model + framework combo lands the scenario cleanly on this hardware. Lock it in as a smoke test, then look for one tactical or strategic tweak that would push it from 8 → 10 (e.g. faster t/s, fewer tool calls).
- **5 – 7.9** — `needs-tuning`. Artifact exists with real structure, but didn't close. **The fix is tactical** — temperature, max_tokens, prompt nudges, role-tool-filter, salvage layer — not "use a bigger model." A medium-tier local model SHOULD be able to do these scenarios; if it can't, the framework, prompts, or tuning need to absorb the gap.
- **≤ 4.9** — `framework-gap`. The model is producing very little usable output, OR a red flag fires, OR an expected role is missing. **This is a framework or tuning bug**, not a model ceiling. Look at red flags + missing roles + the salvage layer first. (See the petshop run for an example: composite ~3.2 because `image-generator` role was missing from `ask_specialist` — fixing the framework lifted that scenario by 5+ points.)

**Hard rule — never use "model capability" as the answer.** The anchored scenarios (`tictactoe`, `petshop`, `tankcombat`) are deliberately scoped to be within reach of medium-tier local models. If a 26B-class model can't pass `tictactoe`, the answer is *never* "try a 70B model" — the answer is *always* "what specifically should we tune or fix in the framework so a medium model passes?" Stronger models are last-resort signal, not a recommendation.

## Phase 3 — Report

Write a markdown postmortem to `<runDir>/postmortem.md`. Structure:

```markdown
# Trial postmortem — <scenarioId> / <modelId>

**Composite: X.X / 10** (band: ship-ready | needs-tuning | framework-gap)
**Outcome: success | timeout | crash | interrupted** (duration: Mm Ss; budget used: NN%)

## Score breakdown

| Axis | Score | Why |
|---|---|---|
| Task completion (40%) | X / 10 | <cite specific facts> |
| Output quality (25%) | X / 10 | <cite specific facts> |
| Process efficiency (20%) | X / 10 | <cite specific facts> |
| Behavior soundness (15%) | X / 10 | <cite specific facts> |

## Performance (deliberately separate from the capability rubric — see below)

| Metric | Value | Source |
|---|---|---|
| Peak RSS | XXX MB | `perf.process.peakRssMb` |
| Peak GPU util | XX% | `perf.gpu.peakUtilPercent` or `n/a` |
| Peak GPU mem | XXX / YYY MB | `perf.gpu.peakMemUsedMb` / `memTotalMb` |
| Mean tokens/sec | XX.X | `perf.derived.meanTokensPerSec` or `n/a` |
| Total tokens | input + output | `perf.usage.totalInputTokens` + `totalOutputTokens` |
| Host | <CPU model>, <RAM>GB, <GPU model> | `host.cpuModel`, `host.totalRamGb`, `host.gpuModel` |
| Framework | <engine> via <binary> | `host.framework`, `host.frameworkBinary` |

## Qualitative judge (when --llm-judge ran)

When `judge` is present in the facts, surface it as advisory — kept
separate from the capability composite (different question entirely).

| Axis | Score | Source |
|---|---|---|
| Visual quality | N / 10 | `judge.scoreAxes.visualQuality` |
| Functional completeness | N / 10 | `judge.scoreAxes.functionalCompleteness` |
| Code quality | N / 10 | `judge.scoreAxes.codeQuality` |
| Polish | N / 10 | `judge.scoreAxes.polish` |
| **Mean (judge)** | **N.N / 10** | `judge.meanScore` |

Judge said: *"<judge.justification verbatim>"* — `judge.judgeProvider/judge.judgeModel`

## Positives
- <observation grounded in the facts, with the field name in parens>

## Negatives
- <observation grounded in the facts, with the field name in parens>

## Tactical fixes (parameter + prompt tuning)
*Always present — even on a 10.0 trial. Suggest at least one concrete tweak.*
- **Sampling**: e.g. lower `tuning.sampling.temperature` from 1.0 → 0.7 in `../gilde/data/chat-models/<family>/<id>/manifest.json` because the model fell into special-token loops at high temp (cite the daemon.log line that justifies it).
- **Token budgets**: e.g. bump `tuning.sampling.maxTokens` 16k → 32k for write-heavy scenarios when the model stalls mid-`write_artifact`.
- **Repetition**: e.g. increase `repetition_penalty` / `repetition_context` to break n-gram loops.
- **Prompt nudges**: e.g. add/strengthen a model-profile behavior or tuning rule in [packages/service/src/model-profile/](../../../packages/service/src/model-profile/) so this family of model receives a clearer "act now, don't narrate" instruction. Cite the existing block you'd edit.
- **Reasoning budget**: e.g. constrain `<|channel|>thought` length when prose-overrun is observed.

Each suggestion must (a) name the specific file/field to change, (b) propose a specific value, (c) name the trial-fact field that justifies the change. No "try tweaking parameters" — be concrete enough that another engineer could merge it without re-reading the postmortem.

Model-specific tuning must stay model-behavior-specific, not eval-specific. It may mention model family symptoms such as truncating tool args, overlong hidden reasoning, malformed JSON, or repetition. It must not mention `tictactoe`, `petshop`, selectors, expected artifact names, exact UI copy, or scenario-specific implementation recipes inside a model manifest, family hint, or global local-model prompt.

## Strategic fixes (framework changes)
*Always present — even on a 10.0 trial. Suggest at least one structural improvement worth measuring.*
- **Team composition**: e.g. fold Voorman + Builder into a single role for `<scenario>`-scale work, or split a too-broad Builder into Drafter + Polisher. Cite `team.totalGezelsCreated` + observed coordination overhead.
- **Multimodal/single-gezel approaches**: when scenario complexity is low, recommend a flatter team. When it's high, recommend a multimodal gezel rather than separate text + image roles.
- **Toolset ergonomics**: e.g. simplify the `write_artifact` API surface, add a `replace_section` mode so the model doesn't re-emit the full file, expose a `validate_html` tool so the model can self-check before declaring done. Cite the tool-use field (e.g. `toolUse.byTool.writeFile: 3` re-writes of the same artifact).
- **Craftbook / about.md**: tighten the role's about so it discourages observed anti-patterns (e.g. Builder thinking-then-stalling). Reference `../gilde/data/gezel-templates/<role>/about.md`.
- **Salvage layer**: extend [packages/service/src/chat/manager.ts](../../../packages/service/src/chat/manager.ts) prose-salvage to recognize a new tool-call shape the model emits as freeform text. Cite the daemon.log salvage trace if observed.
- **Role-tool-filter**: if a missing role / wrong-tool pattern fired, point at [packages/service/src/chat/role-tool-filter.ts](../../../packages/service/src/chat/role-tool-filter.ts).
- **Runtime + sniff coverage**: only when the assertion is incorrectly catching a working artifact (not when the model legitimately failed).

Each suggestion must name the specific file or module to change. If a hypothesis isn't concrete enough to point at a file, it isn't strategic enough — move it to a fresh-thinking note, not the postmortem.

## Generalization check
- **Local-model behavior improved**: <name the broad behavior this run exposed: complete file writes, tool-call JSON, role routing, repair loops, context pressure, sampling stability, etc.>
- **Why this is not test overfit**: <cite cross-scenario evidence, a generic daemon-log pathology, or a framework invariant; do not cite only "this scenario passed">
- **Overfit risk**: <name any scenario-specific prompt/eval/model change and how to replace or validate it with a broader fix>

## Recommended next experiment
*One sentence: a specific, testable hypothesis with the change, the expected effect, and how to measure it across at least one unrelated scenario when feasible.* E.g. "Raise llama-cpp immediate-write `max_tokens` to 4096, re-run `tictactoe` and `bookstore-openapi`, expect fewer truncated writeFile artifacts and composite ≥ 8.0 on both."

## Raw facts
<paste the score-trial.ts output, or a path to it>
```

### Performance vs capability — keep them separate

The performance metrics intentionally **don't** feed into the composite
score. A run that scores 9/10 on capability at 2 t/s on a slow CPU is
strategically very different from a run that scores 9/10 at 60 t/s on a
hot GPU — but neither is "better"; they answer different questions. The
composite measures *can this model do this scenario*; the performance
section measures *how does this hardware × framework × model combo
compare*. Surface them side-by-side so the reader can correlate without
the rubric falsely conflating them.

**Citation discipline**: every claim in Positives/Negatives must cite at least one field from the `TrialFacts` JSON. Examples:
- ✅ "The voorman never recruited an image-generator (`team.missingExpectedRoles: ['image-generator']`)."
- ✅ "Builder tried `run_npx bin: 'generate_image'` (`toolUse.redFlags[0].pattern: 'mcp-tool-via-npx'`) — symptom of missing role-tool-filter coverage."
- ❌ "The Meester seemed confused" — no field backs this; ungrounded.

## Phase 4 — Strategic check

After writing the report, compare the new score against the last 3 runs of the **same scenario** (across any model):

```bash
ls -td evals/runs/<scenario>-*/postmortem.md 2>/dev/null | head -4
```

Also compare against at least one **unrelated scenario** from the same model family or same recent matrix run when available. The question is not only "did this scenario pass?" but "did the change improve a broad local-model failure mode without hurting other task types?"

If a regression is visible (composite is dropping across the same model, OR the same red-flag pattern keeps firing), surface that in a **separate** "Strategic note" section at the end of the postmortem — not mixed into the per-trial score. Strategic regressions are framework problems; tactical failures are per-run.

The anchored-scenario rule from [docs/eval-strategy.md](../../../docs/eval-strategy.md): **do NOT tune `tictactoe` / `petshop` / `tankcombat` to make a struggling model pass.** Use anchored scenarios to expose general local-model hosting weaknesses, then fix the general weakness. But the converse is equally important and is the load-bearing frame for this skill: **do NOT recommend a stronger model as the answer.** If a medium-tier model is failing one of these scenarios, the actionable signal is always one of:

1. A specific catalog/tuning change for this model family (cite the file).
2. A specific framework change — toolset ergonomics, team composition, salvage layer, prompt block, role-tool-filter (cite the module).
3. A specific craftbook/about.md tightening for the role that struggled (cite the file).

"This is a model capability ceiling, run a 70B model" is not a Phase 4 output — it's a Phase 4 *failure mode* for the postmortem. If the postmortem reaches that conclusion, the skill is producing low-value work. Push harder for a concrete framework or tuning change before accepting "the model can't" as the answer.

Before merging or recommending a prompt/model/eval change, run this anti-overfit audit:

1. Would this change help a user task that is not in the eval suite?
2. Is the change tied to a reusable failure mode visible in facts or daemon logs?
3. Could the same improvement live in provider/tool/runtime behavior instead of scenario wording?
4. Would a different model family reasonably benefit, or is this only memorizing one model's path through one test?

If the answer is weak, do not call the change a fix. Call it an experiment, run a diverse scenario, or replace it with a broader framework change.

## Edge cases + gotchas

- **First-time SDXL warm**: petshop's first run can spend ~10 min downloading `sdxl-lightning-4step`. Surface this in your "Phase 1 started" message so the user isn't surprised.
- **CUDA on Linux ARM (DGX Spark, Jetson)**: the harness picks `linux-arm64-cuda/gezel-llama-server` automatically (with legacy `llama-server` fallback). If it doesn't exist locally, the harness falls through to CPU — flag this in the report if `outcome.budgetUsedFraction` is high AND CUDA was expected.
- **Trial dir disappears**: if `<runDir>` doesn't exist when score-trial runs, the trial probably crashed on spawn. Check `daemon.log` first; that's the lifeline.
- **No matched question for auto-answer**: ~30% of structured questions don't get their full prompt captured (argsSummary truncation). The choice text alone is usually enough context for the postmortem.

## When the user asks "is this skill working?"

Quickly verify against the two known runs we already have:

```bash
# Known bad — should score ~3 due to image-gen routing
pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts \
    evals/runs/petshop-2026-05-16T11-29-19-191Z-nq3w | head -40
# Known bad — should score ~2-3 due to model-output quality
pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts \
    evals/runs/tankcombat-2026-05-15T23-45-58-666Z-sobc | head -40
```

If the rubric produces those bands on those runs, the skill is calibrated.
