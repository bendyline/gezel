# Device scorecard — native 0.1.54

**Completed all 258 planned attempts, with all declared artifact reviews accounted for.** Native execution finished October 30, 2026 at 09:25 PDT. The independent audit passed: 258 unique cells, three repetitions per model/suite/scenario entry, 119 artifact judgments covering 125 produced paths, and no pending reviews. These are 258 recorded attempts, not 258 clean measurements of model capability. Two raw infrastructure exclusions and one additional admission-blocked attempt are explained below.

Qwen was more reliable on the original baseline: **65/84 eligible passes, fixed mean 8.04**, versus **52/84 and 7.66** for Gemma. Gemma was faster: median decode **66.15 versus 26.44 tokens/s** (about 2.5×), and median trial duration **330.50 versus 602.26 seconds**. The later no-OS-sandbox treatment gives **30/43, 7.77** for Qwen and **30/45, 7.71** for Gemma under raw eligibility. Its smaller, differently composed samples and the admission issue do not establish an overall winner.

Core and productivity are the strongest fixed-score areas for both models. Qwen leads developer pass counts in both treatments, while diagnostic review shows that some passing developer and productivity gates still accept incomplete or incorrect work. Complex-work authoring remains the main reliability gap for the combined model/framework system. The actionable next step is to improve execution admission, authoring interfaces, and semantic validation before tuning model-specific sampling.

[All 258 trials (CSV)](overall-trials.csv) · [Per-scenario repetitions](scenario-comparison.md) · [Machine-readable comparison](overall-scorecard.json) · [Final coverage audit](final-coverage-audit.md)

## Setup and preserved baselines

Qwen 3.8 27B Q4 (`qwen3.8-27b-q4`) and Gemma4 12B Q4 (`gemma4-12b-q4`), llama-cpp/CUDA, generalist auto. Exactly core, productivity, developer and complex-work: 43 suite entries / 41 distinct scenarios × two models × three repetitions. Shared scenarios were evaluated separately for each suite. No recorded cell was retried and no cancelled-campaign scores were reused.

Native release **0.1.54** was freshly downloaded and SHA-256 verified before the original campaign; [native-install.log](scorecard-details.json) records installation. Source/build/catalog/model fingerprints stayed frozen at clean commit `22fec99111a5ad9796af83a4a1a222236be91006`. Hardware: Windows ARM64, NVIDIA RTX Spark N1X (20-core CPU, 6144-core Blackwell GPU); the harness reports 23 GB system RAM and 40,960 MB GPU memory. These are the runtime-visible memory domains. CUDA build 11669, upstream `620d2225cc436ab0b001e3200e590e3b286ef9ab`, toolkit 13.4, architecture 121a, driver 621.01.

| Segment | Treatment | Recorded | Raw eligible | Qwen pass / eligible | Gemma pass / eligible |
|---|---|---:|---:|---:|---:|
| original | Original | 169 | 168 | 65/84 | 52/84 |
| continuation | No OS sandbox (C + F) | 83 | 82 | 30/40 | 29/42 |
| final-six | No OS sandbox (C + F) | 6 | 6 | 0/3 | 1/3 |

The parent and first continuation stopped journals are preserved byte-for-byte. The user authorized running only previously unstarted cells in separate segments. Continuation and final-six share the same authorized profile: `GEZEL_MXC=off` and a byte-identical campaign-local hook removing only the script OS-boundary requirement; Node permissions, capabilities and timeouts remained. Actual daemon override fingerprints match the recorded original and loaded service hashes. Control/enabled probes, including filesystem denial, passed. Their source, runtime, catalog, models and environment match; only campaign-local metadata differs. **Only these two equivalent-treatment segments are combined below**, explicitly as C + F. The original baseline remains separate. [Identity equivalence](scorecard-details.json) · [Final identity audit](scorecard-details.json)

## Fixed capability and advisory quality

Fixed capability uses the frozen rubric: completion 40%, output quality 25%, efficiency 20%, behavior 15%. It measures observed gates and process facts; a high score does not override a semantic defect found in review. Values below use raw aggregate eligibility. Advisory scores are separate, scenario-specific 0–10 judgments with integer axes and bounded artifact review. Means use one primary judgment per reviewed cell; extra artifacts remain in the evidence. Missing artifacts are noArtifact, not zero scores.

| Treatment | Model | Suite | Pass / eligible | Raw excluded | Fixed mean /10 | Advisory raw mean (n) | Applicable advisory mean (n) |
|---|---|---|---:|---:|---:|---|---|
| Original | Qwen | core | 21/22 | 0 | 9.20 | 5.92 (6) | 5.92 (6) |
| Original | Qwen | productivity | 22/26 | 0 | 8.65 | 5.40 (18) | 5.92 (16) |
| Original | Qwen | developer | 12/20 | 0 | 7.15 | 5.33 (12) | 5.33 (12) |
| Original | Qwen | complex-work | 10/16 | 1 | 6.54 | 5.70 (2) | 5.70 (2) |
| Original | Gemma | core | 17/22 | 0 | 8.56 | 4.50 (6) | 4.50 (6) |
| Original | Gemma | productivity | 22/26 | 0 | 8.75 | 4.56 (18) | 4.97 (16) |
| Original | Gemma | developer | 8/20 | 0 | 6.67 | 3.56 (12) | 3.56 (12) |
| Original | Gemma | complex-work | 5/16 | 0 | 5.88 | 5.10 (2) | 5.10 (2) |
| No OS sandbox (C + F) | Qwen | core | 10/11 | 0 | 9.10 | 5.83 (3) | 5.83 (3) |
| No OS sandbox (C + F) | Qwen | productivity | 11/13 | 0 | 8.41 | 6.51 (8) | 7.26 (7) |
| No OS sandbox (C + F) | Qwen | developer | 6/10 | 0 | 7.35 | 5.83 (6) | 5.83 (6) |
| No OS sandbox (C + F) | Qwen | complex-work | 3/9 | 1 | 5.71 | 7.40 (1) | 7.40 (1) |
| No OS sandbox (C + F) | Gemma | core | 10/11 | 0 | 9.10 | 4.75 (3) | 4.75 (3) |
| No OS sandbox (C + F) | Gemma | productivity | 11/13 | 0 | 8.52 | 5.31 (9) | 5.82 (8) |
| No OS sandbox (C + F) | Gemma | developer | 4/10 | 0 | 6.48 | 3.93 (5) | 3.93 (5) |
| No OS sandbox (C + F) | Gemma | complex-work | 5/11 | 0 | 6.46 | 6.20 (1) | 6.20 (1) |

The A/B-report scenario declares HTML axes but produces Markdown: nine artifact judgments across six primary cells are marked rubric-mismatched. Literal scores remain in the raw column; applicable means omit only those six primary cells. Advisory means mix different axes and output types and should not be treated as a second universal leaderboard. Review coverage is 112 judged cells, two missing declared artifacts, and 144 without declared axes. All six final cells fall in the last category; their outputs received diagnostic review without invented quality scores.

## Infrastructure and classification limits

1. **Original Qwen r2 author-gate-script:** the Windows sandbox launcher existed on the machine, but the isolated trial home/cache could not resolve it. The statement that the machine lacked an installed launcher was too broad. This is the original raw infrastructure exclusion, not a model failure.
2. **Continuation Qwen r3 export-generalize:** the model authored a recipe using undefined `workPath`; the harness classified the resulting gate as unevaluable/infrastructure before the final stall. Its authoring origin is documented in [the stop review](scorecard-details.json). The raw exclusion and 3.8 score remain unchanged.
3. **Final Gemma r3 author-fanout:** raw model-default FAIL/3.5 is misleading as a capability measurement. No inference began. The daemon repeatedly waited for 12.1 GB while a preceding Qwen claim reserved 34.1 GB of 38.0 GB safe capacity. The read-only shared-ledger snapshot identifies that claim; all involved processes had exited by the final check. Their exact earlier exit times are not established. This is an additional diagnostic infrastructure issue beyond the two raw exclusions. [Capacity evidence](scorecard-details.json)

Sensitivity views below change only analytical inclusion, never the raw journals, classifications or fixed scores. They concern the C + F treatment only.

| Inclusion view | Qwen pass / n; fixed mean | Gemma pass / n; fixed mean |
|---|---|---|
| Raw fixed eligibility | 30/43; 7.77 | 30/45; 7.71 |
| Exclude Gemma admission-blocked attempt | 30/43; 7.77 | 30/44; 7.80 |
| Also include Qwen authoring-origin raw exclusion as a failure | 30/44; 7.68 | 30/44; 7.80 |

Two structured CUDA-error incidents occurred during Gemma trials (r2 edit-midtask and r3 author-params). Both trials ultimately passed their deterministic gates. Native logs identify CUDA unknown-error failures; their deeper cause is unproven. Qwen stalls often coincided with large cache checkpoint writes, but this is correlation, not evidence that caching caused them. No extra retries or native changes were introduced.

## Performance and sample coverage

Medians use raw-eligible attempts within each separately journaled segment. Duration includes orchestration and waits. First action is the first observed tool call; first artifact can be supporting work rather than the final deliverable. Decode/prefill are real engine-log rates, not output tokens divided by task duration. Input/output totals are engine counters, not billing. Memory values are sampled per-trial peaks; system RAM and GPU memory are distinct reported domains. Available/eligible counts and unavailable cell IDs are in the JSON for every field, model and suite.

| Segment | Model | Eligible | Duration s | First tool / artifact s | Calls | Engine input / output tokens | Decode / prefill t/s | RSS / GPU / system RAM MB |
|---|---|---:|---:|---|---:|---|---|---|
| original | Qwen | 84 | 602.26 | 51.90 / 153.90 | 15.00 | 47641.00 / 7816.50 | 26.44 / 577.69 | 8961.50 / 36300.00 / 19203.00 |
| original | Gemma | 84 | 330.50 | 33.66 / 56.39 | 16.00 | 75443.00 / 8656.00 | 66.15 / 1255.63 | 11496.50 / 13574.00 / 21901.50 |
| continuation | Qwen | 40 | 450.24 | 51.01 / 127.92 | 13.00 | 44580.00 / 6939.50 | 29.02 / 617.87 | 7765.50 / 36174.50 / 19818.50 |
| continuation | Gemma | 42 | 310.63 | 37.69 / 63.66 | 16.50 | 71308.50 / 6534.50 | 70.22 / 1302.85 | 10280.00 / 13394.50 / 22570.00 |
| final-six | Qwen | 3 | 962.41 | 74.98 / 727.09 | 16.00 | 67517.00 / 9689.00 | 22.86 / 518.50 | 5735.00 / 36033.00 / 19970.00 |
| final-six | Gemma | 3 | 788.71 | 42.91 / 467.32 | 30.00 | 159567.50 / 21609.50 | 62.89 / 1142.62 | 10184.00 / 13392.00 / 22801.00 |

Across all 258 attempts, duration/calls/RSS/GPU memory/GPU utilization/system RAM are populated for **258/258**; first action for **257/258**; first artifact for **240/258**; real engine input/output/decode/prefill for **257/258**. The final Gemma admission-blocked attempt has raw HTTP 0/0 counters in an unrelated provider bucket, not measured local-model token usage. The analytical JSON/CSV mark those tokens unavailable. Its 0% GPU utilization and small memory readings describe a waiting daemon and ambient device state. The final Gemma token medians therefore use two engine-measured samples, unlike the earlier computed draft.

The continuation [performance supplement](scorecard-details.json) records Qwen large-PR coverage-write timing (603.141 seconds) separately; its raw first-artifact null is preserved. Performance-coverage files emitted earlier use their original collector rules; the [final audit](final-coverage-audit.md) is authoritative for local-engine availability. Comparisons are descriptive: sample mixes differ and failures may terminate early or consume watchdog budgets.

## Final six: output and failure review

| Model | Scenario | Raw outcome / fixed score | Diagnostic result |
|---|---|---|---|
| Qwen | author-params | FAIL / 6.0 | Correct region/workPath tokens and two invocations, but both compute steps stayed active and no summary was written. Metadata satisfied 5/7 checks despite the missing deliverable. |
| Gemma | author-params | PASS / 8.5 | Semantic false positive: both summaries contain incorrect totals and omit the leading salesperson; invoked recipe versions stayed active while a newer catalog version satisfied structural checks. A CUDA incident also occurred. |
| Gemma | author-gate-script | FAIL / 5.2 | Five YAML submissions rejected by the JSON authoring tool; ad-hoc task and script files did not become a reusable recipe with an executable gate. Inventory report counted 9 items instead of 10. |
| Qwen | author-gate-script | FAIL / 4.2 | Read/search loop, 16 calls, no authored recipe, script or task. Watchdog recovery queued behind an in-flight turn; cache activity alone does not explain the stall. |
| Qwen | author-fanout | FAIL / 3.8 | Single looping draft step, no actual data-driven child fanout. Three of four reports exist; Harbor write was rejected for turning 41 days into more than six weeks and never repaired. |
| Gemma | author-fanout | FAIL / 3.5 raw; admission blocked | No inference, tools or output: waiting for capacity reserved by the preceding Qwen claim. Keep raw model-default score but exclude it in a separate diagnostic sensitivity. |

Gemma author-params is the clearest false-positive gate: its north summary reports 1,376 units / 52,195 revenue instead of **1,298 / 47,847.95**; south reports 2,481 / 81,990 instead of **2,270 / 83,990**. Both omit the required top salesperson. The initial invoked recipe used literal `<region>` paths; a later catalog version used proper interpolation while old tasks remained active. The gate could combine the new template, old invocation IDs and sufficiently long output files without checking arithmetic or completed executions. This is not successful parameterized analysis despite PASS/8.5. [Artifact and arithmetic evidence](scorecard-details.json)

Qwen fanout produced three reports with correct source counts/audit ages, but its recipe lacked actual child fanout and Harbor never landed. Its two prose-as-deliverable flags were triggered by progress summaries even though artifacts existed, so the behavior-zero penalty may be overbroad; the structural and missing-output failures remain real. Gate-script diagnostics also expose skipped dependent checks that can raise sniff fractions when a recipe is absent. Raw scores are retained rather than retroactively repaired.

[Final-six diagnostic findings](scorecard-details.json) · [Params review](scorecard-details.json) · [Gate-script review](scorecard-details.json) · [Fanout and admission review](scorecard-details.json)

## Representative findings across the full run

- **Developer execution and correctness:** package scripts were blocked by the execution policy despite installed tools. Qwen codemod produced the intended renames but lacked execution proof; Gemma broke imports. Bugfix/refactor cases could satisfy weak gates with an unchanged or reverted defect. Developer pass counts must be read alongside these artifact findings, not as verified test execution.
- **Productivity semantics:** some invoice passes omitted ledger updates or introduced tax/currency assumptions. Week-plan failures included Qwen missing output and Gemma incorrect dates/write-before-read behavior. Structural completeness is not sufficient for source-grounded office work.
- **Review coverage:** Qwen security review identified the seeded issues more completely than Gemma in the inspected comparison. Qwen large-PR work stalled without a final report; Gemma inspected only 13/120 items while claiming complete coverage. API comparisons could pass while missing seeded changes.
- **Tool and workflow surfaces:** DocBlocks tools were absent in relevant runs; petshop role assertions could fail despite real generated images. Authoring repeatedly confused YAML documentation with a JSON write API, new recipes with ad-hoc tasks, and a loop with real fanout. These are concrete framework/interface opportunities, not proof of a model-size ceiling.

Detailed per-cell evidence and 33 continuation findings are in [continuation failure attribution](scorecard-details.json); original findings and qualitative justifications are linked below. These analyses preserve model-origin mistakes, framework gaps, evaluator weaknesses and infrastructure failures as distinct explanations.

## Separate prior-run comparisons

The earlier repetitions are the relevant prior runs on this frozen source/native baseline. O, C and F remain explicitly identified; no samples are averaged across different treatments. No cancelled-campaign data is used. These comparisons reveal recurrence, not a controlled causal estimate of removing the OS boundary.

| Model / scenario | Repetition 1 | Repetition 2 | Repetition 3 |
|---|---|---|---|
| Qwen / craftbook-author-params | [O: P 7.0](scorecard-details.json) | [O: P 8.5](scorecard-details.json) | [F: F 6.0](scorecard-details.json) |
| Gemma / craftbook-author-params | [O: F 5.4](scorecard-details.json) | [O: F 5.1](scorecard-details.json) | [F: P 8.5](scorecard-details.json) |
| Qwen / craftbook-author-gate-script | [O: F 4.2](scorecard-details.json) | [O: X 3.7](scorecard-details.json) | [F: F 4.2](scorecard-details.json) |
| Gemma / craftbook-author-gate-script | [O: F 5.2](scorecard-details.json) | [C: F 3.0](scorecard-details.json) | [F: F 5.2](scorecard-details.json) |
| Qwen / craftbook-author-fanout | [O: F 1.6](scorecard-details.json) | [C: F 4.1](scorecard-details.json) | [F: F 3.8](scorecard-details.json) |
| Gemma / craftbook-author-fanout | [O: F 2.6](scorecard-details.json) | [C: F 5.0](scorecard-details.json) | [F: B 3.5](scorecard-details.json) |
| Qwen / craftbook-author-linear | [O: F 4.6](scorecard-details.json) | [O: F 4.1](scorecard-details.json) | [C: F 3.5](scorecard-details.json) |
| Gemma / craftbook-author-linear | [O: F 4.6](scorecard-details.json) | [O: F 4.1](scorecard-details.json) | [C: F 4.6](scorecard-details.json) |
| Qwen / schema-migration | [O: P 9.5](scorecard-details.json) | [O: P 9.5](scorecard-details.json) | [C: P 9.5](scorecard-details.json) |
| Gemma / schema-migration | [O: P 10.0](scorecard-details.json) | [O: P 9.5](scorecard-details.json) | [C: P 9.5](scorecard-details.json) |

Qwen parameter authoring passed earlier repetitions but failed to complete the final one; Gemma’s final apparent improvement is undermined by the arithmetic and task-version defects. Gate-script authoring continued to fail after the launcher requirement was removed, so that requirement was not its sole problem. Fanout repeatedly failed structurally; the last Gemma sample says nothing about its fanout ability because admission blocked inference. All six linear-authoring repetitions failed, while the unrelated schema-migration runs passed for both models, showing that these failures are not a blanket inability to handle structured work.

## Next experiments after this frozen comparison

1. **Repair admission handoff and attribution.** Inspect [device-capacity-ledger.ts](scorecard-details.json) for process identity/liveness and dead-child lease cleanup. Reproduce Qwen shutdown → Gemma admission with deterministic processes, then teach [failure-class.ts](scorecard-details.json) to classify no-model-start waits separately from model stalls. Do not simply lower the memory reserve.
2. **Make semantic gates trustworthy.** In [author-params.ts](scorecard-details.json), require completed invocations of the inspected recipe version and independently computed source totals/top salesperson. In [gate-script.ts](scorecard-details.json), make missing prerequisites explicit failures rather than skipped successes. Apply the same invariant to unrelated data/reporting scenarios before claiming an improvement.
3. **Clarify authoring and repair tools.** Expose schema-valid JSON examples, actual fanout structure and task-repair operations through the shared authoring/tool documentation. Review [role-tool-filter.ts](scorecard-details.json) for missing tool/role surfaces. Validate across linear, parameterized, fanout and an unrelated workflow; avoid scenario-specific model hints.
4. **Strengthen provenance and execution receipts.** Review [source-write-guard.ts](scorecard-details.json) so reading a source cannot substitute for correcting rejected arithmetic. Make developer reports distinguish blocked commands from successful execution, with receipts where authorized. Regression-check invoice, review and coding tasks.
5. **Isolate stalls before sampling changes.** Instrument [llama provider](scorecard-details.json) and [cache adapter](scorecard-details.json) to measure turn queue, checkpoint and shutdown latency. Reproduce CUDA incidents separately. Only then A/B one model-behavior lever at a time across two diverse failing tasks plus a passing control. Current evidence does not justify a guessed temperature or cache fix.

No runtime, catalog, source or dependency fixes were made during this frozen comparison. The proposed work is separate from completion of this trial.

## Evidence and limitations

- **original**: [fixed report](scorecard-details.json) · [qualitative report](scorecard-details.json) · [inline judgments](scorecard-details.json) · [coverage](scorecard-details.json) · [diagnostic findings](scorecard-details.json)
- **continuation**: [fixed report](scorecard-details.json) · [qualitative report](scorecard-details.json) · [inline judgments](scorecard-details.json) · [coverage](scorecard-details.json) · [diagnostic findings](scorecard-details.json)
- **final-six**: [fixed report](scorecard-details.json) · [qualitative report](scorecard-details.json) · [inline judgments](scorecard-details.json) · [coverage](scorecard-details.json) · [diagnostic findings](scorecard-details.json)

Each trial retains result, score, facts, metrics, host and postmortem files. [The independent audit](scorecard-details.json) recomputed every weighted score and verified all declared-artifact coverage, judgment bounds/hashes and preserved journal identities. [All scenario repetitions](scenario-comparison.md) link individual postmortems.

Three repetitions overall do not provide three observations per execution treatment; many segment/scenario groups have n<3. Gate semantics, blocked scripts, source-only qualitative review, rubric mismatch, missing telemetry, native incidents and admission failure limit model-quality inference. Advisory review is bounded to 20 KiB per artifact and is not a complete interactive UX audit. Original and no-OS-sandbox results must remain separate in downstream summaries. The final six are included in the 258-cell accounting, with no attempt hidden or retried.


Publication note: individual evidence and postmortem links open the bundled scorecard-details.json, which preserves the original archive references. The raw analytical scorecard keeps the final Gemma admission attempt eligible; product tables apply the documented infrastructure attribution correction.
