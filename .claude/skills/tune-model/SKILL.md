---
name: tune-model
description: Iteratively tune a specific local chat model to convergence — baseline it across 10+ evals, then adjust its catalog tuning (sampling, reasoning, engine) and model-profile behaviors one lever at a time, A/B each change, regression-sweep, and repeat until the model is well-tuned. Works on a freshly-added untuned model AND on improving an already-tuned one. Use when the user says "tune <model>", "dial in / optimize <model>", "tune the sampling/behaviors for <model>", or "get <model> well-tuned".
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

> **Content lives in `../gilde`.** Catalog data (model manifests, craftbooks,
> role templates) moved to the sibling [bendyline/gilde](https://github.com/bendyline/gilde)
> repo. Before any loop that edits content, run `pnpm link:gilde` so the
> daemon, tests, and evals resolve your checkout instead of the pinned
> `@bendyline/gilde` package; refresh generated indexes with
> `pnpm --filter @bendyline/gezel-catalog build-index`. **If a lever adds
> or changes a value in a core Zod schema — a new `style.family`, a new
> behavior id, a new tool-grammar format — run `pnpm gilde:export-schemas`
> BEFORE `build-index`**, or the manifest fails gilde's *generated*
> `schemas/*.schema.json` ajv identity check and the model is **silently
> dropped from the index** (`build-index --verbose` → `skip …
> invalid-identity`). When the loop
> lands: PR the gilde changes, publish, bump the pin in
> `packages/catalog/package.json` (+ its `minimumReleaseAgeExclude` entry
> in `pnpm-workspace.yaml`), then `pnpm unlink:gilde`.
>
> **Verifying the link took.** `pnpm link:gilde` links at the *catalog
> package* level (`packages/catalog/node_modules/@bendyline/gilde`), NOT
> the workspace root — a root `readlink node_modules/@bendyline/gilde`
> will mislead you into thinking it's still pinned. Confirm with
> `cd packages/catalog && node -e "console.log(require('module').createRequire(process.cwd()+'/package.json').resolve('@bendyline/gilde/package.json'))"`
> — it should print your `../gilde` checkout path. Point evals at the
> checkout explicitly with `GEZEL_GILDE_DATA_DIR=/abs/path/to/gilde/data`.


# tune-model

Turns a single model into a **tuning campaign**: baseline → diagnose → change one lever → A/B → regression-sweep → converge → report. Where [eval-run](../eval-run/SKILL.md) scores ONE trial and stops, `tune-model` runs the outer loop that keeps changing catalog tuning + behaviors until the aggregate stops improving.

It works both directions:
- **New / untuned model** (e.g. `qwen3.5-122b-a10b-q4` just added to the catalog): establish a working baseline tuning from a same-family sibling, then optimize.
- **Existing model**: improve from its current manifest, hunting the scenarios that under-score.

The whole skill is governed by [docs/eval-strategy.md](../../../docs/eval-strategy.md)'s frame: **a medium-tier model SHOULD pass the anchored scenarios; the answer is never "use a bigger model," it's "which specific tuning or framework lever closes the gap."** Tuning is lane #1 of that doc. This skill is how you work that lane systematically.

## What you can actually change (the three lever families)

Everything below is per-model and lives in the catalog manifest or the daemon env — none of it is a code change to the model.

| Family | Where it lives | How it reaches the engine | A/B mechanism |
|---|---|---|---|
| **Sampling** (`temperature`, `topP`, `topK`, `minP`, `maxTokens`, `seed`, `repetitionPenalty`, `repetitionContext`, `presencePenalty`, `frequencyPenalty`, `dry`, `xtc`) | `tuning.sampling` (+ `samplingWhenThinking`, + per-`profiles`) in the **root** `manifest.json` | `resolveTuning`→`applyTuning` per-provider map in [packages/service/src/model-profile/tuning.ts](../../../packages/service/src/model-profile/tuning.ts) | Edit manifest → `build-index` → re-run (sequential arms) |
| **Reasoning** (`enableThinking`, `thinkingBudget`, `effort`, `promptTags`) | `tuning.reasoning` / `tuning.promptTags` | `thinkingBudget`→ `--reasoning-budget` launch flag; `enableThinking`→ `chat_template_kwargs` | same as sampling |
| **Behaviors** (37 model-profile behaviors: fabrication detectors, ramble/preamble control, reasoning stripping, schema relaxation, prompt cookbooks, tool grammar, …) | `behaviors[]` in the root `manifest.json`; registry in [packages/service/src/model-profile/](../../../packages/service/src/model-profile/) | `resolveProfile` + `applyBehaviorEnvOverrides` at session build | `ab-prompt-conduct --force/--remove` (interleaved arms, no manifest edit) |
| **Engine launch** (`flashAttn`, `ubatchSize`, `nGpuLayers`, `cpuMoe`, `spec`) | `tuning.engine.llamaCpp` (llama-cpp only) | argv via [engine-flags.ts](../../../packages/service/src/providers/llama-cpp/engine-flags.ts) | throughput-only — measure with `ab-decode-levers`, NOT a capability lever |

**Engine matters for which knobs exist.** The MLX provider map ([tuning.ts](../../../packages/service/src/model-profile/tuning.ts) `MLX_TUNING_MAP`) **drops** `presencePenalty`, `frequencyPenalty`, `dry`, `xtc`, `grammar`, `jsonSchema`, and the per-request `thinkingBudget`. So on MLX your sampling levers are only `temperature / topP / topK / minP / maxTokens / seed / repetitionPenalty / repetitionContext / enableThinking`. Reach for `dry`/`xtc`/`presencePenalty` only when tuning the **llama-cpp** arm. Don't propose an MLX temperature-plus-DRY fix — the DRY half silently no-ops.

## Phase 0 — Scope & admit the model

1. **Resolve the target.** Model id (catalog id, e.g. `qwen3.5-122b-a10b-q4`), engine (`--provider mlx` on a Mac, `--provider llama-cpp` on a CUDA box), and — for MLX — the `--mlx-source-home` that has the weights (default `~/.gezel-dev`; a fresh flagship may live in a side home). Confirm the weights are complete, not a partial download:
   ```bash
   ls <sourceHome>/engines/mlx/models/<modelId>/manifest.json <sourceHome>/engines/mlx/models/<modelId>/*.safetensors 2>/dev/null
   ```
   For a big MoE flagship (the 122B is ~90 GB resident) confirm the box can hold it before burning an hour — check `residentBytes` in the manifest against free RAM. If it can't fit, say so and stop; tuning a model that can't load is not a tuning problem.

2. **Read the current state.** Print the model's tuning + behaviors so every later change is a diff against a known start:
   ```bash
   f=$(ls ../gilde/data/chat-models/*/<modelId>/manifest.json)
   python3 -c "import json,sys; m=json.load(open('$f')); print('behaviors:',m.get('behaviors')); print('tuning:',json.dumps(m.get('tuning'),indent=1)); print('style:',m.get('style'))"
   ```
   - **Effective behavior set** = the manifest's `behaviors[]` **verbatim** when it declares one (every bundled model does), PLUS the two universal defaults (`tools.gezels-as-roles`, `prompt.meester-craftbook-prelude`). Tier defaults ([model-profile/defaults.ts](../../../packages/service/src/model-profile/defaults.ts)) apply **only** to a model whose manifest declares NO `behaviors` array. Know this set before any behavior A/B (see the vacuous-A/B trap in Phase 3).
   - **New/untuned model** = manifest has no `tuning` block, or a thin one. Seed it from the closest same-`style.family` sibling of similar size (copy its `tuning` + `behaviors`, then optimize). E.g. a new Qwen3.5 starts from `qwen3.6-27b-q4`'s block. This is the "establish a baseline" mode; the lint in the next step tells you what's missing.

3. **Lint the manifest.** The analysis found every multi-day "bad model" saga was a manifest gap, not capability (deepseek-r1's unbounded thinking budget, mistral-medium's missing tuning block). Catch those first:
   ```bash
   pnpm --filter @bendyline/gezel-catalog lint-manifests 2>&1 | grep -iE "<modelId>|error"
   ```

4. **Admit the model (preflight).** Before running a 10-scenario baseline, prove the model is even tunable — the [preflight gate](../../../evals/src/preflight.ts) runs one cheap probe (`ensurePreflightAdmission`) and fails the whole matrix in minutes if the model can't clear five checks: **spawn/capacity**, **tool-round-trip** (a parsed tool call landed a file), **profileResolution** (only gates if the manifest authors `tuning.profiles` and the requested profile falls through — a real bug to fix in the manifest), **reasoningBudget** (an *unbounded* budget = the deepseek-r1 reason-forever failure = fix `tuning.reasoning.thinkingBudget`), and **throughput** (≥ 3 tok/s). Run the standalone probe explicitly; `eval:run` does not invoke the admission gate:
   ```bash
   pnpm --filter @bendyline/gezel-evals run preflight \
     --model <modelId> --provider <engine> --force
   # For MLX weights outside the default source home, append:
   #   --mlx-source-home <home>
   ```
   **A preflight failure IS the first tuning act.** Fix the manifest gap it names (add a `thinkingBudget`, author the missing profile, add a `tuning` block) before running the baseline — that gap would have poisoned all 10 scenarios.

5. **Pick the baseline set.** Default to the **core suite** — `pnpm eval:all --suite core` — the standardized 11-scenario scorecard from [evals/src/suites.ts](../../../evals/src/suites.ts): the 3 frozen anchors plus 8 diverse capability axes. It's the same set every model scorecard uses, so baselines stay comparable across campaigns. Widen only deliberately: add the matching `extended-*` suite when the model's intended use leans on one axis (e.g. `extended-coding` for a coder model), or bare `eval:all` (full registry incl. generated craftbook scenarios — confirm the live count with `pnpm eval:all --list`) for an exhaustive final sweep. The scenario *file* name often differs from its registered `.id`, e.g. `self-correction.ts` → id `self-correction-broken-js`.

## Phase 1 — Baseline scorecard

Run the baseline and **snapshot the manifest you're tuning from** so the final report can diff it:

```bash
cp "$(ls ../gilde/data/chat-models/*/<modelId>/manifest.json)" /tmp/<modelId>.baseline-manifest.json

# Standard baseline = the core suite. run_in_background: true — this is many hours at low t/s.
pnpm eval:all --count 1 --model <modelId> --provider <engine> \
  --suite core --timeout 45m
# Ad-hoc set: swap --suite for --scenarios <comma,list> (mutually exclusive).
# Omit both for the live full registry. For MLX weights outside the
# default source home, append: --mlx-source-home <home>
```

- **`--count 1` for the baseline** is fine (a scorecard, not a verdict); bump to `--count 3` only for the scenarios you later A/B, where run-to-run variance matters.
- **Throughput-invariance holds here exactly as in eval-run** — never treat slow decode as failure, never `--parallel >1` (GPU contention makes per-arm t/s lie), never lower token budgets to "fit" the clock. A trial fails only when it stops making *progress*; a bare `hit hard ceiling (maxDuration)` while `[poll]` still showed movement is a low-t/s artifact — bump `--timeout` and don't score it as a capability fail.
- **Score every trial** with the eval-run rubric (don't reinvent it):
  ```bash
  for d in $(ls -d evals/runs/matrix-*/*/*/ | tail -n +1); do
    pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts "$d" ; done
  ```
  Apply eval-run's fixed 0–10 rubric (task completion 40% / output quality 25% / process efficiency 20% / behavior soundness 15%) to each `TrialFacts`. See [eval-run/SKILL.md](../eval-run/SKILL.md) Phase 2 for the exact axis→field mapping and the "sniff-blind" and "harness-artifact timeout" rules — they apply unchanged.

**Write the baseline scorecard** to `evals/runs/tune-<modelId>/00-baseline.md`: a table of every scenario's composite + outcome + the dominant failure mode (from `TrialFacts`: `sniff.latest.failReason`, `toolUse.redFlags`, `outcome.failureMode`, loop/stall traces in `daemon.log`). This is the map of where to aim. Rank scenarios by composite ascending — the < 7 band is your work queue.

## Phase 2 — Diagnose (symptom → lever)

For each weak scenario, read the trial facts + `daemon.log` and classify the failure into a lever. **This is the heart of the skill — a wrong diagnosis wastes an hour-long A/B.** The lookup:

| Observed symptom (where to see it) | Likely lever | Direction |
|---|---|---|
| Repeats n-grams / special-token loops / same phrase (daemon.log, `turn.ramble-detection` firing) | `sampling.repetitionPenalty` ↑ (1.0→1.1), `repetitionContext` ↑; llama-cpp only: add `dry` `{multiplier:0.8,base:1.75}` | penalize repeats |
| Truncated mid-`write_artifact` / mid-answer, stops early (`artifacts.*.finalBytes` small + no close) | `sampling.maxTokens` ↑ (e.g. 8k→16k for write-heavy) | more room |
| Over-thinks, huge `<think>` block, prose-overrun before acting (`timing.timeToFirstToolCallMs` huge) | `reasoning.thinkingBudget` ↓ (cap it), or `samplingWhenThinking.temperature` ↓ | shorter reasoning |
| Wanders / low-quality prose / incoherent structure at high temp | `sampling.temperature` ↓ (1.0→0.7→0.6), `topP` ↓ (0.95→0.8) | tighten |
| Too deterministic / repetitive-but-not-looping / no creativity where wanted | `temperature` ↑ or the `creative` profile | loosen |
| Fabricates "I created X" with zero tool calls (`toolUse.redFlags`, past-tense-no-tools) | behavior `fabrication.detect-past-tense-no-tools` (+ `fabrication.detect-claim-without-tool`) | force ON |
| Walks files (`readFile`/`readdir`) before/instead of `search_code` (`toolUse.byTool.readFile` ≫ `search_code`) | behavior `prompt.retrieval-first` | force ON (see the tier-default-suppression trap below — a cataloged small/medium model is often *missing* this) |
| Emits a tool call as freeform text / hallucinated tool name (salvage traces) | behavior `tools.mlx-grammar` (MLX), `prompt.tool-cookbook-condensed`/`-full` | force ON |
| Narrates instead of acting / long preamble before the tool call | behaviors `turn.preamble-folding`, `prompt.terse-visible-reply` | force ON |
| Re-writes the whole file for a small edit (`toolUse.byTool.writeFile` ≥3 on one artifact) | behavior `prompt.prefer-writefile-edits` | force ON |
| Asks "should I proceed?" after the user already gave the task | behavior `turn.permission-stall` | force ON |
| Wrong/missing role, wrong tool for the job (`team.missingExpectedRoles`, redFlags) | **framework, not tuning** — role-tool-filter / craftbook (out of this skill's lane; note it in the report) | — |

**Determinism for clean A/Bs.** Local sampling is stochastic, so a single-trial delta can be noise. For the scenarios you A/B, either run `--count 3` per arm, or — for isolating a *non-sampling* change — temporarily set `sampling.seed` (or use the `deterministic` profile) so the only moving part is your lever. Remember index-bench's lesson: gemma4-e4b at MLX defaults was effectively deterministic, so know your model's variance before trusting an n=1 delta.

## Phase 3 — The tuning loop (one lever, A/B, keep or revert)

The iron rule: **change ONE lever, A/B it, keep it only if it moves the affected scenarios up without regressing others.** Two arms per change, and the arm mechanism differs by lever family.

### 3a. Behavior changes → `ab-prompt-conduct` (interleaved, no manifest edit)

This is the clean path — control vs treatment, interleaved per model so machine drift hits both arms equally, and it **refuses vacuous A/Bs**:

```bash
# Does REMOVING a behavior still keep the scenarios passing? (does the block earn its tokens?)
pnpm --filter @bendyline/gezel-evals run ab-prompt-conduct \
  --model <modelId> --provider mlx --mlx-source-home <home> \
  --remove turn.ramble-detection --scenarios tictactoe,tool-routing-retrieval,self-correction-broken-js \
  --count 3 --timeout 40m

# Does ADDING a behavior fix a failure mode?
pnpm --filter @bendyline/gezel-evals run ab-prompt-conduct \
  --model <modelId> --force fabrication.detect-claim-without-tool --scenarios <weak scenarios> \
  --count 3 --timeout 40m
```

- **Always pass `--timeout` (≥ 40m) to `ab-prompt-conduct`.** Without it the bin uses the *scenario's* default ceiling (e.g. 15m for `tool-routing-retrieval`), which a slow local model blows through mid-task — you get `hit hard ceiling … forward progress kept happening` "failures" that are wall-clock artifacts, not capability signal, and they silently halve your arm's pass rate. Wild-caught tuning gemma4-e4b: an unbounded-`--timeout` A/B returned control 50% / treatment 50% where *both* misses were 15-min timeouts — a null that was really a config error, not a real Δ.
- **`--count 2` is too few for a noisy scenario.** gemma4-e4b turned out non-deterministic on `tool-routing-retrieval` (one run searched immediately, another walked 5 files first). Establish the scenario's variance for the model, and use `--count 3`+ so one timeout artifact can't dominate the rate.

- **The vacuous-A/B trap (load-bearing).** A bundled model's manifest already *declares* its behaviors, and force-adding one it already has is a silent no-op that makes both arms identical — you'd "measure" a null and think the behavior did nothing. `ab-prompt-conduct` guards this: it reads the manifest's declared `behaviors[]` and **throws** if a `--force` id is already declared ("treatment arm is inert"). So for a cataloged model the interesting direction is usually **`--remove`** ("is this block still paying for itself?"), and **`--force` is for behaviors the manifest does NOT declare.** Use `--skip-manifest-check` only to deliberately target a universal/tier default (e.g. `--remove tools.gezels-as-roles`, which no manifest declares but every model carries — confirm the effect in `daemon.log` via the `[model-profile] GEZEL_REMOVE_BEHAVIORS … no-op`/applied line).
- **Reading the result**: `ab-summary.json` in the run dir carries `byArm.{control,treatment}` pass rates + the daemon-log marker counts (stall nudges, detector hits). A behavior earns "keep" when it lifts pass rate OR cuts a failure-marker count with no pass-rate loss.
- **Promote a winner into the manifest**: add/remove the id in `behaviors[]` of the root `manifest.json`, then `build-index` (below).

### 3b. Sampling / reasoning changes → manifest edit + `build-index` (sequential arms)

Sampling only threads through the **gezel-session path** (the scenarios), never raw `/v1` — so gate on scenario pass-rate, not a `/v1` probe. There's no `--sampling` flag on the eval bins; the loop is edit → rebuild → run → compare:

```bash
# 1. Edit the ROOT manifest's tuning (NEVER the versions/<v>/manifest.json — that holds only sources).
#    Change exactly ONE field. Example: tame a repetition loop on llama-cpp.
#    ../gilde/data/chat-models/<shard>/<modelId>/manifest.json → tuning.sampling.repetitionPenalty: 1.0 → 1.1

# 2. Rebuild the index — the daemon reads data/chat-models/index.json (which CACHES the full manifest),
#    NOT the per-model file. Without this the edit is invisible. (This is the #1 tune-model footgun.)
pnpm --filter @bendyline/gezel-catalog build-index

# 3. Re-run ONLY the affected scenarios, treatment arm:
pnpm eval:all --count 3 --model <modelId> --provider mlx --mlx-source-home <home> \
  --scenarios <affected scenarios> --runs-dir evals/runs/tune-<modelId>/lever-<n>-treatment --timeout 45m

# 4. Compare treatment vs the baseline cell for those scenarios (compare:scores reads composites across run dirs):
pnpm --filter @bendyline/gezel-evals run compare:scores -- --out evals/runs/tune-<modelId>/lever-<n>.md
```

- **Sequential arms are acceptable for capability** (pass/fail is throughput-invariant; unlike decode-t/s, it doesn't drift with thermals). But re-run the *baseline* cell for the same scenarios in the same session if you're worried about model-state drift.
- **The profiles wrinkle**: sampling resolves as `override › install-default › profile-layer › catalog base`. A model with `tuning.profiles` uses the profile that the task/role requests (default `thinking-general`); a coding scenario may pull `thinking-coding`. If your `tuning.sampling` edit doesn't move the needle, check whether a **profile** is shadowing it — you may need to edit the matching `profiles.<id>.sampling` too. Read [tuning.ts](../../../packages/service/src/model-profile/tuning.ts) `resolveTuning` if a change seems ignored, and grep `daemon.log` for the `profile=` trace.
- **Runtime shortcut for a quick read** (no manifest edit): a bespoke arm can `client.updateConfig({ modelTuning: { <modelId>: { sampling: {...} } } })` — this is the install-default layer, higher precedence than the manifest — the pattern [ab-decode-levers.ts](../../../evals/src/bin/ab-decode-levers.ts) uses. Good for a fast sanity check before committing a manifest edit; the manifest edit is still the thing you ship.

### 3c. Loop discipline

- **One lever per iteration.** If you change temperature AND a behavior together and it improves, you don't know which did it — and one of them may be silently hurting. Serialize.
- **Keep or revert explicitly.** After each A/B, either promote the change into the manifest (`build-index`) or revert the manifest edit. Never leave a half-applied lever between iterations — it contaminates the next A/B's baseline.
- **Log every iteration** to `evals/runs/tune-<modelId>/LEVERS.md` (the index-bench `LEVERS.md` discipline): lever, hypothesis, arms, per-scenario delta, verdict (keep/revert), and *why*. This is what makes the campaign resumable and the final report writable.

## Phase 4 — Regression sweep after every accepted change

**A tuning change that fixes scenario A can silently break scenario B** — the classic case is dropping temperature to kill a game-loop's incoherence and thereby flattening a creative-writing scenario, or forcing a fabrication detector that then false-positives on a legitimate terse answer. So after you PROMOTE a lever:

```bash
# Re-run the FULL matrix (or at minimum every scenario that was passing before) with the new manifest.
pnpm eval:all --count 1 --model <modelId> --provider mlx --mlx-source-home <home> \
  --runs-dir evals/runs/tune-<modelId>/after-lever-<n> --timeout 45m
pnpm --filter @bendyline/gezel-evals run compare:scores -- --out evals/runs/tune-<modelId>/after-lever-<n>.md
```

Compare the full scorecard to the pre-change one. If the aggregate dropped or any previously-passing anchored scenario regressed, **the lever is not a keep** — revert it even though it helped its target scenario, and look for a narrower fix (a `profiles.<id>` change scoped to the task class, rather than the global `tuning.sampling`). Profiles exist precisely so a coding-specific tightening doesn't cost you the creative path.

## Phase 5 — Converge & report

**Convergence** — stop the loop when any of:
- every scenario is ≥ the target band (default: anchored + curated all ≥ 7, no red flags), OR
- the aggregate pass-rate plateaus (two accepted levers in a row move it < 1 scenario), OR
- the remaining failures diagnose to **framework, not tuning** (missing role, tool-surface ergonomics, craftbook gating) — those are out of this skill's lane; name them and hand them to [eval-run](../eval-run/SKILL.md)'s strategic-fix section or a framework change.

**Final tuning report** → `evals/runs/tune-<modelId>/REPORT.md`:

```markdown
# Tuning campaign — <modelId> (<engine>)

**Baseline aggregate: X/N passed, mean composite Y.Y → Tuned: X'/N, Y'.Y'** (Δ +N scenarios, +Z.Z mean)

## Scorecard (baseline → tuned)
| Scenario | Baseline | Tuned | Δ | Lever that moved it |
|---|---|---|---|---|
| tictactoe | 4.2 | 8.1 | +3.9 | repetitionPenalty 1.0→1.1 |
| … | | | | |

## Levers applied (in order)
| # | Lever | Change | Affected scenarios Δ | Regression sweep | Verdict |
|---|---|---|---|---|---|
| 1 | sampling.repetitionPenalty | 1.0 → 1.1 | tictactoe +3.9, tankcombat +2.1 | full matrix flat | KEPT |
| 2 | behavior turn.ramble-detection | removed | no change, −2 stall nudges | flat | KEPT (earns fewer tokens) |
| 3 | sampling.temperature | 0.7 → 0.5 | tictactoe +0.3 | arcade-deluxe −1.8 | REVERTED (regressed creative) |

## The manifest diff (what to ship)
<the exact tuning/behaviors delta vs /tmp/<modelId>.baseline-manifest.json — the reviewable change>

## Residual gaps (framework, not tuning)
- <scenario>: <the failure diagnoses to role-tool-filter / craftbook gate / salvage — cite the module, hand off>

## Reproduce
`pnpm eval:all --count 1 --model <modelId> --provider <engine> --mlx-source-home <home>`
```

The shipped artifact is the edited **root `manifest.json`** (+ `build-index` so `data/chat-models/index.json` reflects it). Confirm it lints clean (`pnpm --filter @bendyline/gezel-catalog lint-manifests`). Per repo rules, **do not commit** — leave the manifest edit + report for the user to review and commit.

## Guardrails & gotchas

- **The `build-index` footgun (most common failure).** `data/chat-models/index.json` caches the *full* resolved manifest; the daemon reads that, not your edited per-model file. Every sampling/behavior manifest edit MUST be followed by `pnpm --filter @bendyline/gezel-catalog build-index` before the next eval, or you'll A/B two identical configs and conclude "the lever did nothing." (Behavior A/Bs via `ab-prompt-conduct --force/--remove` bypass this — they override at the daemon-env layer.)
- **The `invalid-identity` silent-drop (when a lever touches a core enum).** If a lever introduces a value that isn't yet in gilde's *generated* JSON schemas — a new `style.family` (e.g. adding `glm`), a new behavior id, a new engine/grammar enum — `build-index` **silently omits the model from the index** (it fails `loadResolvedManifest`'s ajv identity check). No error; the model just isn't there, and the daemon falls back to defaults so your "tuning" evaluates a model that no longer carries your edit. Symptoms: the model vanishes from `index.json`, or the daemon logs a default profile you didn't set. Diagnose with `cd ../gilde && node tools/build-index.mjs --verbose | grep <model>` → `skip … invalid-identity`. Fix: `pnpm gilde:export-schemas` (regenerates `gilde/schemas/*.schema.json` from core's Zod), then re-run `build-index`. This only bites campaigns that cross into framework territory (adding a family/behavior/format) — pure sampling/reasoning tuning never trips it. Wild-caught tuning laguna-s-118b: adding `style.family: "glm"` dropped all three quants from the 32-entry index until the schemas were regenerated.
- **Never overtune to a scenario's sniff.** The anchored-scenario rule from [docs/eval-strategy.md](../../../docs/eval-strategy.md): do NOT pick a temperature or force a behavior *because it makes `tankcombat`'s tank-vocab sniff fire*. Tune to the genuine capability, and verify the win across MULTIPLE scenarios of the same class. A lever that only moves one scenario's specific signal is overfit — it helps no real user and it's the same sin as hard-coding a sniff into a craftbook gate. The regression sweep (Phase 4) is your overfit detector: a real tuning win generalizes.
- **Never answer "use a bigger model."** If the flagship you're tuning still fails a scenario a medium model should pass, the finding is a *specific* lever or a *specific* framework gap — not a model-size recommendation. "This model can't" without a named lever or module is low-value work (eval-strategy.md's hard rule).
- **MLX drops half the sampling knobs** (`presencePenalty`, `frequencyPenalty`, `dry`, `xtc`, `grammar`, per-request `thinkingBudget`). Check the engine before proposing a lever — an MLX DRY fix silently no-ops. `thinkingBudget` on MLX has no effect; on llama-cpp it's a *launch* flag (`--reasoning-budget`), applied server-wide, so a change needs a fresh daemon (every eval trial spawns one, so it's automatic there).
- **Vacuous behavior A/B** — force-adding a declared behavior converges the arms (a control-vs-control null). `ab-prompt-conduct` throws on it; trust that, and lean on `--remove` for cataloged models.
- **Tier-default suppression (a real, common gap).** The moment a manifest declares its own `behaviors[]`, the ENTIRE tier-default set is suppressed — only the two universal defaults survive. So a cataloged small/medium model that lists, say, 15 behaviors but omits `prompt.retrieval-first` genuinely LACKS it, even though its tier would have granted it. Diff the manifest's `behaviors[]` against the tier defaults in [defaults.ts](../../../packages/service/src/model-profile/defaults.ts) for the model's tier — a missing tier-default behavior is a prime `--force` candidate (and NOT vacuous, so the A/B is valid). Wild-caught tuning gemma4-e4b-q4 (small tier, 15 declared behaviors, no `prompt.retrieval-first`): it walked 5 `readFile`s before one `search_code` and failed `tool-routing-retrieval` — the exact failure that behavior exists to prevent.
- **`score-trial` / relative paths run from `evals/`.** `pnpm --filter @bendyline/gezel-evals exec tsx src/bin/score-trial.ts <dir>` executes with cwd = `evals/`, so a repo-root-relative `evals/runs/...` path resolves to `evals/evals/runs/...` and throws `no result.json`. Pass an **absolute** path, or just read the per-trial **`facts.json`** the runner already wrote into every trial dir (it IS the `TrialFacts`) — no need to invoke `score-trial` at all for the scorecard.
- **Big-model economics.** A 122B MoE at low MLX t/s can take an hour+ per scenario. Even the 33 core model scenarios are an overnight run, and `eval:all` also includes the much larger generated craftbook registry. Budget accordingly, `run_in_background: true` always, and prefer a curated ≥10 set for a big-model campaign unless the user explicitly budgets for the live full registry.
- **Preflight is your friend.** If a model won't clear preflight, that's the highest-leverage fix in the whole campaign (a broken profile or unbounded thinking budget poisons every scenario). Fix it before the baseline, not after.
- **Determinism before trusting n=1.** Establish the model's run-to-run variance (re-run one scenario twice) before reading a single-trial A/B delta as signal; use `--count 3` or a pinned `seed` when the variance is real.
- **Two-layer manifest.** Tuning + behaviors live ONLY in the root `manifest.json`. The `versions/<v>/manifest.json` holds sources (HF repo/revision/sha) and is never touched for tuning. `build-manifest` (source-hash refresh) is non-lossy — it preserves `tuning`/`behaviors`/`evalHints` — so it's safe to run, but you don't need it for a tuning edit.

## Is this skill working?

A quick self-check without a full run: pick an already-tuned model and confirm the loop's plumbing.

```bash
# 1. Read a well-tuned reference model's block (proves the read path + shows a good target shape):
python3 -c "import json,glob; f=glob.glob('../gilde/data/chat-models/*/qwen3.6-27b-q4/manifest.json')[0]; m=json.load(open(f)); print('profiles:',list(m['tuning'].get('profiles',{}))); print('behaviors:',len(m['behaviors']))"
# expect: profiles thinking-general/coding/precise/instruct/creative; ~10 behaviors

# 2. Prove the vacuous-A/B guard fires (force a behavior the manifest already declares → should refuse):
pnpm --filter @bendyline/gezel-evals run ab-prompt-conduct --model qwen3.6-27b-q4 --force tools.mlx-grammar --scenarios tictactoe --count 1 2>&1 | grep -i "inert\|vacuous\|no-op" | head -1

# 3. Prove build-index picks up an edit (touch a comment-free field, rebuild, confirm index reflects it — then revert).
```

If the reference read returns the profiles/behaviors, the guard refuses the vacuous force, and `build-index` reflects an edit, the tuning loop's mechanics are sound — the rest is diagnosis + patience.
