# Task strategies — pre-registered benchmark (2026-10-22)

Written before any trial of this experiment ran. The analysis follows this
file; anything decided after the data arrives is labeled post hoc. Design
background: [task-strategies.md](../task-strategies.md).

## Question

Per model tier, does running a craftbook as `generalist` (one owner, one
session, every step's tools, the recipe enforced step by step) or as
`outcome` (one owner held only to the book's contract, the recipe as advice,
teammates available) deliver results at least as good as `stepwise`, at no
greater cost? `auto` changes for a tier only if one of them qualifies under
the rule below.

## Design

| | |
|---|---|
| Books | 18, each with a contract in gilde: research-report, powerpoint-deck, corpus-synthesis, market-scan, content-accuracy-review, engineering-retrospective (research/doc); bug-fix-tdd, refactor-module, codemod-sweep (code); ab-test-readout, cohort-analysis, data-quality-audit, csv-transformer (data); alert-rules, runbook, press-release (ops/comms); invoice-run, html-arcade-game (multi-artifact) |
| Pilot books | research-report, powerpoint-deck, content-accuracy-review, bug-fix-tdd, codemod-sweep, ab-test-readout, data-quality-audit, alert-rules, invoice-run, html-arcade-game |
| Models | tiny: gemma4-e4b; small: qwen3.5-9b (ornith-1.5-9b if it cannot be installed); medium: qwen3.8-27b; large: nemotron-3.5-super-vl; cloud reference: Claude through the CLI provider |
| Arms | `stepwise` (control), `generalist`, `outcome`. The pilot adds `outcome-solo` (no teammates) and `outcome-bare` (no recipe) |
| Replicates | pilot: 1 on medium and tiny. Full run: 2 per tier, 3 on medium |
| Order | models outer, then replicate, then book; arm order rotates by replicate and book (`armOrder`) |
| Harness | `pnpm eval:ab-strategy`: workflow mode, `repairPolicy: runtime`, the product's task description, the same worker gezel, `GEZEL_DISABLE_TIER_COLLAPSE=1` |
| Timeouts | the same hard cap for every arm: 45 min tiny/small, 60 medium, 75 large; no reruns at a longer cap |
| Content | the gilde checkout with the contracts (`GEZEL_GILDE_DATA_DIR`), its commit recorded in the summary |
| Code | the git sha recorded in the summary, plus a sha256 of `git diff HEAD` |

The unit is a pair: (model, book, replicate), one trial per arm, compared
with the stepwise trial of the same unit.

## Endpoints

- **P1 (binary):** the test's result checks passed with the task finished,
  and every acceptance criterion of the contract passed. The test's process
  files (what the recipe's own steps write that the contract does not
  declare) are not judged.
- **P2 (primary, continuous):** the share of checked items that passed: the
  contract's gate and eval-only criteria plus the test's result checks.
- **P3:** blinded judge score, 0–10 on four axes (fitness to the request,
  completeness against the contract, grounding in the sources, craft), three
  samples per trial, plus pairwise win rate. The judge is pinned
  (claude-opus-5-5, high effort, structured output); deliverables are blinded
  (paths, step names, verdict files and task notes removed) and sent with the
  sources. A second judge reads 25% of trials. The judge must pass in the
  pilot before the full run: test-retest SD ≤ 0.7, ≥ 90% of planted defects
  caught, inter-judge α ≥ 0.6.
- **Cost:** median wall time; decode and uncached prompt tokens; tool calls;
  teammate consultations; gate rejections; failure mode.

## Analysis

Per tier: paired deltas for generalist − stepwise and outcome − stepwise
(and outcome − generalist). P2 and P3 intervals are 95% percentile
bootstraps that resample books (trials of one book share its difficulty).
P1 uses the exact McNemar test on discordant pairs, Holm-adjusted within
each tier. Per-class figures are descriptive only.

## Decision rule

`auto` at tier T picks strategy X (generalist or outcome) only if all hold:

1. P2 lower bound > −0.05.
2. P3 lower bound > −0.5.
3. P1, pooled across tiers, lower bound > −10 percentage points.
4. Median wall-time ratio ≤ 1.0, or ≤ 1.25 when X is significantly better on
   P2 or P3.
5. No failure mode appears in ≥ 2 X trials and 0 stepwise trials.

If both qualify, the cheaper one unless quality differs significantly.
Otherwise stepwise stays.

## Power and stopping

36 units per tier (54 on medium) target non-inferiority on P2 and P3; P1 alone
is underpowered and reported descriptively. The pilot's measured SDs replace
these assumptions before the full run. One interim look at 50% of the full
run, stopping a tier for futility when `pairsNeeded` for the margin exceeds
three times the planned units.

## Exclusions

An infrastructure failure (engine crash, harness error, network) is rerun
once, then dropped and reported. A timeout counts as a failure.

## Known differences between arms, accepted

- Gate budgets differ by construction: one contract gate against a gate per
  step. Each trial's rejections are recorded.
- Fact-checked writing follows the contract (`taskGrounded`), so it is the
  same for every arm on a grounded book. On a book without grounding
  (press-release, the code books) a stepwise copywriter, researcher or
  reviewer step still gets it by role and an outcome owner does not.
- bug-fix-tdd asks for the bug to be reproduced with a failing test first.
  That is advisory in the contract (a check cannot tell red-first from
  green-after), so stepwise enforces more of the request than outcome.
- On the three data readouts, `claimsGrounded` is eval-only for now: on past
  readouts it flags derived statistics (confidence intervals) the check
  cannot derive. It counts in P2 and does not block a run.

## Pilot go/no-go

Before the full run: the plumbing smoke shows each arm resolved as asked
(log marker `strategy=`), outcome trials carry one terminal step gated only
by the contract, and the runtime's gate verdicts agree with the post-hoc
contract grade on ≥ 95% of criteria; the judge passes its checks; no model
sits at floor or ceiling on more than 70% of books. Books that fail every
arm for a reason outside the strategy are fixed or dropped, and that change
is recorded here before the full run starts.

## Amendments

**2026-10-24, before the Gemma re-pilot and before any judge-validity data.**
The first pilot legs showed four ways the harness still measured the recipe
or treated the arms unequally:

- **Process checks.** Besides process files, strategy trials no longer judge
  the other ways a test grades the recipe being followed. These are now
  logged as process instead: unread seeded inputs, required tool calls (a
  deck's `preview_document`), History evidence, and checks that compare a
  deliverable with a process file through `outlineFile` or `batchesFile`.
  Request-log assertions and oracle checks stay.
- **Stall window.** The harness failed a silent trial after 5 minutes, but
  the runtime re-prompts a silent step after 8 (`stuckStep.stallMs`).
  Strategy trials now wait at least 12 minutes.
- **Retry budget.** Outcome's contract gate allowed max(4, half the recipe's
  total attempts), 7 on some books. A stepwise run gets four tries at the
  same contract on its terminal step, because the plateau pause stops it at
  the fourth identical rejection. Outcome's gate now allows 4.
- **Judge validity, as operated** (`evals/src/strategy/judge-validity.ts`):
  - *Test-retest:* the pooled SD (root mean square) of each judged trial's
    three sample means.
  - *Planted defects:*
    - Sample: up to 10 judged trials per model with a clean mean of at
      least 6, drawn round-robin across books.
    - Each trial's main deliverable is damaged in memory four ways:
      - three figures that also appear in the sources are changed;
      - a fabricated statistic is inserted, citing the first source;
      - the deliverable is cut to its first 45%;
      - all structure is stripped into one paragraph.
    - Code deliverables get only the cut.
    - The judge scores each damaged copy once. A defect is caught when the
      axis it targets (grounding, grounding, completeness, craft) falls 2 or
      more points below the clean mean on that axis.
  - *Inter-judge:*
    - The second judge is claude-sonnet-5-5, with the same prompt and
      three samples.
    - It scores a fixed quarter of each model's judged trials, chosen by a
      hash of the trial id.
    - Agreement is interval Krippendorff's alpha on the two judges'
      overall means.

The Qwen 3.8 27B cells ran before these changes, so its comparisons are
provisional. How each change touched them:

- **Retry budget.** The outcome arms allowed 5 to 12 gate attempts. No
  trial reached a fourth.
- **Stall window.** The shorter window ended no Qwen trial. All seven
  stall deaths were Gemma trials and are now in `superseded/`.
- **Process checks.** Two outcome-bare trials failed only on checks that
  are now reported instead of judged:
  - codemod-sweep: an unread seeded file;
  - powerpoint-deck: no `outline.md` and no `inspect_document` call.

  Their recorded P1 counts against that arm.

**2026-10-24, after the first validity read (Qwen trials only).**

Judge prompt v1 passed two of the three checks:

| Check | Result | Threshold | Verdict |
|---|---|---|---|
| Test-retest SD | 0.27 | ≤ 0.7 | pass |
| Inter-judge α (13 trials) | 0.98 | ≥ 0.6 | pass |
| Planted defects caught | 24 of 31 (77%) | ≥ 90% | fail |

By defect kind:

| Defect | Caught |
|---|---|
| Falsified figures | 7 of 7 |
| Fabricated claim | 7 of 7 |
| Cut to 45% | 10 of 10 |
| Stripped to one paragraph | 0 of 7 |

On the stripped copies, craft did not drop. The judge reads content and does not see formatting.

Judge prompt v2 (`JUDGE_PROMPT_VERSION`) makes two changes:

- It tells the judge that deliverables are shown exactly as the person receives them, and that structure counts toward craft.
- It notes whether a binary deliverable's file exists. Under v1, the judge marked a deck down because it could not see the file.

Every v1 report is kept beside its trial as `*.v1.json`. All trials are re-judged with v2. The Qwen defects re-tested under v2 were the same items that exposed the problem. The Gemma re-pilot's trials are an untouched check, so the two are reported separately.

Judge v2 on the Qwen trials:

| Check | v2 result | Threshold | Verdict |
|---|---|---|---|
| Test-retest SD | 0.28 | ≤ 0.7 | pass |
| Planted defects caught | 28 of 31 (90%) | ≥ 90% | pass |
| Inter-judge α | 0.99 | ≥ 0.6 | pass |

The stripped-to-one-paragraph defect is now caught 4 of 7 times, still the weak spot. One of its misses is not a fair test: it stripped a deck's text source, but the delivered .pptx kept its slides. The judge correctly saw that file. Mean scores per arm moved by at most 0.11 between v1 and v2.

**2026-10-24, after the Gemma re-pilot.** Two more harness defects, both of which favored or penalized individual trials rather than an arm.

The first is pause retries. The harness's auto-answerer pressed "Try again" on a paused task's card, once per task. A strategy trial ends when its task pauses, and the retry is supposed to come too late to matter. In four Gemma trials it came first, and the retry reset the gate budget the arms are compared on:

| Trial | What the retry changed |
|---|---|
| stepwise bug-fix-tdd | Passed only after the retry |
| generalist bug-fix-tdd | Passed only after the retry |
| stepwise research-report | Failed later, but its scores came from after the retry |
| outcome-bare powerpoint-deck | Ran on to the time cap |

Strategy trials now get no pause retries. The four cells are kept in `superseded/gemma4-e4b-q4-leg3-retried` and were rerun. No Qwen trial was retried.

The second is the hard progress window. Some scenarios set a 12-minute "no real progress" window. Gemma's outcome invoice-run trial stalled, and the runtime re-prompted it after 8 minutes, as designed. The window then failed the trial three minutes into that turn. Strategy trials now get at least 20 minutes, and the cell was rerun. A longer window changes only a trial the shorter one would have killed, and this was the only such trial in the pilot.

**2026-10-24, runtime fix before the reruns.** Recipe gates reset their evidence window on every pass. A gate that sends a rejection back to its own step (`onReject: <self>`) starts a fresh pass, and evidence checks read only the current pass. So a red test run that had already satisfied bug-fix-tdd's reproduce gate stopped counting once the step was rejected for citations. The model was then told no test run had been observed.

The contract gate reads evidence across the whole task, so outcome arms never had this problem. In the pilot it failed exactly two trials: Gemma's stepwise and generalist bug-fix-tdd.

A step's evidence now spans its whole visit (`evidenceSince` on the step). The visit is kept through self-loop passes and reset when the step is entered again from elsewhere. The two cells are rerun on the fixed build.

**2026-10-25, after Qwen's 18-book run.** Qwen 3.8 27B ran all 18 books under every arm on the fixed build. That replaced its pre-fix pilot cells, which are now in `superseded/qwen3-8-27b-q4-leg1-2`.

Triaging its failures found seven test checks that failed correct work. Each was a flaw in the test, not in the deliverable:

- **market-scan, file location.** The test read `scan.md` from the workspace, but the book writes it to the artifacts drawer.
- **market-scan, market-sizing check.** It matched TAM, SAM and SOM without word boundaries, so "same" and "sample" failed. It also failed a caveat that no sizing was given. It now matches only an acronym followed by a figure.
- **cohort-analysis, forbidden content.** It forbade any null on the 2026-W21 row, but that cohort's W3 is correctly unobserved. It now looks at the W2 cell only.
- **cohort-analysis, required content.** It required "0.00" or "0%", so a plain "0" failed.
- **data-quality-audit, phrasing.** It required the literal phrases "failing examples" and "6 records". The book asks for failing rules with examples, and "6 rows" is the same count.
- **data-quality-audit, overall score.** "Overall quality score" did not match the pattern.
- **press-release, length.** The test required at least 1,100 bytes, a length the request never names. It is now 700 bytes, enough to catch a stub.
- **alert-rules, CPU.** The CPU/memory check matched a YAML comment saying such alerts were left out. It now ignores comments.

**Re-checking on disk.** The finished trials were re-judged from their saved files (`pnpm exec tsx evals/src/bin/strategy-recheck.ts`). The re-check reproduced the live verdict on all 40 trials whose tests did not change. The corrected P1 counts are:

| Arm | Live P1 | Corrected P1 |
|---|---|---|
| stepwise | 10/18 | 14/18 |
| generalist | 11/18 | 15/18 |
| outcome | 13/18 | 16/18 |
| outcome-solo | 14/18 | 17/18 |
| outcome-bare | 15/18 | 17/18 |

Gemma's counts are unchanged. Eleven of the 18 books pass under every arm for Qwen, which is under the 70% ceiling limit, so no harder books are needed. Results are in `recheck-corrected-tests.tsv` in the run folder.

**Framework fix.** Qwen's stepwise and generalist refactor-module trials paused because the model called `write_file` on its task folder ten times. The refusal named `write_artifact`, and the model ignored it. A whole-file write into the session's task folder is now written to the artifacts drawer with a reroute notice. Edit tools still refuse.

**Carried into the full run.** The full run takes the outcome variant that won the pilot, outcome-bare. On Gemma it had the best P1, P2 and P3. On Qwen it tied outcome-solo on P1 and was the fastest. Its arms are stepwise, generalist, outcome and outcome-bare.

**2026-10-26, design change by the owner.** The large tier (Nemotron 3.5 Super VL) is dropped from the full run, so the run ends after Qwen 3.5 9B. The decision came before the large leg began and before any large-tier data existed. `auto` gets no evidence for the large tier from this run. The other tiers are unchanged. The watcher that stops the run is `finish-after-small.sh` in the run folder.

**2026-10-28, the small tier's leg was started again.** Qwen 3.5 9B was the only model not already on disk. Its download failed partway ("Network error reaching the model host"), the preflight excluded it, and no 9B trial ran. The model was then fetched by hand, its size and sha256 matched the manifest, and the leg was started again with the same settings: 18 books, four arms, 2 replicates, 45-minute cap. It ran on the same build. HEAD gained two commits after the run started, but they only recorded the tree it was already using: no source, dist or gilde file changed. Grading and judging for the tiny and medium tiers started at 01:51 UTC and ran beside the 9B leg, since the judge does not use the GPU. The relaunch script is `run-9b.sh`, and its provenance is `provenance-9b.txt`.

**2026-10-28, interim look (tiny and medium), and a runtime defect it found.** Grading and judging of Gemma 4 E4B (144 trials) and Qwen 3.8 27B (216) finished at 06:16 UTC. The look came at 71% of the run, not 50%, because grading runs after each leg; both tiers were already complete, and the small tier had no data, so the futility rule had nothing left to stop. The judge passed all three checks: retest SD 0.25, 56 of 58 planted defects caught (97%), and Sonnet agreement α 0.98.

As registered, outcome and outcome-bare meet all five conditions at both tiers. Generalist fails condition 3 (pooled P1 −11.1 pp, lower bound −22.8) at both tiers, and condition 4 at medium (wall ×1.19, not significantly better).

The look also found a runtime defect that decides one book for the recipe arms. On refactor-module, every stepwise and generalist trial (10 of 10, and the two 9B trials so far) pauses within two minutes at the baseline step. The kickoff text says "where the code … has no tests, write characterization tests FIRST", and the local loop's immediate-write heuristic (`isImmediateFileWritePrompt`, `packages/core/src/local-loop/constrained-turn.ts`) reads "write … FIRST" as "write now". It clamps the turn to `write_file`, so the step can never run the test suite its gate requires, and the fixed-action handoff fails three times. The outcome arms are not stopped by it. Gemma's fast corpus-synthesis and cohort-analysis failures were checked the same way and are genuine (wrong file name, read loops).

With refactor-module left out (post hoc, sensitivity only), no arm meets condition 3: pooled P1 lower bounds are −12.4 pp for outcome and −11.6 pp for outcome-bare, and outcome also misses condition 1 at tiny (P2 lower bound −0.058). The registered readout therefore rests on the defective book. How to treat it (fix and rerun the affected cells, or drop the book) is the owner's decision and is recorded here when made.

**2026-10-28, the owner's decision: fix the defect and rerun the affected cells.** `isImmediateFileWritePrompt` now ignores a write whose clause opens with a condition (if, when, where, unless, otherwise, …), looking back to the nearest clause break, so the refactor-module kickoff no longer clamps the turn; an unconditional write still does. The 9B leg finished on the original build (144 trials) and was held before grading. Core was then rebuilt with the fix, and only the refactor-module stepwise and generalist cells were run again on all three tiers, with the original replicate counts and caps: Gemma 4 E4B 2 and Qwen 3.5 9B 2 (45 minutes), Qwen 3.8 27B 3 (60 minutes), 14 trials. The 14 superseded trials are kept in `superseded-refactor-recipe-2026-10-28/`. The outcome and outcome-bare refactor-module trials were not rerun, so those pairs mix two builds. The fix touches only this heuristic. It also fired in outcome-arm turns on several other books, but it stopped none of those trials, so they were not rerun either. Every other cell of every tier stays on the original build. The script is `run-refactor-rerun.sh`, and its provenance is `provenance-refactor-rerun.txt`. All three tiers are graded and judged once, after the rerun. The analysis reports the registered readout on this data, and the readout without refactor-module as a sensitivity check.

**2026-10-28, the rerun's outcome.** Qwen 3.8 27B passed all six refactor-module reruns, three stepwise and three generalist. Gemma 4 E4B passed one of two stepwise and neither generalist; both of its failures ran out of attempts at the verify or evaluate gate. Qwen 3.5 9B failed all four, each paused at plan or baseline within four minutes, because of a second defect, this one in the book. The plan gate's `citationsResolve` fails any backticked path that does not exist yet. Each 9B plan named the module it proposed to create (`src/normalize-name.js`), and the model rewrote the plan four times with the same citation. Gemma hit the same rejection once and got past it by creating the file during planning. Qwen 27B never named the future file. The outcome arms are gated only on the contract, so the defect reaches stepwise and generalist alone. It was not rerun. The sensitivity check without refactor-module covers it, and the fix belongs in gilde: forgive paths the plan proposes, or count only the plan's cited-files section.

## Result (2026-10-28)

All 504 trials were graded and judged at 18:35 UTC: Gemma 4 E4B 144, Qwen 3.5 9B 144, Qwen 3.8 27B 216. Runtime gate verdicts and post-hoc grades agree on 1,971 of 1,973 criteria. The judge passed all three checks:

- retest SD 0.26 (threshold 0.7);
- 83 of 88 planted defects caught, 94%. The weakest kind was flattened structure, 17 of 22;
- Sonnet agreement α 0.97 over 126 trials.

Outcome-bare, the pilot's winning outcome variant, was carried into the full run, so it is read as a candidate beside generalist and outcome. No failure mode appeared in two or more trials of any arm and in no stepwise trial (condition 5).

Pooled P1 against stepwise, n = 126, with book-cluster bootstrap intervals:

- generalist −3.2 pp [−13.4, +7.1], which fails condition 3;
- outcome +0.0 pp [−8.0, +8.7];
- outcome-bare +6.3 pp [−4.1, +17.2].

| Tier | Arm | P2 Δ [95%] | P3 Δ [95%] | Wall | Conditions |
|---|---|---|---|---|---|
| Tiny, Gemma 4 E4B | generalist | −0.015 [−0.047, +0.011] | +0.01 [−0.41, +0.41] | ×0.74 | fails 3 |
| | outcome | +0.048 [−0.048, +0.169] | +0.45 [−0.26, +1.30] | ×0.58 | all pass |
| | outcome-bare | +0.065 [−0.034, +0.194] | +0.46 [−0.23, +1.29] | ×0.40 | all pass |
| Small, Qwen 3.5 9B | generalist | +0.020 [−0.006, +0.051] | +0.28 [−0.04, +0.66] | ×0.75 | fails 3 |
| | outcome | +0.015 [−0.019, +0.052] | −0.23 [−0.65, +0.16] | ×0.33 | fails 2 |
| | outcome-bare | +0.026 [−0.011, +0.068] | −0.06 [−0.57, +0.50] | ×0.32 | fails 2 |
| Medium, Qwen 3.8 27B | generalist | −0.001 [−0.017, +0.018] | −0.08 [−0.27, +0.10] | ×1.20 | fails 3, 4 |
| | outcome | +0.005 [−0.009, +0.027] | +0.07 [−0.20, +0.30] | ×0.40 | all pass |
| | outcome-bare | +0.008 [−0.007, +0.032] | −0.09 [−0.36, +0.16] | ×0.34 | all pass |

Where both outcome variants qualify, the rule takes the cheaper one unless quality differs significantly:

- **Tiny:** outcome-bare. It is cheaper, and against outcome its P2 is +0.017 [−0.031, +0.075] and its P3 +0.01 [−0.33, +0.31].
- **Medium:** outcome. Outcome-bare is cheaper (×0.72 of outcome's wall time) but scores significantly lower on P3, −0.16 [−0.30, −0.02].
- **Small:** stepwise stays. Both outcome variants miss condition 2 on the P3 lower bound, though neither point estimate shows harm and P1 favors them (6/4 and 10/3 discordant pairs). Generalist misses only the pooled condition 3; on this tier alone its P1 is 9/2 in its favor.

The outcome arms used a quarter or less of stepwise's median input tokens:

| Tier | stepwise | generalist | outcome | outcome-bare |
|---|---|---|---|---|
| Tiny | 105k | 97k | 35k | 27k |
| Small | 200k | 170k | 40k | 39k |
| Medium | 178k | 296k | 43k | 39k |

**Sensitivity, refactor-module left out (post hoc).** The picks do not change:

- Pooled P1 lower bounds are −13.0 pp for generalist, −9.8 pp for outcome and −5.0 pp for outcome-bare.
- Tiny: outcome now misses condition 1 (P2 lower bound −0.058), and outcome-bare qualifies.
- Medium: both qualify, and outcome-bare's P3 deficit against outcome holds, −0.17 [−0.31, −0.03].
- Small: still fails condition 2 for both outcome variants.

Unlike the interim look, this readout does not rest on the defective book. But outcome's pooled margin without it, 0.2 pp, is thin.

**What this does not settle.**

- The small-tier gap is width, not harm. By this run's SDs, 48 pairs would resolve outcome's P3 and 64 outcome-bare's, against 36 run.
- The large tier and the cloud reference were not run.
- `auto` still never picks outcome; acting on this result is a code change and the owner's decision.
