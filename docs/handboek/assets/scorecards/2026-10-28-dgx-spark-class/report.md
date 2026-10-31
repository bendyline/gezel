# Scorecard: DGX Spark, 2026-10-28 run

This is the reviewed analysis behind the October 28–30 DGX Spark round on the model scorecard.

| | |
|---|---|
| Machine | DGX Spark (NVIDIA GB10, 122 GB unified memory), linux-arm64 CUDA |
| Engine | llama.cpp, native release 0.1.54 |
| Code | gezel 22fec991, plus the uncommitted `constrained-turn.ts` conditional-clause fix; gilde 0.3.1 pinned |
| Models | `qwen3.8-27b-q4`, `gemma4-12b-q4` |
| Suites | core, productivity, developer, complex-work |
| Trials | 3 per scenario, 258 in total |
| Run time | 2026-10-28 12:13 to 2026-10-30 15:31 PDT (Qwen 34.8 h, Gemma 16.0 h) |
| Judge | `claude-sonnet-4-6` through the Claude CLI: 121 trials judged; 137 not graded, because their task declares no rubric and produced no HTML page |

Files in this download:
- [trials.csv](trials.csv): one row per trial, with its fixed score, speed and judge mean
- [scorecard-details.json](scorecard-details.json): every trial's result, facts, metrics, fixed-score breakdown, judge report and review selection
- [scorecard.json](scorecard.json): the data the website's tables read
- [judging/judge-report.json](judging/judge-report.json): the judge sweep's ledger

## Headline

| Suite | Qwen 3.8 27b | Oct 12 Qwen | Gemma 4 12b | Gemma 4 12b, earlier |
|---|---|---|---|---|
| core | **33/33** | 33/33 | **32/33** | 31/33 (Aug 22, M4 Max) |
| productivity | **34/39** | 37/39 | **32/39** | 34/39 (Aug 22, M4 Max) |
| developer | **21/30** | 29/30 | **14/30** | first run |
| complex-work | **18/27** | 20/27 | **12/27** | first run |

Most of the headline drop is not about the models. Of Qwen's 18 developer and complex-work failures, 9 come from lockdown eval homes having no package scripts, 3 from author-gate-script (unpassable on Linux, defect 5), and 3 from harness stops while the task was still advancing (defects 3 and 4). Adjusted for the defects below:

| Suite | Qwen 3.8 27b, adjusted | Gemma 4 12b, adjusted |
|---|---|---|
| productivity | 34/36 | 32/36 |
| developer | 21/21 | 14/21 |
| complex-work | 18/21 | 12/24 |

How the adjustments were made:
- The three docblocks-theme-roundtrip trials are dropped from productivity.
- The nine test-run failures are dropped from developer.
- Complex-work drops author-gate-script for both models (unpassable on Linux), plus Qwen's two route-multi trials and one author-fanout trial that were stopped while still advancing.

## Developer suite: failure rate, with and without the tool-usage phase

A failure counts as tool-phase when the task stopped on a step whose gate requires a `commandEvidence` receipt, and `run_package_script` was never on that trial's tool surface. Since a626bf91 (2026-10-26, ADR 0028), lockdown turns off `allowPackageScriptExecution`, and eval homes run at lockdown. The steps involved:
- codemod-sweep verify/repair
- refactor-module baseline/verify/repair
- bug-fix-tdd reproduce/validate/repair

| Developer suite | Qwen 3.8 27b | Gemma 4 12b |
|---|---|---|
| Failure rate | 9/30 (30.0%) | 16/30 (53.3%) |
| Failure rate excluding tool-phase failures | **0/21 (0.0%)** | **7/21 (33.3%)** |
| Tool-phase failures | 9 | 9 |

The tool-phase jobs are the same for both models:

| Craftbook | Trials | Stopped at |
|---|---|---|
| bug-fix-tdd | 3/3 | reproduce, which needs an observed *failing* `npm run test` |
| codemod-sweep | 3/3 | verify |
| refactor-module | 3/3 | baseline, which needs an observed *passing* test run before any work |

On Oct 12, Qwen passed all three of these 3/3. In this run no model could pass them.

Gemma's seven failures that are not tool-phase are real (passes shown):
- dev-craftbook-routing 0/3
- deep-security-review 1/3
- large-pr-review 1/3

## Measurement defects found (harness and gezel were left unchanged during the run)

1. **Lockdown eval homes have no package scripts** (a626bf91). This explains every developer tool-phase failure above. Qwen's sessions recognised the cause and reported it plainly instead of faking a result; one wrote "I keep hitting the same wall" and named the blocker.

2. **docblocks-theme-roundtrip cannot pass** (be329eb5, 2026-10-27). The bundled DocBlocks toolset now joins only sessions running a craftbook or producing a binary deliverable. This scenario is a plain chat, so `infer_theme_from_file` is never on the tool surface. Both models correctly said the tool was missing. Result: 0/3 for each model, and the Qwen productivity drop from 37 to 34 is entirely this scenario.

3. **The route-multi harness counts step completions as failed repairs.** The scenario fails while the task "has status active". Each time a step session ends, the harness counts it as a "completed post-nudge file mutation despite byte-identical checked content", and it stops the trial after four.
   - In both Qwen failures the stepwise task was moving through its steps normally (`scope → draft → review → evaluate → finish`).
   - Trial `tpjx` was stopped 80 s after its final step, `finish`, began.
   - Trial `tof0` was stopped 2.5 min into `review`.
   - Oct 12's identical 1/3 is probably the same defect.
   - Gemma's single failure here is real: it never started the press-release recipe.

4. **author-fanout stopped while still working** (Qwen trial 3).
   - The recipe was correct and 3 of 4 per-store runs were done.
   - The fast-path retry loop stopped the trial after 8 minutes stuck at 3 of 4.
   - The engine was still serving the fourth shard: slot save/restore went on until 06:02:56, and the shard session transcript `ruslana` was cut off mid-turn.
   - The harness's own log says in the same minute that it held a nudge back because the session was "already working".

5. **On Linux, gezel cannot run gate scripts written by the model.** `node-executor.ts` runs untrusted scripts with `denyNet: true` plus an RPC channel. `runner.ts:158` turns off the Linux systemd boundary whenever an RPC channel is used, so `selectDenyNetBoundary` answers `unavailable` and the script fails closed with "denyNet requires an enforceable OS network boundary".
   - The probe itself succeeds on this machine (`systemd-run --user … RestrictAddressFamilies=AF_UNIX` exits 0); the gap is the RPC exclusion.
   - A perfect model cannot pass craftbook-author-gate-script on Linux. Oct 12's 0/3 (3 non-model failures) and today's single Qwen trial that reached a script run both hit it.
   - The other five gate-script failures stopped earlier for model reasons, before any script ran.

6. **The ingest's non-model classification is wrong for authoring scenarios.** `gate-unevaluable` is counted as `infra`.
   - Qwen gate-script `clit` failed because the model's own script rejected its `lowStockThreshold` input.
   - Gemma export-generalize `cnxc` failed on the model's own `checks[0]` configuration error.
   - In an authoring scenario the model wrote that gate, so these are model failures. The published table keeps the harness's classification, so both are set aside there.

7. **The judge grades the starting page on find-vs-create.** The default rubric takes the first `.html` in the workspace, which is the seeded shop page, not the model's work. Passing trials got 0.8/10 with "none of that happened". Those six trials, the one Gemma author-gate-script trial graded the same way, and docblocks-theme-roundtrip are left out of the judge section.

8. **`prose-as-deliverable` fires on progress summaries.**
   - All 23 Qwen hits are closing status reports to the person, written after `craftbook_write` or a task launch ("Done — here's what I set up…").
   - `FILE_WRITE_TOOLS` in score-trial omits `craftbook_write` and the other authoring and task tools.
   - Under the fixed rubric a red flag zeroes behavior soundness. That costs Qwen 0.6 on complex-work. Below, the composite is given both as computed and with this flag ignored.

9. **The petshop abort message says "corrupting" when the write was refused.** `tool-failure-tracker.ts:248/315` tells the model "re-emitting the whole file keeps corrupting it". In Gemma's failure every write was refused by the shrink guard (676 bytes against 5,921). Nothing was corrupted; the model was sending a fragment.

## Capability rubric (fixed 0–10; per-trial scores in [trials.csv](trials.csv))

| Model | Suite | Mean composite | Ignoring defect 8 | Bands (ship / tune / gap) |
|---|---|---|---|---|
| Qwen 3.8 27b | core | 9.7 | 9.7 | 33 / 0 / 0 |
| Qwen 3.8 27b | productivity | 9.0 | 9.0 | 34 / 4 / 1 |
| Qwen 3.8 27b | developer | 8.0 | 8.1 | 21 / 5 / 4 |
| Qwen 3.8 27b | complex-work | 7.2 | 7.8 | 18 / 9 / 0 |
| Gemma 4 12b | core | 9.6 | 9.6 | 31 / 1 / 1 |
| Gemma 4 12b | productivity | 8.9 | 8.9 | 32 / 6 / 1 |
| Gemma 4 12b | developer | 7.4 | 7.4 | 14 / 12 / 4 |
| Gemma 4 12b | complex-work | 7.0 | 7.0 | 12 / 13 / 2 |

Bands: ship-ready is 8 or more, needs-tuning is 5–7.9, framework-gap is under 5.

How the rubric axes were applied:
- **Completion:** 10 for success; 6 for repair-exhausted, meaning delivered and completed but below the bar; 3 or 0 for stalls by sniff progress.
- **Process efficiency:** interpolated between the rubric's anchor points at 11–19 calls (8), more than 30 calls inside the budget (3), and more than 90% of the budget (2).
- **Behavior soundness:** exactly two auto-answers scores 8.

Framework-gap trials, composite under 5:
- Qwen: the four developer tool-phase trials and the week-plan timeout.
- Gemma: petshop (4.5), three refactor-module and dev-craftbook-routing tool or routing trials, the ab-test-readout loop (3.7), and two complex-work stalls.

## Performance (separate from capability)

| | Qwen 3.8 27b | Gemma 4 12b |
|---|---|---|
| Decode tokens/s, median (p10) | 28.6 (23.1) | 76.3 (65.9) |
| Prefill tokens/s, median | 779 | 1,552 |
| First-turn time to first token, median | 15.8 s | 9.7 s |
| Peak GPU utilization, median | 96% | 96% |
| Peak system memory, max | 65.8 GB | 46.5 GB |
| Peak daemon RSS, max | 15.6 GB | 23.1 GB |
| Total trial wall-clock | 34.8 h | 16.0 h |
| Tokens (input / output) | 17.4 M / 1.99 M | 20.2 M / 1.94 M |

Compared with Oct 12, Qwen decode is unchanged (30.1 then; 28.9 in this run's admission probe) and prefill rose 13% (699 to 791). Qwen's shorter complex-work trials are therefore not engine speed: edit-midtask fell from 47 to 17 min and export-generalize from 31 to 18 min because the trials took fewer turns. Developer was slower overall (350 to 725 min), because the tool-phase trials looped for about an hour each before being stopped.

Gemma 4 12b is the first sub-15B model with a full four-suite record on this machine. It runs 2.7× faster at decode and finishes the four suites in 46% of Qwen's wall-clock.

## Qualitative judge (advisory; does not change the composite)

Means exclude the trials listed under defect 7. The website's review tables select differently: they keep each rubric in its own column, include docblocks-theme-roundtrip under its own rubric, and leave out the A/B readout reviews, whose declared rubric (safety, mapping, signals, containment) was written for a runbook.

| Model | Suite | Judged | Mean | Passing trials | Failing trials |
|---|---|---|---|---|---|
| Qwen 3.8 27b | core | 9 | 8.2 | 8.2 | – |
| Qwen 3.8 27b | productivity | 24 | 8.4 | 8.3 | 9.0 |
| Qwen 3.8 27b | developer | 18 | 7.9 | 8.8 | 7.0 |
| Qwen 3.8 27b | complex-work | 3 | 6.5 | 6.5 | – |
| Gemma 4 12b | core | 9 | 6.9 | 6.9 | 7.0 |
| Gemma 4 12b | productivity | 24 | 7.2 | 7.2 | 7.4 |
| Gemma 4 12b | developer | 18 | 5.5 | 7.3 | 4.3 |
| Gemma 4 12b | complex-work | 3 | 4.9 | 4.9 | – |

Across all judged trials, passing trials average 7.7 and failing trials 6.0. The judge separates the models more sharply than pass rates do: Qwen leads by 1.2–2.4 points in every suite. On the three anchored games it rates Qwen 8.3 and Gemma 6.9.

Where the judge and the gates disagree:
- **Failing trials judged 7 or higher.** These are tool-phase failures (Qwen codemod-sweep 7.3–7.7, refactor-module 7.0–7.7), Gemma's research-to-document (8.7; the judge reads the report text and cannot see that `report.docx` is not a ZIP) and Qwen's week-plan timeout (9.0). In each case the deliverable was good and a gate or process requirement failed.
- **Passing trials judged under 5.** Gemma invoice-run (3.8): "no actual invoices were produced — only a summary report". The judge only sees one artifact, so this may be an artifact-selection limit. It is worth one look before trusting invoice-run's gate.

## Positives

- **Core is solid.** Qwen 33/33 (`outcome.success` in every core trial). Gemma 32/33, and its median core trial takes 1.15 min (`outcome.durationMs`).
- **Qwen held or improved on everything not hit by a defect:**
  - deep-security-review 2/3 → 3/3, export-generalize 2/3 → 3/3, week-plan 1/3 → 2/3.
  - api-contract-review, code-review, large-pr-review, interface-contract and fix-squisq-bugs all stayed 3/3.
- **Qwen is honest when blocked.** In the tool-phase trials and the week-plan pause it wrote plain blocker reports (`toolUse.redFlags[*].argsSummary` previews) instead of claiming to be done.
- **Gemma does well on the structured productivity work:** spreadsheet-model, powerpoint-deck, annotated-bibliography, meeting-followup and records-intake are all 3/3, and week-plan 3/3 beats Qwen.
- **No real red flags for Qwen.** Every flag is the defect-8 false positive. Gemma had one: `empty-question` on refactor-module.

## Negatives

- **Gemma does not route to library recipes.**
  - dev-craftbook-routing 0/3: it called `suggest_work` three times in trial `ux7q`, then wrote its own recipe with `craftbook_write`.
  - It missed find-vs-create once and route-multi once in the same way.
- **Gemma drifts from schemas on structured output.**
  - deep-security-review wrote `findings.json` with `"line": "3, 6"`, and left out `line` in another trial. The plateau rule ended it after 6 repairs: each fix broke another field.
  - large-pr-review listed 121 or 89 paths when the PR changes exactly 120.
  - ab-test-readout re-sent an identical `stats.json` that was missing `control.rate`.
- **Gemma writes text to binary paths.** In research-to-document 1/3 it used `write_file` to put text into `report.docx`, even though `convert_document` and `save_artifact` were on the tool surface.
- **Gemma repeats an identical refused write.** In petshop it sent the same 676-byte `write_file` five times against the shrink guard.
- **Both models are weak at authoring craftbooks:**
  - author-fanout 0/3 each. Two Qwen trials and one Gemma trial wrote fixed per-store steps instead of a fanout.
  - author-gate-script 0/3 each. Defect 5 blocks it on Linux regardless.
  - Gemma export-generalize 0/3, with two 300 s chat stalls where the model ended its turn and ignored the re-engage nudge.
- **Qwen author-linear dropped to 2/3.** One fast-path retry loop: three rewrites with no sniff movement.

## Tactical fixes (parameter and prompt)

- **Refused writes:** in `packages/core/src/local-loop/tool-failure-tracker.ts` (lines 248 and 315), branch on the shrink-guard refusal text ("Refusing to replace … much shorter"). Replace "keeps corrupting it" with "your write was refused: it would cut `<path>` from N to M bytes, so your content is a fragment. Change only the part you meant with `replace_lines`." Also cap identical-argument refusals at 2, not 5. Justified by Gemma petshop, where `failureMode` was `repair-aborted` after 5 byte-identical refused writes.
- **Recipe routing for small models:** add a model-profile behavior in `packages/service/src/model-profile/behaviors/`, on by default for the small tier in `packages/inference/src/model-profile/defaults.ts`. When `suggest_work` returned a library match this turn, the next action must be `invoke_craftbook` with that id; `craftbook_write` is acceptable only after the person declines it. Justified by Gemma dev-craftbook-routing 0/3, where `suggest_work` was called before `craftbook_write`.
- **Findings schema in the step prompt:** in gilde `data/craftbook-templates/de/deep-security-review/versions/1.1.4/craftbook.json`, put a literal one-record example with `"line": <integer, first line>` into the findings step prompt, and keep the gate's message naming the field. Justified by Gemma 1/3, plateau on `line`.

## Strategic fixes (framework)

1. **Run evals at the security level the scenario needs, not blanket lockdown.** `evals/src/runner.ts` (security block around lines 1250–1283) should give the developer craftbook scenarios a preset with `allowPackageScriptExecution: true` and keep everything else at lockdown. A scenario-level `securityLevel`, or a `packageScripts: true` capability, beats a global switch. Restores 9 trials per model.
2. **Give Linux a network boundary for script RPC runs.** In `runner.ts:158`, `!opts.rpcChannel` turns off the systemd boundary for every model-authored script on Linux. `systemd-run --pipe` carries stdio, which is what the stdio RPC needs; the Windows MXC lane already uses stdio-RPC under a container. Until that lands, gate scripts written by the model fail closed on every Linux install, which is a product gap, not just an eval one.
3. **Make the harness's repair counter aware of tasks.** In the route-multi family, a step session's turn ending while the task advanced (a new `resolved step` since the last nudge) should not count as a repair attempt. The fanout stall-path should likewise defer while a shard session is mid-turn, as the nudge path already does.
4. **Fix the eval measurement defects:**
   - In `evals/src/trial-llm-judge.ts`, skip the default-html judge when the scenario's deliverable is not HTML, or give find-vs-create a `judge` spec.
   - Add `craftbook_write`, `save_artifact`, `convert_document` and the task-launch tools to `FILE_WRITE_TOOLS` in `score-trial.ts`, or exempt summaries written after a successful write or launch.
   - In authoring scenarios, classify `gate-unevaluable` as `model` in the ingest's failure-class rule.
5. **Give the Office deliverable a guard as well as a tool.** Extend `rasterImageWriteRefusal` (`packages/mcp/src/server.ts:2189`) to `.docx`, `.pptx` and `.xlsx`, pointing to `convert_document` and `save_artifact`. A small model that writes text to a binary path should be told why at the moment it happens, as raster images already are.
6. **Restore DocBlocks for plain-chat DocBlocks work.** Either `bundledDocblocksJoinsSession` should admit a session whose turn names a DocBlocks capability, or docblocks-theme-roundtrip should start through a craftbook. Decide which before the next productivity run, or the scenario stays at 0 for every model.

## Strategic check against Oct 12

- **No model regression shows up for Qwen 3.8 27b** once the defects are removed:
  - developer was 29/30 and is 21/21;
  - productivity was 37/39 and is 34/36;
  - complex-work matches or beats Oct 12 on 7 of 9 scenarios.
- **author-fanout fell from 2/3 to 0/3.** It is the one place with a real signal: one trial is defect 4, and two are real authoring misses.
- **route-multi's 1/3 on both dates** is most likely the same harness artifact, not a stable model ceiling.
- **Gemma 4 12b has no earlier developer or complex-work baseline.** Its core and productivity results match its Aug 22 M4 Max run within one trial.

## Next experiment

Fix defects 1, 3 and 7 in the harness, which is cheap and touches no model behavior. Then re-run only the affected cells, 3 trials each, on this Spark:
- developer: bug-fix-tdd, codemod-sweep, refactor-module;
- complex-work: route-multi, author-fanout.

That gives a clean developer number for both models and settles whether route-multi and author-fanout are real. Then try the recipe-routing behavior as an A/B on Gemma 4 12b: dev-craftbook-routing, find-vs-create and route-multi, 3 trials per arm.
