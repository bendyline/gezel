# Recipe, goal, or just the request? How a local AI model should work through a task

*Draft for editing, 2026-11-10. Every pass, criteria and quality figure below
comes from `evals/runs/report-2026-11/numbers.md`, which `build.mts` in the
same folder regenerates from the recorded trials. Cloud costs come from
`cloud-cost.mts` beside it. The Sol figures without codemod-sweep come from
`evals/runs/frontier-sol-2026-11-09/quality-sensitivity.mts`. Counts of
failures by cause come from reading each failed trial, as each
pre-registration's Result lists. The one remaining PENDING mark is a decision
for the owners.*

## Summary

Gezel runs multi-step work, such as writing a runbook, fixing a bug with a
test, or producing a month of invoices, from *craftbooks*: a recipe of steps,
each with its own instructions and checks. We asked whether a model does better
when it follows that recipe step by step, or when it is handed the goal and the
quality bar and left to find its own way. We ran 1,098 graded trials of 18
tasks on four on-device models across three rounds, then 294 more comparing
Gezel with two popular agent tools on two of those models and on a cloud
model, then 162 on that cloud model to test what the comparison suggested,
and finally 162 on a second cloud model from another maker: 1,716 counted
trials in all.

- **On small on-device models, giving the model the goal and the quality bar
  beats walking it through the recipe.** Pooled over every round, Qwen 3.5 9B
  finished 59 of 90 tasks this way against 39 of 90 step by step (+22 points,
  95% interval +9 to +36). Gemma 4 E4B went from 33 to 42 of 78. Judged
  quality rose by 0.6 to 0.9 points out of 10, with intervals above zero.
- **On a larger model, quality is the same either way, and the goal-only run is
  three times faster.** Qwen 3.8 27B passed 56 of 60 against 55 of 60, with
  judged quality within ±0.3 points, at 0.34× the wall time.
- **Across all three models, 157 of 228 tasks passed goal-only against 127
  step by step** (+13 points, 95% interval +5 to +22). The gain sits in code,
  data and multi-deliverable work. On research documents and operations
  writing, quality was the same either way overall. Two books went the other
  way: the slide deck, where small models without the recipe often never
  produced the PowerPoint file, and the press release.
- **Every on-device model was faster without the recipe:** 0.16× to 0.35× the
  wall time of step-by-step runs, reading a fifth to a quarter of the input
  tokens.
- **The quality bar is what does the work, not the recipe.** Hiding the bar and
  giving only the request cost 22 to 31 points of pass rate and about one
  judged point on every model. Handing over the recipe as advice on top of the
  bar added nothing measurable, and made runs 1.3 to 1.4 times slower.
- **Gezel now runs on-device models this way by default** ("outcome-bare"),
  since 2026-11-04.
- **Against other agent tools on the same local models** (pi and OpenCode,
  given the same request and project facts), Gezel's default passed more
  tasks: 12 of 14 on Qwen 3.5 9B against 5 to 8, and 13 of 14 on Qwen 3.8 27B
  against 9 or 10. Most of that gap is the quality bar, which only Gezel's
  default sees: given only the request, Gezel itself passed 7 and 10. Given
  the craftbook's description as well, the outside tools matched that
  request-only Gezel on judged quality in three of the four model-and-tool
  pairs, within a tenth of a point (pi on the 9B trailed by 0.7). Without it,
  they trailed by a quarter to one and a half points.
- **On two frontier models the goal-based strategies matched or beat the
  recipe, in a third to a half of the time, at a quarter to a third of the
  cost.** Gezel ran cloud models "one owner, whole recipe" until then. Each
  model got a pre-registered run of all 18 books, three runs each.
  - **Claude Sonnet 5.5** (a seven-book comparison suggested it first):
    - judged quality was the same, 8.56 for one owner against 8.65 and 8.69;
    - 0.35× the wall time, and $0.12 against $0.43 a task;
    - under the registered rule "recipe as advice" qualifies, and "goal
      only" falls just short on passes, though 9 of its 10 failures were
      checks misreading correct work.
  - **OpenAI's GPT-6.1 Sol, through Codex CLI:**
    - both qualify, and goal only scored higher than the recipe (8.61
      against 8.28, interval above zero);
    - 0.42× the wall time, and $0.07 against $0.28 a task.
  - Gezel now runs each of the two models with its own measured pick, and
    every other cloud model goal only (since 2026-11-10).

## Why we measured this

A small local model is cheap to run and keeps your data on your machine, but it
loses track of long instructions and gives up on work a larger model would
finish. Gezel's answer had been structure: break the job into steps, give each
step a specialist, check each step's output before moving on. That is a lot of
machinery, and it costs time. We wanted to know whether it pays for itself, and
for which models, before deciding what Gezel does by default.

We wrote the method down before the first trial ran (the pre-registration is in
[strategy-prereg-2026-10-22.md](strategy-prereg-2026-10-22.md)), including the
rule for changing the default. The comparison with other agent tools and with
Sonnet has its own pre-registration and amendments
([outside-tools-prereg-2026-11-08.md](outside-tools-prereg-2026-11-08.md)),
and so does the Sonnet follow-up
([frontier-prereg-2026-11-09.md](frontier-prereg-2026-11-09.md)). Where we
changed course after seeing data, we say so.

## What we compared

Each task is a craftbook with a **contract**: the goal, the deliverables, and a
quality bar of criteria the runtime can check (a section exists, the tests
pass, every cited figure appears in its source). The strategies differ in how
much of the recipe the model is held to.

| Strategy | Internal name | Who works | What the model is told | What is checked |
|---|---|---|---|---|
| Step by step | `stepwise` | A specialist per step (planner, writer, reviewer), each in a fresh conversation | One step's instructions at a time | Each step's own gate, then a final review |
| One owner, whole recipe | `generalist` | One gezel, one conversation | Every step, in order | Every step's gate |
| Goal, recipe as advice | `outcome` | One gezel, one conversation | The contract, plus the recipe as optional advice | The contract only |
| Goal only | `outcome-bare` | One gezel, one conversation | The contract | The contract only |
| Request only | `harness` | One gezel, one conversation | The person's request; no contract | Nothing until grading |
| Contract shown, not checked | `contract-shown` | One gezel, one conversation | The contract | Nothing until grading |
| pi | `pi` | pi 1.4.0, an outside agent tool | The request, and the project's description and objectives | Nothing until grading |
| OpenCode | `opencode` | OpenCode 1.19.4, an outside agent tool | The request, and the project's description and objectives | Nothing until grading |

`harness` and `contract-shown` were ablations, not candidates for the default:
they separate what the quality bar contributes from what Gezel's runtime
contributes. The outside tools were each also run with the craftbook's
description added (`pi-book`, `opencode-book`), for a reason explained under
"An information gap" below.

### What the model actually sees

Here is one task, the on-call runbook, as each strategy presented it to Qwen
3.8 27B. The full texts are in the appendix.

The person's request, identical in every arm:

> In the `Runbook Eval` project, read `source/incident-brief.md` and write
> `runbook.md`: an on-call procedure for clearing a webhook retry backlog.
> Include when to use and when not to use it, prerequisites, pre-flight
> checks, numbered mitigation steps with expected output and verification,
> rollback, escalation, warnings for risky actions, and a final resolved
> checklist.

**Step by step.** The task runs five steps: scope (planner), write
(copywriter), review (reviewer), evaluate (reviewer), finish. The planner's
step opens:

> Define what the runbook covers before writing steps. Step 1: state the exact
> scenario(s) this runbook handles and, just as importantly, when NOT to use
> it. Step 2: list prerequisites — access/permissions, tools, environment, and
> any 'before you start' safety checks. […] Write the scope + checklist via
> write_task_note AND to tasks/1/scope.md. No detailed steps yet.

Each later step gets its own instructions in a new conversation, and the
writer only knows what the planner left in files.

**Goal only.** One step, with this instruction:

> Deliver the outcome the **Task contract** describes. You own all of it, in
> this one conversation, and you choose how to get there: work directly toward
> deliverables that meet the bar. […] When every deliverable is in place, call
> advance_task_step once. The runtime checks the contract and names anything
> unmet; fix exactly that and call it again.

and the contract in its system prompt:

> Goal: An on-call runbook a tired engineer can follow literally: when to use
> it and when not to, prerequisites, numbered copy-pasteable steps that each
> say what to expect and how to verify it, warnings before risky steps, a
> rollback, and an escalation path.
>
> Deliverables: `runbook.md` — The runbook, in Markdown.
>
> Quality bar: The runbook is a complete document organized under headings
> [checked] · It says when to use it and when not to [checked] · It lists
> prerequisites (access, tools, safety checks) before the procedure [checked] ·
> The procedure is written as numbered steps [checked] · Commands are written
> out exactly in code formatting [checked] · It has a rollback section
> [checked] · It has an escalation section [checked] · Steps say what output to
> expect and how to verify each one worked [checked] · Risky or destructive
> steps carry a warning before them [checked] · Nothing is left unfinished: no
> TBD, TODO or FIXME [checked] · Each step is unambiguous and in order […] ·
> Commands, thresholds, names and contacts come from what the person supplied
> […]
>
> The runtime checks the [checked] items before the task can finish and names
> anything unmet.

**Goal, recipe as advice.** The same, plus a section headed "Recommended
approach (advisory)" holding every original step's instructions, introduced
with: "The recipe this outcome usually follows. Use what helps; reorder, merge
or skip parts when you can reach the outcome more directly. Files it writes
along the way are optional unless the contract lists them."

**Request only.** One step, "Deliver what the request asks for. You own all of
it, in this one conversation, and you choose how to get there." No contract.

**pi and OpenCode.** The request as the message. Appended to the tool's own
system prompt: the project's description, its mission objectives, and the list
of input files and required deliverables that every Gezel arm also gets, in
plain words without Gezel's tool names. Nothing else.

### An information gap

Every Gezel arm, including "goal only" and "request only", also received the
craftbook's description in its first message. For these catalog books that
description outlines the recipe's phases, file paths and formats ("Scope the
runbook (planner) … gated on artifact scope.md"; for invoice-run, "each child
writes invoices/{number}.html"). So "goal only" is really "goal, quality bar,
and a one-paragraph outline of the usual phases", and the outside tools started
with less information than any Gezel arm. We found this after the first
outside-tool run and added the `-book` arms, which give pi and OpenCode the
same description, to measure it.

The requests themselves were written for Gezel users, and four of the seven
outside-tool books' requests name the craftbook ("Use the Codemod Sweep
craftbook for this: rename fetchUserData to loadUser…"). We kept the request
word for word in every arm. A plain outside tool has nothing to look that name
up in, and a few runs searched the machine for it (see "What we found and
fixed"). The `-book` arms resolve the reference, which makes them the fairest
comparison with Gezel.

## How we measured

**Tasks.** 18 craftbooks across five kinds of work, each with a contract and a
seeded project folder:

| Kind | Books |
|---|---|
| Research and documents | research-report, powerpoint-deck, corpus-synthesis, market-scan, content-accuracy-review, engineering-retrospective |
| Code | bug-fix-tdd, refactor-module, codemod-sweep |
| Data | ab-test-readout, cohort-analysis, data-quality-audit, csv-transformer |
| Operations and communication | alert-rules, runbook, press-release |
| Several deliverables | invoice-run, html-arcade-game |

Later rounds used subsets: six books for the round-3 scorecard and the screen,
and seven file-based books for the outside-tool comparison and the first
Sonnet run (engineering-retrospective, refactor-module, cohort-analysis,
runbook, invoice-run, bug-fix-tdd, codemod-sweep). The Sonnet follow-up and
the Sol run ran all 18.

**Models.** Gemma 4 E4B, Qwen 3.5 9B and Qwen 3.8 27B, all 4-bit, plus Ornith
1.5 9B (a fine-tune of Qwen 3.5 9B) in a smaller screen. In the cloud, Claude
Sonnet 5.5 through the Anthropic API, and GPT-6.1 Sol through Codex CLI.

**Hardware.** One NVIDIA DGX Spark (GB10, 128 GB unified memory), llama.cpp
through Gezel's native engine (releases 0.1.52 to 0.1.62), one trial at a time.
Context windows (128K for Gemma, 256K for Qwen) were large enough that no
trial came close to filling one: the fullest of the 1,098 trials in rounds 1
to 3 reached 34%, and three of them ran a mid-turn compaction anyway.

**Measures.**

- **Pass (P1):** the task finished, every acceptance criterion in the contract
  passed, and every result check in the book's test passed. Files a recipe
  writes along the way but the contract does not ask for are not judged.
- **Criteria met (P2):** the share of all checked items that passed.
- **Quality (P3):** a blind judge's score out of 10, the mean of four axes
  (fitness to the request, completeness against the contract, grounding in
  the sources, craft), three samples per trial. The judge is Claude Opus 5.5
  at high effort with structured output. It sees the deliverables with paths,
  step names and the gezel's own notes removed, plus the source files. The
  pre-registration also listed a pairwise win rate (the judge choosing between
  two strategies' deliverables side by side). We did not build it, so every
  quality figure here is the absolute score.
- **Cost:** wall time per trial, and tokens.

**Judge validity.** Before trusting the judge we checked it three ways
(round 1, judge version 2): scoring the same trials twice gave a standard
deviation of 0.26 points; it caught 83 of 88 deliberately planted defects
(94%; the weakest kind was flattened structure, 17 of 22); and a second judge
(Sonnet 5.5) agreed with it at Krippendorff's α 0.97 over 126 trials. In
November we found the judge had been shown folder deliverables (the code books
and invoice-run) as missing; version 3 fixed that, all 273 affected trials were
re-judged, and the fixed judge caught 22 of 22 planted defects in code and
invoices (each code defect confirmed by the project's own tests), with α 0.95
against Sonnet. All quality scores here are version 3.

**Analysis.** Each trial of a strategy is paired with the control's trial of
the same model, book and replicate. Intervals are 95% percentile bootstraps
that resample whole books, because trials of one book share its difficulty.
For pass rates we also report the discordant pairs (one arm passed, the other
failed). The runtime's own gate verdicts and our after-the-fact grading agreed
on 1,971 of 1,973 criteria in round 1.

**The rule for changing the default** (pre-registered). A strategy replaces
step by step for a model size only if: the lower bound on criteria met is
above −0.05, the lower bound on quality is above −0.5, the pooled pass-rate
lower bound is above −10 points, it is no slower (or at most 1.25 times slower
when significantly better), and it shows no new failure mode.

## Results

### Round 1: four strategies, 18 books, three models (504 trials)

| Model | Strategy | Passed | Criteria met | Quality | Wall (median min) |
|---|---|---|---|---|---|
| Gemma 4 E4B | step by step | 17/36 | 0.83 | 4.75 | 4.6 |
| | one owner, whole recipe | 12/36 | 0.81 | 4.89 | 3.8 |
| | goal, recipe as advice | 18/36 | 0.88 | 5.58 | 2.5 |
| | goal only | 18/36 | 0.89 | 5.47 | 1.6 |
| Qwen 3.5 9B | step by step | 16/36 | 0.94 | 5.41 | 6.0 |
| | one owner, whole recipe | 23/36 | 0.96 | 5.87 | 4.4 |
| | goal, recipe as advice | 18/36 | 0.95 | 5.64 | 1.9 |
| | goal only | 23/36 | 0.96 | 5.93 | 1.6 |
| Qwen 3.8 27B | step by step | 50/54 | 0.99 | 7.92 | 13.8 |
| | one owner, whole recipe | 44/54 | 0.99 | 7.83 | 15.8 |
| | goal, recipe as advice | 47/54 | 0.99 | 8.03 | 5.8 |
| | goal only | 50/54 | 0.99 | 7.90 | 4.4 |

Paired against step by step:

| Model | Strategy | Pass rate Δ | Quality Δ | Wall |
|---|---|---|---|---|
| Gemma 4 E4B | one owner | −14 pts [−31, +3] | +0.14 [−0.32, +0.58] | 0.74× |
| | recipe as advice | +3 pts [−14, +19] | +0.83 [+0.03, +1.72] | 0.58× |
| | goal only | +3 pts [−19, +25] | +0.72 [−0.03, +1.59] | 0.40× |
| Qwen 3.5 9B | one owner | +19 pts [+3, +39] | +0.46 [+0.00, +1.01] | 0.75× |
| | recipe as advice | +6 pts [−11, +22] | +0.23 [−0.39, +0.90] | 0.33× |
| | goal only | +19 pts [0, +39] | +0.52 [−0.23, +1.30] | 0.32× |
| Qwen 3.8 27B | one owner | −11 pts [−28, +4] | −0.10 [−0.29, +0.09] | 1.20× |
| | recipe as advice | −6 pts [−15, +6] | +0.11 [−0.17, +0.34] | 0.40× |
| | goal only | 0 pts [−13, +15] | −0.02 [−0.33, +0.26] | 0.34× |

"One owner, whole recipe" failed the pooled pass-rate condition: across all
three models it lost 3.2 points [−13.4, +7.1], and on the 27B it was also
slower than step by step. Both goal-based strategies met every condition on
every model under the corrected judge. Where both qualify, the rule takes the
cheaper one, so "goal only" was the pick for all three. (Under the original
judge, before the folder fix, the 9B pick had stayed with step by step on a
quality interval that just missed the bar; the fix moved it.)

The goal-based strategies also read far less. Median input tokens per task:

| Model | Step by step | One owner | Recipe as advice | Goal only |
|---|---|---|---|---|
| Gemma 4 E4B | 105k | 97k | 35k | 27k |
| Qwen 3.5 9B | 200k | 170k | 40k | 39k |
| Qwen 3.8 27B | 178k | 296k | 43k | 39k |

### Replication: rounds 2 and 3, and a fine-tune

Round 2 (2026-11-01 to 11-03) re-ran all 18 books, two replicates, on a newer
build, adding the contract ablation. Round 3 (2026-11-07) re-ran a six-book
scorecard after an engine upgrade. A screen on 2026-11-04 asked whether a
fine-tune inherits its base model's best strategy.

| Run | Model | Step by step | Goal only | Quality Δ | Wall |
|---|---|---|---|---|---|
| Round 2 | Gemma 4 E4B | 12/36 | 21/36 | +1.20 [+0.52, +1.98] | 0.33× |
| Round 2 | Qwen 3.5 9B | 14/36 | 23/36 | +0.64 [−0.18, +1.51] | 0.31× |
| Screen | Qwen 3.5 9B | 6/12 | 8/12 | +0.53 [−1.51, +1.99] | 0.28× |
| Screen | Ornith 1.5 9B | 6/12 | 11/12 | +0.78 [+0.14, +1.37] | 0.16× |
| Round 3 | Gemma 4 E4B | 4/6 | 3/6 | +0.61 [−0.83, +1.74] | 0.45× |
| Round 3 | Qwen 3.5 9B | 3/6 | 5/6 | +0.87 [−0.22, +2.21] | 0.30× |
| Round 3 | Qwen 3.8 27B | 5/6 | 6/6 | −0.10 [−0.43, +0.31] | 0.36× |

Round 2 ran no step-by-step arm on the 27B; it compared the two goal-based
strategies there instead (recipe as advice against goal only: pass 34/36 each,
quality −0.21 [−0.52, +0.08], 1.32× the wall time).

### The change: goal only, every round pooled

Since 2026-11-04 Gezel runs every on-device model "goal only" unless the model
has been measured otherwise. Pooling every round in which both the old and
the new default ran (each book tagged by round, so pairs never cross rounds):

| Model | Pairs | Step by step | Goal only | Pass rate Δ | Criteria met Δ | Quality Δ | Wall |
|---|---|---|---|---|---|---|---|
| Gemma 4 E4B | 78 | 33/78 | 42/78 | +12 pts [−4, +27] | +0.073 [+0.005, +0.153] | +0.93 [+0.44, +1.48] | 0.35× |
| Qwen 3.5 9B | 90 | 39/90 | 59/90 | +22 pts [+9, +36] | +0.034 [+0.004, +0.066] | +0.59 [+0.06, +1.11] | 0.31× |
| Qwen 3.8 27B | 60 | 55/60 | 56/60 | +2 pts [−11, +16] | +0.009 [−0.006, +0.031] | −0.03 [−0.32, +0.22] | 0.34× |
| Ornith 1.5 9B | 12 | 6/12 | 11/12 | +42 pts [+17, +67] | +0.099 [+0.010, +0.212] | +0.78 [+0.14, +1.37] | 0.16× |

All three models together (228 pairs, clustered by book, round and model):
157 passes against 127, +13 points [+5, +22]; criteria met +0.041 [+0.015,
+0.073]; quality +0.54 [+0.26, +0.85]; 0.33× the wall time.

Where the gain comes from, by kind of work (descriptive; the cells are small):

| Kind | Pairs | Goal only | Step by step | Quality Δ | Wall |
|---|---|---|---|---|---|
| Code | 38 | 35/38 | 21/38 | +1.37 [+0.70, +2.13] | 0.20× |
| Several deliverables | 27 | 25/27 | 20/27 | +1.29 [+0.73, +1.90] | 0.38× |
| Data | 49 | 28/49 | 25/49 | +0.74 [+0.28, +1.23] | 0.43× |
| Research and documents | 76 | 53/76 | 43/76 | +0.05 [−0.49, +0.69] | 0.40× |
| Operations and communication | 38 | 16/38 | 18/38 | −0.07 [−0.59, +0.45] | 0.23× |

On writing tasks the two strategies produce work of the same judged quality;
goal only gets there faster. On code, most of the gap is checkpoints. Of the
17 step-by-step code trials that failed, four stopped at the planning step on
a check that rejected a plan for naming the file it was about to create (a
defect, fixed after round 2), nine paused or stalled at a later checkpoint
(review, validation, repair) after using up their attempts, and three finished
with tests failing. A goal-only run has one checkpoint, at the end. The same
pattern decides the retrospective, which step by step passed once in 16 runs:
the rest stopped at a checkpoint, paused for help, or (three 27B runs) ran
into the one-hour cap.

Two books went the other way (Appendix B has every book). On the slide deck,
goal only passed 10 of 16 against 15 of 16, with judged quality 4.5 against
6.0. All six failures were small-model runs that never produced a proper
`.pptx` (five wrote none, one wrote 848 bytes) and never finished. Turning
the slide text into a PowerPoint file takes a conversion tool, and the recipe
walks the model through it step by step. On the press release both passed 3 of
11, but goal only scored 5.8 against 7.0. Where the deliverable depends on a
particular tool sequence, or on a review-and-revise pass, the recipe can still
help a small model.

And the recipe as advice, against goal only:

| Model | Pairs | Pass rate Δ | Quality Δ | Wall |
|---|---|---|---|---|
| Gemma 4 E4B | 42 | +2 pts [−15, +19] | +0.07 [−0.29, +0.44] | 1.40× |
| Qwen 3.5 9B | 90 | −3 pts [−16, +10] | +0.06 [−0.35, +0.50] | 1.26× |
| Qwen 3.8 27B | 96 | −3 pts [−9, +3] | −0.01 [−0.16, +0.13] | 1.36× |

**Why does less structure help a small model?** The trial records point to
three things. A step-by-step run is a relay: each step starts a fresh
conversation that knows only what earlier steps wrote to files, so a fact the
planner noted but the writer never opened is lost. Each step also has its own
gate with a limited number of attempts, and small models spent those attempts
quickly. In round 1 the review step ran more than once (the work was sent back
at least once) in 65% of Gemma's step-by-step runs that reached it, 68% of the
9B's and 35% of the 27B's, against 38%, 38% and 27% when one owner ran the
same recipe. And every hand-off costs a full system prompt and tool list again, which
is where the extra time and tokens go. A goal-based owner keeps everything in
one conversation and stops when the contract is met.

The teammates offered to goal-based owners (ask a reviewer, ask a researcher)
went almost unused: 9 of 252 goal-based trials in round 1 consulted one at
all, 18 calls in total.

### Is it the quality bar or the runtime? (round 2 ablation)

Against "goal only", same build, same 18 books, two replicates:

| Model | Arm | Pass rate Δ | Criteria met Δ | Quality Δ |
|---|---|---|---|---|
| Gemma 4 E4B | contract shown, not checked | −19 pts [−36, −6] | −0.156 [−0.276, −0.054] | −0.36 [−0.72, −0.00] |
| | request only | −31 pts [−53, −11] | −0.266 [−0.414, −0.134] | −0.99 [−1.87, −0.33] |
| Qwen 3.5 9B | contract shown, not checked | −8 pts [−22, +8] | −0.053 [−0.120, −0.003] | −0.45 [−0.93, +0.03] |
| | request only | −28 pts [−44, −11] | −0.121 [−0.190, −0.058] | −0.78 [−1.20, −0.36] |
| Qwen 3.8 27B | contract shown, not checked | −8 pts [−22, +3] | −0.009 [−0.034, +0.006] | −0.00 [−0.25, +0.24] |
| | request only | −22 pts [−44, −3] | −0.049 [−0.099, −0.012] | −0.86 [−1.21, −0.52] |

Knowing the bar matters at every size: without it, even the 27B lost about a
fifth of its passes and nearly a point of quality. Having the runtime check the
bar matters more the smaller the model: the 27B did as well with the bar merely
shown, while Gemma lost 19 points of pass rate.

A caution on reading this table: the graders and the judge score against the
same contract that "goal only" sees and "request only" does not. Some of the
gap is the model being told what it will be graded on. That is the honest
product question (a person's request rarely spells out every criterion, and the
contract is how Gezel fills that in), but it is not a pure measure of model
effort. A concrete case: engineering-retrospective's contract requires six
named sections (Period context, What went well, Friction and hotspots,
Collaboration and growth, Experiments, Evidence limits). The request asks for
that content but never names the headings, so every arm that does not see the
contract (request only, pi, OpenCode) fails that check however good its
retrospective is. The fair test of what Gezel's runtime adds, apart from the
contract, is therefore Gezel with only the request against the outside tools:
none of them sees the contract.

### Gezel against other agent tools on the same local models

Seven file-based books, two replicates, Qwen 3.5 9B and Qwen 3.8 27B, 168
trials. pi 1.4.0 and OpenCode 1.19.4 ran in the project folder on the same
model and engine build as Gezel, with their own default tools, inside a
sandbox. Each got the person's request word for word, the project's
description and objectives, and the list of inputs and required files. The
"+ book description" arms also got the craftbook's description, which Gezel
puts into every kickoff (Appendix A shows each arm's full text for the
runbook). Because an outside tool
leaves none of Gezel's tool records, "passed" here runs each code book's tests
on the final folder for every arm (we call it P1-result; it changed no
pass/fail pair in rounds 1 to 3 when applied there). As registered, plain P1
gave the outside tools 0 to 4 of 14, because they cannot leave those records.
This is the rerun registered as amendment 3. The first run, which gave the
outside tools a project description written for Gezel, is in Appendix C.

| Model | Arm | Passed | Criteria met | Quality | Quality Δ vs goal only | Quality Δ vs request only | Wall (median min) |
|---|---|---|---|---|---|---|---|
| Qwen 3.5 9B | Gezel, goal only | 12/14 | 0.98 | 6.58 | (control) | +0.48 [−0.04, +1.22] | 1.3 |
| | Gezel, request only | 7/14 | 0.92 | 6.10 | −0.48 [−1.22, +0.04] | (control) | 1.2 |
| | pi | 8/14 | 0.80 | 5.88 | −0.70 [−2.29, +0.33] | −0.23 [−1.09, +0.37] | 0.7 |
| | pi + book description | 6/14 | 0.83 | 5.41 | −1.17 [−2.17, −0.21] | −0.69 [−1.70, +0.05] | 1.3 |
| | OpenCode | 5/14 | 0.69 | 4.64 | −1.94 [−3.27, −0.68] | −1.46 [−2.58, −0.36] | 1.3 |
| | OpenCode + book description | 6/14 | 0.87 | 6.02 | −0.56 [−1.74, +0.31] | −0.08 [−0.58, +0.45] | 1.4 |
| Qwen 3.8 27B | Gezel, goal only | 13/14 | 0.97 | 7.68 | (control) | +0.14 [−0.71, +0.82] | 4.7 |
| | Gezel, request only | 10/14 | 0.95 | 7.54 | −0.14 [−0.82, +0.71] | (control) | 5.3 |
| | pi | 10/14 | 0.84 | 7.01 | −0.67 [−1.91, +0.39] | −0.53 [−1.46, +0.30] | 2.4 |
| | pi + book description | 9/14 | 0.92 | 7.46 | −0.23 [−0.89, +0.58] | −0.08 [−0.29, +0.14] | 4.4 |
| | OpenCode | 10/14 | 0.89 | 6.99 | −0.70 [−1.86, +0.43] | −0.55 [−1.33, +0.07] | 3.6 |
| | OpenCode + book description | 9/14 | 0.92 | 7.45 | −0.23 [−0.91, +0.65] | −0.09 [−0.36, +0.13] | 6.2 |

What this shows:

- **Gezel's default passed more tasks than either outside tool on both
  models:** 12 of 14 on the 9B against 5 to 8, and 13 of 14 on the 27B against
  9 or 10. On the 9B every outside arm's pass-rate interval lies below zero
  (−29 to −50 points); on the 27B the intervals cross zero. With 14 pairs per
  cell, no pass/fail difference survives the Holm correction, so as
  registered this reading is descriptive.
- **Most of that gap is the quality bar, which only Gezel's default sees.**
  Gezel with only the request passed 7 and 10. Against that arm, the outside
  tools passed between two fewer and one more.
- **With the craftbook's description, the outside tools matched Gezel given
  only the request on judged quality, except pi on the 9B.** On the 27B both
  came within a tenth of a point, with narrow intervals; on the 9B OpenCode
  did too (−0.08), and pi trailed by 0.69 [−1.70, +0.05]. They met slightly
  fewer of the criteria (0.03 to 0.09 fewer, every interval below zero).
- **Without the description, they trailed further:** pi by 0.23 and 0.53
  points, OpenCode by 1.46 and 0.55. The plain arms wrote the invoices as
  JSON, Markdown or plain text (one run gave its text files a `.pdf` name),
  where the contract asks for HTML, and on the 9B none of the four plain runs
  wrote the run summary.
- **The 9B's worst outside-tool failures came from losing track of file
  paths.** Under OpenCode, one runbook run invented a `/workspace/` folder,
  failed its one write there, and then read the missing file 228 times until
  it stopped. A codemod run copied the project's folder path with one word
  missing, so every edit of the rename missed, and then reported "Done" with
  nothing changed. Under pi with the description, one run saved the runbook
  as `source/runbook.md` instead of `runbook.md`. The judge scored these
  three 0.0 to 0.1. No Gezel trial in this comparison scored below 3.0.
- **The other failures were formats that only the contract states, as on
  Sonnet below.** On the 27B, every failure of Gezel's request-only arm and of the
  outside tools was on the retrospective (its six named sections) or the
  invoices (a "Skipped clients" heading, HTML invoices, and in one pi run the
  summary itself), apart from one strict-check failure in each "+ book
  description" arm (below). On the 9B those two books failed in every arm
  that did not see the contract, and so did the cohort readout: the contract
  asks for "a full document organized under headings", which its check reads
  as at least 1,500 bytes. The request names no length, and all eight
  outside-tool readouts were shorter (585 to 1,152 bytes), as was one of
  Gezel's request-only readouts (1,458).
- **pi was the fastest:** 0.58× and 0.51× the goal-only wall time on the 9B
  and 27B. Plain OpenCode took 1.11× and 0.66×. With the description, both
  tools worked longer on the 27B (0.71× and 1.15×). Decode speed was the same
  in every arm (63 to 66 tokens a second on the 9B, 28 to 32 on the 27B), so
  these are differences in work, not in the engine. pi's largest prompt was a
  third to a half the size of Gezel's (4.6k to 8.2k tokens against 13.5k to
  16.6k); OpenCode's was 10.5k to 14.2k.

Three checks decided passes here without a fault in the work. Two runbooks
that numbered their steps as headings ("### 1.", "## 5. Mitigation steps")
failed the numbered-steps check (pi + book on the 9B, OpenCode + book on the
27B). Three 9B OpenCode runbooks had a "Do NOT use when" section, which the
check for "when not to use it" does not recognize (both "+ book" runs and one
plain run). And one 27B pi + book cohort readout was correct but labeled its
cohorts "W20" rather than "2026-W20", as the check requires. We kept the
checks as registered ("What we found and fixed" has the count across every
round). Counting those six trials as passes would put the 9B at pi + book 7,
OpenCode 6 and OpenCode + book 8 of 14, and the 27B at pi + book and
OpenCode + book 10 of 14 each. One runbook of Gezel's request-only arm on the
9B was misread by both checks ("Do NOT use during", and steps numbered as
"## Step 1:" headings); counting it would make that arm 8 of 14.

### A frontier model: Claude Sonnet 5.5

We ran Sonnet twice. The first run sat beside the outside-tool comparison, on
its seven books. Its result led to a second, pre-registered run of all 18
books, described after it.

The first run: the same seven books, two replicates, 126 trials. Gezel ran Sonnet through
its own Anthropic provider; pi and OpenCode each ran it through their own
built-in Anthropic provider with their default settings, so nothing of Gezel
sat in their path. Gezel ran cloud models "one owner, whole recipe" by
default at the time, so that is the control. Passing counts each code book's tests
on the final folder, as above.

| Arm | Passed | Criteria met | Quality | Quality Δ vs one owner | Wall (median min) | Cost per task (median) |
|---|---|---|---|---|---|---|
| Gezel, step by step | 14/14 | 1.00 | 8.11 | −0.05 [−0.25, +0.12] | 2.7 | $0.60 |
| Gezel, one owner, whole recipe | 13/14 | 1.00 | 8.17 | (control) | 1.6 | $0.56 |
| Gezel, recipe as advice | 13/14 | 1.00 | 8.10 | −0.07 [−0.38, +0.27] | 0.8 | $0.13 |
| Gezel, goal only | 14/14 | 1.00 | 8.17 | +0.00 [−0.35, +0.38] | 0.7 | $0.12 |
| Gezel, request only | 10/14 | 0.94 | 7.82 | −0.35 [−0.72, −0.05] | 0.6 | $0.10 |
| pi | 8/14 | 0.83 | 6.90 | −1.26 [−2.73, −0.07] | 0.4 | $0.03 |
| pi + book description | 10/14 | 0.94 | 7.86 | −0.30 [−0.65, −0.02] | 0.4 | $0.03 |
| OpenCode | 9/14 | 0.86 | 7.49 | −0.67 [−1.68, +0.01] | 0.4 | $0.06 |
| OpenCode + book description | 8/14 | 0.92 | 8.07 | −0.10 [−0.34, +0.11] | 0.5 | $0.07 |

Costs are from each tool's own token counts, priced at the rates pi and
OpenCode both carry for Sonnet 5.5 ($2 per million input tokens, $2.50 cache
writes, $0.10 cache reads, $10 output). Gezel does not separate cache writes
from other uncached input, so its figures are upper bounds. The counted trials
cost about $28; with the superseded first outside-tool run, smoke trials and
two stopped starts, the Sonnet work cost about $35.

What this shows:

- **On a frontier model the strategy barely matters for quality.** All four
  Gezel strategies passed 13 or 14 of 14 and scored 8.1 to 8.2. Goal only
  matched the current cloud default on quality at 0.37× the time and about a
  fifth of the cost, because a single conversation with only the contract in
  it reads far less (median 26k uncached input tokens against 161k). Seven
  books are too few to change the cloud default on, so we ran the follow-up
  below.
- **The contract matters even here.** Without it, Gezel passed 10 of 14 and
  lost 0.35 points.
- **Given the same information, the outside tools match Gezel without the
  contract.** With the book description, pi tied Gezel's request-only arm
  exactly on passes (10 of 14 each) and on quality (+0.04 [−0.27, +0.33]).
  OpenCode scored a little higher (+0.25 [+0.02, +0.48]) and passed two
  fewer. Without the description, both trailed: pi by 0.92 points [−2.08,
  +0.04], OpenCode by 0.33 [−1.38, +0.38].
- **What none of them could do was meet a format only the contract states.**
  Every failure of Gezel's request-only arm and of pi with the description
  was a named section the request never asks for: the retrospective's six
  headings, and a "Skipped clients" heading in the invoice summary. Without
  the description, the outside tools also wrote the invoices as Markdown; the
  request names no format, and the contract asks for HTML.
- **The outside tools are much cheaper per task.** Gezel's standing prompt
  (its character, project and tool descriptions) is large; pi's is small. A
  goal-only Gezel task cost about $0.12 against pi's $0.03.

As on the local models, two checks decided passes here. The runbook's
"numbered steps" check accepts only a numbered list. The one failure of
"one owner" and of "recipe as advice" came from it, and so did one of each
OpenCode arm's (those runbooks numbered their steps as headings, "5.1",
"5.2"). One OpenCode + book trial failed cohort-analysis on a
check that misread a correct sentence ("W2 for 2026-W21 is observed … and is
a true 0. W2 for 2026-W22 … is null"). We kept the checks as registered.
Counting those three trials as passes would put OpenCode at 10 and OpenCode
with the description at 10 of 14.

Per book (passed · quality):

| Book | Step by step | One owner | Recipe as advice | Goal only | Request only | pi | pi + book | OpenCode | OpenCode + book |
|---|---|---|---|---|---|---|---|---|---|
| engineering-retrospective | 2/2 · 7.7 | 2/2 · 8.2 | 2/2 · 7.6 | 2/2 · 7.5 | 0/2 · 6.8 | 0/2 · 3.3 | 0/2 · 7.3 | 0/2 · 7.7 | 0/2 · 7.6 |
| refactor-module | 2/2 · 8.1 | 2/2 · 8.2 | 2/2 · 8.2 | 2/2 · 8.2 | 2/2 · 7.6 | 2/2 · 7.1 | 2/2 · 8.2 | 2/2 · 7.2 | 2/2 · 8.2 |
| cohort-analysis | 2/2 · 8.8 | 2/2 · 9.2 | 2/2 · 8.5 | 2/2 · 8.8 | 2/2 · 9.0 | 0/2 · 9.1 | 2/2 · 9.1 | 2/2 · 9.2 | 1/2 · 9.3 |
| runbook | 2/2 · 8.7 | 1/2 · 8.5 | 1/2 · 8.4 | 2/2 · 8.7 | 2/2 · 8.3 | 2/2 · 8.4 | 2/2 · 8.2 | 1/2 · 8.6 | 1/2 · 8.5 |
| invoice-run | 2/2 · 7.8 | 2/2 · 7.8 | 2/2 · 8.5 | 2/2 · 8.7 | 0/2 · 7.5 | 0/2 · 4.8 | 0/2 · 6.8 | 0/2 · 4.3 | 0/2 · 7.3 |
| bug-fix-tdd | 2/2 · 7.5 | 2/2 · 7.3 | 2/2 · 7.5 | 2/2 · 7.1 | 2/2 · 7.3 | 2/2 · 7.5 | 2/2 · 7.3 | 2/2 · 7.5 | 2/2 · 7.4 |
| codemod-sweep | 2/2 · 8.2 | 2/2 · 8.1 | 2/2 · 8.0 | 2/2 · 8.2 | 2/2 · 8.2 | 2/2 · 8.3 | 2/2 · 8.1 | 2/2 · 7.9 | 2/2 · 8.3 |

pi's two cohort-analysis failures were readouts just under the 1,500-byte
floor (1,474 and 1,344 bytes).

The judge is a Claude model judging a Claude model here; comparisons among
these arms share that bias, but Sonnet's scores should not be compared with
Qwen's as levels.

#### The follow-up: all 18 books

We wrote this run down before it started
([frontier-prereg-2026-11-09.md](frontier-prereg-2026-11-09.md)). It ran all
18 books, three replicates, 162 trials, comparing the cloud default at the time with
the two goal-based strategies on a fresh build. Three processes ran side by
side, each with six books and all three arms, so every arm saw the same load.
The seven-book run suggested the question and is not pooled with this one. The decision rule is the
registered one, with "one owner, whole recipe" as the control. A qualifying
result changes only Sonnet's own setting; changing the default for every
cloud model would need a second frontier model measured (the next section).

| Arm | Passed | Criteria met | Quality | Quality Δ vs one owner | Wall (median min) | Cost per task (median) |
|---|---|---|---|---|---|---|
| Gezel, one owner, whole recipe | 48/54 | 0.99 | 8.56 | (control) | 2.2 | $0.43 |
| Gezel, recipe as advice | 51/54 | 1.00 | 8.65 | +0.09 [−0.09, +0.29] | 0.7 | $0.12 |
| Gezel, goal only | 44/54 | 0.99 | 8.69 | +0.12 [−0.04, +0.31] | 0.7 | $0.11 |

The run cost $40.89, plus $1.18 for an uncounted smoke run that checked the
plumbing on the eleven books Sonnet had not run before. Sonnet's work scores
near the top of the scale, where the judge had not been checked, so we
repeated its validity checks on this run. Scoring the same trials twice
varied by a standard deviation of 0.27, and it caught 25 of 27 planted
defects. A second judge agreed with it at α 0.72, but that second judge was
Sonnet judging its own work, so we report that check and do not rely on it.

What this shows:

- **Quality was the same in all three, and the goal-based strategies took a
  third of the time and about a quarter of the cost.** Their wall time was
  0.35× and 0.36× the default's. One conversation holding the contract reads
  far less than a walk through every step (median 27k and 24k uncached input
  tokens against 116k).
- **Under the registered rule, "recipe as advice" qualifies and "goal only"
  does not.** Recipe as advice met every condition (passes +6 points
  [0, +11]). Goal only failed one: its pass-rate interval reached −17 points,
  past the −10 limit.
- **Goal only's shortfall is almost entirely checks misreading correct
  work.** Of the run's 19 failures, 18 were checks rejecting correct work:
  - all 9 market-scan trials, in every arm, for using the word "forecast" in
    a sentence saying the sources give none;
  - four data-quality reports for writing "6 customer records" where the
    check accepts "6 records";
  - two corpus syntheses for an SLA claim their source makes and they cite;
  - three runbooks that numbered their steps as headings.

  The one real failure was a goal-only codemod run that left its review
  notes, naming the old identifier, in the project folder; the recipe would
  have put them in the artifacts drawer. Counting the misreads as passes
  gives 54, 54 and 53 of 54. The only registered strict check that fired
  (runbook numbering) does not change the decision on its own. Counting the
  other misreads is a reading we made after seeing the results, so it does
  not replace the registered decision.
- **For Sonnet, the measured choice is "recipe as advice".** It would replace
  "one owner, whole recipe" through Sonnet's own setting (hosted models have
  no catalog entry, so Gezel keeps a small table of measured ones). Under the
  after-the-fact reading, goal only would win the tie-break on cost by a
  cent; the two are equal on time (1.00×) and quality (−0.03 [−0.14,
  +0.07]), so the practical difference between them is small.

Per-book results are in Appendix B.

### A second frontier model: GPT-6.1 Sol through Codex CLI

The Sonnet pre-registration required a second frontier model before the
default for every cloud model could change. We ran OpenAI's GPT-6.1 Sol,
Gezel's default Codex model. It ran through Gezel's Codex CLI provider, the
way Gezel runs it for a person:

- Codex works through its own tool loop, shell and file editing.
- Gezel supplies its tools beside them, minus the ones Codex already has.
- The model runs at its default reasoning effort (low).

The result is for Sol through Codex, not Sol through OpenAI's API. The run was
written down before it started
([frontier-sol-prereg-2026-11-09.md](frontier-sol-prereg-2026-11-09.md)). It
used the Sonnet follow-up's 18 books, arms, process groups and decision rule:
162 trials, all counted. It was billed to a ChatGPT plan, so costs below are
what the same tokens would cost at OpenAI's list price for Sol, which is the
same as Sonnet's.

| Arm | Passed | Criteria met | Quality | Quality Δ vs one owner | Wall (median min) | Cost per task (median) |
|---|---|---|---|---|---|---|
| Gezel, one owner, whole recipe | 38/54 | 0.98 | 8.28 | (control) | 2.7 | $0.28 |
| Gezel, recipe as advice | 45/54 | 0.99 | 8.43 | +0.15 [−0.02, +0.36] | 1.3 | $0.10 |
| Gezel, goal only | 47/54 | 0.99 | 8.61 | +0.33 [+0.08, +0.67] | 1.1 | $0.07 |

Costs come from a second, registered replicate (one trial per book and arm,
54 trials, $9.24 in all), because Gezel's own token record for Codex was
wrong in the counted run (see "What we found and fixed"). That replicate kept
Codex's own log of every model call. Its passes (12, 16 and 15 of 18) point
the same way as the counted run's. The judge passed its checks on this run:

- scoring the same trials twice varied by a standard deviation of 0.25;
- it caught 27 of 27 planted defects;
- a second judge, Sonnet, agreed with it at α 0.61, just past the 0.6 the
  pre-registration required. The two agreed least on grounding.

Both judges are Anthropic models judging an OpenAI model. Comparisons among
Sol's strategies share whatever preference that gives, and Sol's scores
should not be compared with Sonnet's as levels.

What this shows:

- **Both goal-based strategies did at least as well as one owner, in half the
  time or less, at about a third of the cost or less.** Goal only did
  better:
  - judged quality was 0.33 points higher [+0.08, +0.67];
  - it passed 17 points more often [+2, +35]: 10 pairs passed only goal
    only, 1 pair only one owner;
  - it was cheaper than one owner on every book.
- **Under the registered rule both qualify, and goal only wins.** When both
  qualify, the cheaper wins unless their quality differs, and here it does:
  recipe as advice scored 0.18 lower than goal only [−0.40, −0.03]. Goal
  only is also the cheaper of the two ($0.07 against $0.10). The quality
  results do not rest on codemod-sweep, the book where one owner scored
  lowest; without it, goal only leads one owner by +0.20 [+0.05, +0.41], and
  recipe as advice trails goal only by −0.09 [−0.18, −0.01].
- **Most of one owner's failures were real; most of the others' were not.**
  We read all 32 failures.
  - One owner: 6 of its 16 were checks misreading correct work, or a strict
    one.
    - Three times, the rename rewrote the brief that defined it ("Rename
      brief: loadUser -> loadUser").
    - Four times, Sol paused its own task when the recipe's review or final
      check failed it. On the runbooks, its evaluation failed its own
      runbook for what the incident brief does not supply: paging routes,
      and an approved way to pause and resume the consumers.
    - Three times, the runtime paused the task after the citation check
      rejected a reference list of plain file paths. Two of those pauses
      are a Gezel defect described below.
  - Recipe as advice: 6 of its 9 were misreads. Two of the others were the
    same rename mistake, and one report never cited its brief.
  - Goal only: all 7 of its failures were misreads.
  - Counting misreads as passes gives 44, 51 and 54 of 54.
- **The registered secondary analysis agrees.** With the corrected checks
  frozen before the run, the passes are 40, 47 and 52 of 54, and the
  decision does not change.
- **The two frontier models agree on direction, not on which variant.**
  - Sonnet's registered pick was recipe as advice. Its goal-only shortfall
    was checks misreading correct work.
  - Sol's is goal only.
  - Both prefer a goal-based strategy to Gezel's previous cloud default,
    which is the condition the Sonnet pre-registration set for changing it.
- **The change: every cloud model nobody measured now runs goal only**
  (since 2026-11-10), as on-device models have since 2026-11-04. Sonnet and
  Sol keep their own measured picks. Goal only was Sol's registered pick; it
  cost less than the recipe as advice on both models, was faster on Sol and
  as fast on Sonnet, and matched it on Sonnet's judged quality. The other
  reading is fair too: the recipe as advice is the strategy that cleared the
  registered rule on both models, and goal only missed it on Sonnet, by checks
  misreading correct work. No cloud model other than these two was measured.

Per-book results are in Appendix B.

## What we found and fixed along the way

Measuring the strategies meant reading thousands of trial logs, and many
failures turned out to be bugs rather than model limits. In the interest of
honesty, here is what changed between rounds, and whom each fix helped.

**In the measurement:**

- The judge was shown folder deliverables (code, invoices) as missing and
  scored them 0. Because both arms of a pair scored 0, the paired deltas hid
  it. Fixed in judge version 3; 273 trials re-judged.
- Seven test checks were stricter than their book asked for (a heading
  phrasing, a regex). Fixed before round 1; affected trials re-graded.
- Eight checks still misread correct work in the counted trials. We kept them
  as registered rather than change a test after seeing results, and report
  the effect here. Each one was the only failure in the trials listed:
  - **Runbook, numbered steps.** It accepts only a numbered list, and failed
    20 runbooks whose steps were numbered as headings or bold labels ("### Step
    1:", "**Step 1.**"), 16 of them Gezel arms.
  - **Runbook, "when not to use it".** It does not recognize "Do NOT use
    when", and failed six runbooks that had such a section, four of them in
    the outside-tool comparison. In one round-3 step-by-step run, Gezel's own
    end-of-task check misread it the same way, so that task never finished.
  - **Data-quality audit, row count.** It accepts "6 records" but not "6
    customer records" or "Records audited: 6" (seven trials, four of them in
    the Sonnet follow-up).
  - **Corpus synthesis, invented details.** It flagged an SLA claim the
    seeded source makes and the synthesis cites (three trials), and "target
    return rates" in a sentence saying the corpus gives none (one trial).
  - **Market scan, forecasts.** It flagged the word "forecast" in sentences
    saying the sources give none (all nine Sonnet follow-up trials). The same
    check's other matches, such as "robust" or "projected to grow", were the
    check working as written.
  - **Cohort analysis.** One check read on past the end of a correct
    sentence into the next one, and three checks required the "2026-" prefix
    where a correct readout wrote "W20" (one trial each, both outside tools).
  - **Engineering retrospective, ranking.** It flagged "rank people" and
    "performance score" in sentences saying the retrospective does neither
    ("are not used to rank people"): one round-1 recipe-as-advice trial on
    Qwen 3.8 27B, and one Sol trial. We found this one only while correcting
    the checks after the Sol run.

  In the pooled goal-only against step-by-step comparison, these checks
  failed five goal-only trials and two step-by-step trials. Counting them as
  passes would make it 162 against 129 of 228, instead of 157 against 127.

  We have since written corrected versions of the first seven: Gilde version
  1.0.6 of the five books, not yet published. A check that forbids invented claims
  now ignores a term in a sentence that negates it or names it as a gap,
  rather than matching the bare word. We replayed old and corrected checks
  over every recorded deliverable of those books, 545 in all, smoke runs
  included, and read each one whose verdict changed: every change is a
  misread of the kinds listed above, and every other failure still fails,
  including invented forecasts such as "projected to grow robustly at a rate
  of 12%". Re-grading the counted Gezel trials with them reproduces the pooled
  162 against 129 mechanically (`corrected-lib.mts`, beside the report's
  build script).

  The Sol run, graded after the corrections were frozen, showed they are not
  complete. Four Sol market scans still failed on cautions the corrected
  check does not recognize: three on "forecast" ("Avoid converting these
  directional signals into precision forecasts", "before attaching revenue
  forecasts") and one on "seamless" ("validate integration requirements
  before promising seamless returns/refunds automation"). One Sol trial
  wrote the row count as "6 CSV data rows". Sol also met two checks no
  earlier run had tripped:
  - a data-quality section headed "Failing evidence", where the check
    accepts only "failing examples" and similar (two trials, both listing
    every failing row);
  - a retrospective check that requires its six sections in the listed
    order, where the contract checks only that each is there (two trials
    with "Evidence limits" before "Experiments").

  Gilde 1.0.7 of market-scan and data-quality-audit and 2.0.19 of
  engineering-retrospective, also not yet published, correct those and the
  ranking check. A caution ("avoid", "rather than", "before promising") now
  counts like a negation, but only when it comes before the term: a
  negation after a marketing term ("specialized tools, not generic
  software") does not excuse it. "Failing evidence" counts as a failing-rows
  section, up to two words may stand between "6" and "rows", and the
  sections may come in any order. We replayed the old and new checks over
  every recorded deliverable of the three books (90 market scans, 105 audits
  and 179 retrospectives) and read each changed verdict. All 16 that changed
  went from fail to pass, and each was a misread: the Sol trials above (11,
  the cost replicate's one included), the round-1 Qwen trial, two
  outside-tool trials that fail on other checks anyway, one uncounted pilot
  trial and one superseded Sonnet trial. One draft of the market-scan
  correction would have passed a real failure, a $420M market claim, and was
  narrowed before this replay. The registered results above stay as they
  are.
- In the outside-tool comparison, one setting meant to skip a Gezel-only check
  for outside tools applied only when the outside tool ran first; 16 pi trials
  were re-graded from their recorded verdicts.
- The check that ends an outside tool's trial read "is it still running?"
  twice, so a tool that exited in between was marked unfinished beside
  complete work. It hit one Sonnet pi trial, which is counted as passed; the
  harness now reads it once.
- The first outside-tool run gave pi and OpenCode the project description
  exactly as Gezel sees it. The eval harness adds a section to that
  description listing the input files and required deliverables, worded for
  Gezel: read inputs "with the workspace `read_file` tool", write some
  deliverables "with `write_artifact`" into "the project artifacts drawer".
  The outside tools have neither. Some searched the machine for the drawer.
  On codemod-sweep the section also asked for four notes files that Gezel
  keeps in the drawer and nobody grades. The outside tools wrote them into the
  repository, and the book's own check that the old name is gone then failed
  on those notes. That run also left out the project's mission objectives,
  which Gezel puts in every session. Both gaps favored Gezel. We reran every
  outside-tool arm, on all three models, with the same facts in plain words
  and the objectives included; only the rerun is reported. Appendix C lists
  the first run's figures beside the rerun's, so the size of the correction is
  visible.
- The outside tools' sandbox hid every home folder but not a system-wide Gezel
  install, which keeps the catalog and its grading checks. Looking for the
  craftbook their request named, or the drawer the description named, 14 of
  the first run's 168 outside-tool trials searched outside their folder. An
  audit of every outside-tool trial's tool calls and outputs
  (`audit-outside-reads.py`) found that none received grading content. The
  sandbox now hides the install. Repeated on the rerun before it was graded,
  the audit found 13 of 168 trials searching outside their folder, and again
  none that received grading content.
- One scenario object serves every trial of a book in a run, and after the
  first trial it narrows its list of required files to the contract's final
  deliverables. So the first trial of each book in each run was also asked for
  the recipe's working files (for the retrospective, a scope and an evidence
  file), and later trials were not. That was 54 of the 1,098 trials in
  rounds 1 to 3 and 31 of the outside-tool comparison's 294, spread over
  every arm. Those files are never graded and arm order rotates, so no arm
  is favored, but the instructions were not identical.
- In rounds 1 and 2, the goal-based owner was given a wider tool list than a
  step-by-step specialist, because of how the eval installed tools. That made
  its prompts heavier, so it worked against the strategy that won. Fixed
  before round 3.
- Gezel's token record for Codex was wrong in two ways, so the Sol run's
  costs come from a separate replicate that kept Codex's own log of every
  model call.
  - The harness stops a trial the moment its checks pass, usually while
    Codex is still writing its closing message. Codex reports a turn's
    tokens only when the turn ends, so that turn recorded nothing. A task
    done in one turn recorded nothing at all: 59 of the 108 goal-based Sol
    trials showed zero tokens.
  - When Gezel continues a Codex conversation, Codex reports the
    conversation's running total, and Gezel added each running total as if
    it were one turn. In every replicate trial that finished a turn, Gezel's
    record equals that sum exactly. This overstated every conversation of
    more than one turn, which in the replicate was every one-owner trial.

  The harness stopping early changed nothing else. Every Sol task that
  completed did so through Sol's own call to finish the step, so the graded
  files and the wall time are the ones Sol handed in. The Anthropic provider
  is not affected the same way: no Sonnet trial had a turn still running when
  it was stopped, so the Sonnet costs stand.

**In the product** (each fix applies to every strategy that hits it):

- A first-message rule that rushed small models into writing a file, which
  stopped refactor-module's recipe-following runs (step by step and one owner)
  in under two minutes. Fixed, and the 14 affected round-1 trials re-run.
- A plan check that rejected a plan for naming the file it was about to create
  (step by step only).
- Evidence markers written into saved documents without their source list;
  invalid YAML that no check caught; a review verdict misread because of a
  sources list beneath it; a document tool that failed a "replace" of a file
  that did not exist yet (fixed upstream in DocBlocks 2.7.13).
- Gezel hides its own file-writing and shell tools from Codex, because Codex
  has its own, but nothing told the model. Where a recipe step said to write
  a test with `write_file`, Sol reported the tool missing and stopped. The
  smoke run caught it before the counted run, and it hurt only the arms that
  read the recipe. Codex sessions are now told to use Codex's built-in editing
  and shell for that work.
- Codex token counts: each turn is now charged only what it added to the
  conversation. A measured cloud strategy now also applies when nobody
  picked a model and the provider runs its own default (Sol, for Codex).

Found in the Sol runs and fixed afterward, so no counted trial ran with
these fixes. All three affect only multi-step tasks:

- **A finished turn moving the task.** When a review sent the task back to
  an earlier step, the review's own turn, still running, approved that
  earlier step as it ended, on the file its first pass had left. The next
  turn re-judged the unchanged work. That is how one real rejection became
  "4 identical rejections" and a plateau pause. The same stale turns also
  had their handoffs retried and counted as failed, which paused two other
  tasks, and opened a second conversation for the one owner. A turn now
  moves, retries and pauses only the step and pass it was started for.
- **A sub-task stuck without saying so.** A fan-out sub-task that ended its
  turn reporting a blocker stayed active, and its parent waited for it. It
  would have been re-driven after eight minutes of silence, three times,
  before pausing. It now gets two immediate retries and then pauses for
  help, quoting the blocker. A parent whose only unfinished sub-tasks are
  paused now pauses too, naming them, where before it was re-driven into a
  check only those sub-tasks could satisfy.
- **The same hidden-tool gap on the Claude CLI.** Like Codex, the Claude
  CLI provider hides Gezel's file, shell and web tools because Claude Code
  has its own, and it also hides the file readers. Nothing told the model
  so. It is now told which of its own tools stands in for each. This was
  found by reading the code; no Claude CLI run was affected or measured.

Later rounds therefore measure a better product than earlier ones, and the
pooled figures mix builds. Within each round, every arm ran on one build.

## Limitations

- **One machine, one engine, 4-bit models.** Speed figures in particular are
  specific to a DGX Spark running llama.cpp.
- **Our tasks, our contracts, our judge.** The books, contracts and tests were
  written by the people who built the strategies. The contract is visible to
  some arms and not others, and both the grader and the judge score against
  it (see the ablation).
- **The judge is a Claude model.** Comparisons between strategies on the same
  model are not affected by that; comparing Sonnet's or Sol's absolute scores
  with each other's, or with Qwen's, may be. On Sol the second judge agreed
  with the first at α 0.61, just past the bar, and least on grounding.
- **Small cells.** The outside-tool comparison and the first Sonnet run use
  seven books and two replicates. Read their intervals, not their point
  estimates. The two frontier runs used all 18 books and three replicates,
  one model each. Sol's costs come from a single replicate.
- **Sol was measured through Codex CLI,** with Codex's own tools and at its
  default reasoning effort (low; Sonnet ran at high). Sol through OpenAI's
  API, or at another effort, is unmeasured, and so is any other cloud model
  or provider.
- **The "goal only" arms were not recipe-free.** See "An information gap".
- **On device, generalist was measured only in round 1,** and the large on-device tier in
  the original plan (Nemotron 3.5 Super) was never run.
- **Outside tools ran with small, disclosed differences** from a person's own
  setup: in a sandbox, with web tools denied, OpenCode's language-server
  downloads off and ripgrep 15.0.0 supplied; pi reached the model through
  Gezel's OpenAI-compatible endpoint rather than Gezel's dedicated pi bridge.

## Reproducing

The harness is `pnpm eval:ab-strategy` in the Gezel repository
(`evals/src/strategy/`). The pre-registrations and their amendments are in
[strategy-prereg-2026-10-22.md](strategy-prereg-2026-10-22.md), for the
outside-tool and first Sonnet comparisons
[outside-tools-prereg-2026-11-08.md](outside-tools-prereg-2026-11-08.md), for
the Sonnet follow-up
[frontier-prereg-2026-11-09.md](frontier-prereg-2026-11-09.md), and for the
Sol run [frontier-sol-prereg-2026-11-09.md](frontier-sol-prereg-2026-11-09.md);
the design is in [task-strategies.md](../task-strategies.md). Sol's cost
replicate is under `evals/runs/frontier-sol-2026-11-09/cost-trials/`, each
trial with its Codex logs (`codex-rollouts/`), priced by
`evals/runs/report-2026-11/cloud-cost.mts`. Books and contracts are in the
`@bendyline/gilde` catalog: version 0.3.6 carries all 18 books, contracts and
tests byte for byte as the outside-tool, Sonnet and Sol comparisons ran them.
Earlier rounds ran earlier versions of the same books, and each trial records
the version it used. Each trial's record (its log, the deliverables, the
grades and the judge's three samples) is under `evals/runs/`.
`evals/runs/report-2026-11/build.mts` rebuilds every number in this report
from those records, and `corrections.json` beside it lists each after-the-fact
correction applied. PENDING (owner): where the trial records are published.
They come to about 32 GB, 27 GB of which is the packages OpenCode downloaded
into each trial's own home and config folders; a public copy can leave those
out.

## Appendix A: the runbook prompts in full

Read from recorded Qwen 3.8 27B trials by `evals/runs/report-2026-11/prompts.mts`. Each Gezel arm also carries the rest of Gezel's standing system prompt (the gezel's character and the tools available), which is the same across the Gezel arms and is not shown; the project section is shown below.

### The request (every arm)

````text
In the `Runbook Eval` project, read `source/incident-brief.md` and write `runbook.md`: an on-call procedure for clearing a webhook retry backlog. Include when to use and when not to use it, prerequisites, pre-flight checks, numbered mitigation steps with expected output and verification, rollback, escalation, warnings for risky actions, and a final resolved checklist.
````

### First message to the gezel (goal only; the other Gezel arms differ in the step list at the end)

````text
Task runbook-eval/1 ("On-call runbook for webhook backlog") was just created from the **Ops Runbook** craftbook. Write an operational runbook or playbook a tired on-call engineer can follow at 3am without thinking — covering when to use it, prerequisites, numbered step-by-step procedures, verification, rollback, and escalation. Scopes the exact scenarios and prerequisites FIRST, writes unambiguous copy-pasteable steps with expected output and verification at each stage, then has a reviewer pressure-test it for gaps and dangerous ambiguity. Use for incident response, deploy/rollback procedures, and recurring ops tasks.

A gallery craftbook generated from an archetype spec. It runs
`phase → (per-phase gate) → … → evaluate → (loop) → finish`. Each build
phase that produces a checkable artifact is followed by a **runtime
gate-checkpoint** — the runtime verifies the artifact and routes with no
model turn, looping back to redo the phase on a miss. The final `evaluate`
step holds a static deliverable gate plus a reviewer QA pass. What it adds
over the generic `build-loop`: a specialist role per phase, a
domain-correct ordering, and a concrete per-phase quality bar.

Deliverables marked "artifact" land in the project's artifacts drawer (`write_artifact` / `read_artifact`), not the shipped workspace — review output is not product source.

Phases:

1. Scope the runbook (planner) — trigger scenarios, prerequisites, success/rollback definition → gated on artifact `{{workPath}}/scope.md` (markdown-notes)
2. Write the runbook (copywriter) — numbered, copy-pasteable steps with expected output + verification → gated on `runbook.md` (markdown-doc)
3. Review for gaps (reviewer) — pressure-test the runbook for ambiguity and missing safety rails → gated on artifact `{{workPath}}/review.md` (markdown-notes)

The gates never advance with an unmet criterion, and loop back to the
owning phase to fix named gaps.

Its steps:
1. Deliver the outcome — An on-call runbook a tired engineer can follow literally: when to use it and when not to, prerequisites, numbered copy-pasteable steps that each say what to expect and how to verify it, warnings before risky steps, a rollback, and an escalation path. ← your step

You've been assigned task runbook-eval/1 (step `outcome`). Follow the step instructions already in your prompt — start with the first tool call they name, then keep working through the procedure. Append focused notes with `write_task_note` as you go. When the step is done, call `advance_task_step` to hand off to whoever's next.
````

### Goal only: the step prompt

````text
Deliver the outcome the **Task contract** describes. You own all of it, in this one conversation, and you choose how to get there: work directly toward deliverables that meet the bar.

When teammate tools (`consult_<role>`) are among your tools, you may hand a self-contained piece of the work to a teammate: say exactly which files to read and which to write. They work in this project and answer within your turn. You stay responsible for the deliverables, so check what they wrote.

When every deliverable is in place, call advance_task_step once. The runtime checks the contract and names anything unmet; fix exactly that and call it again.
````

### Goal only and recipe as advice: the contract block in the system prompt

````text
### Task contract

Goal: An on-call runbook a tired engineer can follow literally: when to use it and when not to, prerequisites, numbered copy-pasteable steps that each say what to expect and how to verify it, warnings before risky steps, a rollback, and an escalation path.

Deliverables:
- `runbook.md` — The runbook, in Markdown.

Quality bar:
- The runbook is a complete document organized under headings [checked]
- It says when to use it and when not to [checked]
- It lists prerequisites (access, tools, safety checks) before the procedure [checked]
- The procedure is written as numbered steps [checked]
- Commands are written out exactly in code formatting, ready to copy and paste [checked]
- It has a rollback section [checked]
- It has an escalation section [checked]
- Steps say what output to expect and how to verify each one worked [checked]
- Risky or destructive steps carry a warning before them [checked]
- Nothing is left unfinished: no TBD, TODO or FIXME [checked]
- Each step is unambiguous and in order, rollback and escalation name real commands, people and timings, and it ends with a checklist that confirms the issue is fully resolved
- Commands, thresholds, names and contacts come from what the person supplied; anything unknown is a clearly marked placeholder, not an invention

The runtime checks the [checked] items before the task can finish and names anything unmet.
````

### Recipe as advice: the step prompt

The same opening as goal only, followed by every original step. The step-by-step arm runs these same step texts one at a time, each in its own conversation.

````text
Deliver the outcome the **Task contract** describes. You own all of it, in this one conversation, and you choose how to get there: work directly toward deliverables that meet the bar.

When teammate tools (`consult_<role>`) are among your tools, you may hand a self-contained piece of the work to a teammate: say exactly which files to read and which to write. They work in this project and answer within your turn. You stay responsible for the deliverables, so check what they wrote.

When every deliverable is in place, call advance_task_step once. The runtime checks the contract and names anything unmet; fix exactly that and call it again.

#### Recommended approach (advisory)

The recipe this outcome usually follows. Use what helps; reorder, merge or skip parts when you can reach the outcome more directly. Files it writes along the way are optional unless the contract lists them. Where it says to advance a step, move on to the next part; advance the task only once, at the end.

##### 1. Scope the runbook

Define what the runbook covers before writing steps. Step 1: state the exact scenario(s) this runbook handles and, just as importantly, when NOT to use it. Step 2: list prerequisites — access/permissions, tools, environment, and any 'before you start' safety checks. Step 3: define what SUCCESS looks like (the verification signal that the procedure worked) and the conditions that should trigger a rollback or escalation. Step 4: outline the procedure as named stages in order (e.g. assess -> mitigate -> verify -> communicate), each to be expanded into numbered steps. Step 5: identify the destructive/irreversible steps that need an explicit warning. Step 6: write an acceptance-criteria checklist ('states when to use AND when not to', 'prerequisites + access listed', 'every stage has a verification step', 'a rollback procedure exists', 'escalation path with who/when', 'destructive steps carry a warning'). Write the scope + checklist via write_task_note AND to tasks/1/scope.md. No detailed steps yet.

The deliverable `tasks/1/scope.md` lands in the project's artifacts drawer — write it with `write_artifact` and read it back with `read_artifact`; the shipped workspace stays untouched.

##### 2. Write the runbook

Write the runbook as runbook.md so a stressed on-call engineer can follow it literally. Step 1: open with a header block — purpose, when to use / when not to use, severity, and an at-a-glance summary. Step 2: write the prerequisites and a pre-flight checklist. Step 3: write each stage as explicitly NUMBERED steps; commands go in fenced code blocks ready to copy-paste, with placeholders clearly marked (e.g. <SERVICE_NAME>), and EACH step states the expected output and how to verify it before moving on. Step 4: add bold warning callouts before any destructive/irreversible step. Step 5: write a dedicated Rollback section (numbered, also verified) and an Escalation section naming who to contact, when, and how. Step 6: end with a 'how to confirm fully resolved' checklist. Keep sentences short and imperative; no ambiguity about which step to run when. On a loop-back, fix ONLY the named gaps. Write the path + stage/step counts via write_task_note.

##### 3. Review for gaps

Pressure-test the runbook as if you must execute it half-asleep. Step 1: read every step and flag any that is ambiguous, assumes unstated context, or could be run out of order. Step 2: verify every destructive step has a warning and every stage has a verification signal. Step 3: confirm the rollback and escalation sections are actionable (real commands/contacts, not placeholders like 'contact the team'). Step 4: list concrete gaps with the exact step number and the fix needed. Step 5: write a review-findings note recording each gap as PASS/FAIL against the scope checklist. Write the findings via write_task_note AND to tasks/1/review.md. If gaps remain, they must be fixed in the write phase before this passes.

The deliverable `tasks/1/review.md` lands in the project's artifacts drawer — write it with `write_artifact` and read it back with `read_artifact`; the shipped workspace stays untouched.

##### 4. Evaluate

QA the runbook against the locked criteria. Step 1: read runbook.md and simulate following it step by step for the primary scenario. Step 2: check EACH acceptance criterion: states when to use and when not to, prerequisites + access listed, every stage has numbered steps with expected output and a verification, destructive steps carry warnings, a working rollback section exists, and an escalation path names who/when/how. Step 3: confirm there are no ambiguous steps or unresolved placeholders in the rollback/escalation sections. Step 4: incorporate the review findings from tasks/1/review.md. Write PASS/FAIL per criterion with the offending step number on any FAIL.

Then record your verdict — this is the whole point of the loop:

1. If any criterion fails, first write the specific gaps to the task notes with `write_task_note`: which file, which part, and what is missing. The "Write the runbook" step reads them when it fixes the work.
2. When you have graded every criterion, write `tasks/1/verdict.md` with `write_artifact`. One line per criterion and no preamble: the criterion, its one-line reason, then PASS or FAIL as the last word on the line. Writing verdict.md completes this step.

The runtime routes on the verdict: every line PASS moves the task to "Finish"; any FAIL sends it back to "Write the runbook" to fix those gaps, and a review that keeps failing pauses the task for the user. Mark a criterion PASS only when it is met. The build phase's completion gate already blocked a grossly-incomplete deliverable; your job is the judgment an automated check cannot make (does it actually work, read well, look right).

##### 5. Finish

Every acceptance criterion passed. Write a one-paragraph DONE summary to task notes via `write_task_note`: what was built, the deliverable path(s), and a one-line confirmation that each criterion is met. Then report DONE.
````

### Request only: the step prompt (no contract block)

````text
Deliver what the request asks for. You own all of it, in this one conversation, and you choose how to get there.

When teammate tools (`consult_<role>`) are among your tools, you may hand a self-contained piece of the work to a teammate: say exactly which files to read and which to write. They work in this project and answer within your turn. You stay responsible for the deliverables, so check what they wrote.

When the work is done, call advance_task_step once.
````

### The project, as the Gezel arms saw it

Every Gezel arm gets the project's description and mission objectives in its system prompt. The eval harness adds the paragraph listing inputs and deliverables.

````text
### About this project

Self-contained eval project for runbook. The operational scenario is seeded in workspace/source/incident-brief.md.

### Eval harness rules

This is a self-contained craftbook eval project. Source paths are project workspace paths; declared artifact outputs live in the project artifacts drawer.

Seeded workspace inputs: `source/incident-brief.md`. Read them with the workspace `read_file` tool, not artifact/document/library tools.

Required workspace deliverable: `runbook.md`. Chat summaries, artifacts, plans, and task notes do not satisfy workspace file deliverables.

### Mission objectives

Write a copy-pasteable on-call runbook with safety rails, verification after each stage, rollback, escalation, and no unresolved placeholders.
Use the requested craftbook/template when available, then execute the work in this project until the deterministic eval outputs exist.
Land the final workspace file at the exact workspace-root-relative path: `runbook.md`.
If invoking the craftbook creates a task, do not stop after creating or assigning it; carry out the active step or hand it to an appropriate gezel with an explicit expected file deliverable.
````

### pi and OpenCode

The request is the message. Appended to the tool's system prompt, the same project facts without Gezel's vocabulary (the mission lines about craftbooks and tasks are Gezel's own and are left out):

````text
## About this project

Self-contained eval project for runbook. The operational scenario is seeded in workspace/source/incident-brief.md.

### Project files

Every path here is relative to the project folder.

Inputs: `source/incident-brief.md`.

Required deliverable: `runbook.md`. A summary in your reply does not count; the file has to exist at that path.

## Mission objectives

Write a copy-pasteable on-call runbook with safety rails, verification after each stage, rollback, escalation, and no unresolved placeholders.
````

The `-book` arms also append:

````text
## The craftbook for this request

This request comes with the **Ops Runbook** craftbook. Write an operational runbook or playbook a tired on-call engineer can follow at 3am without thinking — covering when to use it, prerequisites, numbered step-by-step procedures, verification, rollback, and escalation. Scopes the exact scenarios and prerequisites FIRST, writes unambiguous copy-pasteable steps with expected output and verification at each stage, then has a reviewer pressure-test it for gaps and dangerous ambiguity. Use for incident response, deploy/rollback procedures, and recurring ops tasks.

A gallery craftbook generated from an archetype spec. It runs
`phase → (per-phase gate) → … → evaluate → (loop) → finish`. Each build
phase that produces a checkable artifact is followed by a **runtime
gate-checkpoint** — the runtime verifies the artifact and routes with no
model turn, looping back to redo the phase on a miss. The final `evaluate`
step holds a static deliverable gate plus a reviewer QA pass. What it adds
over the generic `build-loop`: a specialist role per phase, a
domain-correct ordering, and a concrete per-phase quality bar.

Deliverables marked "artifact" land in the project's artifacts drawer (`write_artifact` / `read_artifact`), not the shipped workspace — review output is not product source.

Phases:

1. Scope the runbook (planner) — trigger scenarios, prerequisites, success/rollback definition → gated on artifact `{{workPath}}/scope.md` (markdown-notes)
2. Write the runbook (copywriter) — numbered, copy-pasteable steps with expected output + verification → gated on `runbook.md` (markdown-doc)
3. Review for gaps (reviewer) — pressure-test the runbook for ambiguity and missing safety rails → gated on artifact `{{workPath}}/review.md` (markdown-notes)

The gates never advance with an unmet criterion, and loop back to the
owning phase to fix named gaps.
````


## Appendix B: per-book results

### Goal only against step by step, every round pooled

The pool behind the headline (Gemma 4 E4B, Qwen 3.5 9B, Qwen 3.8 27B; every round in which both strategies ran). Passes, mean judged quality, and the ratio of median wall times. Descriptive: the cells are small.

| Book | Kind | Pairs | Goal only: passed | Step by step: passed | Goal only: quality | Step by step: quality | Wall |
|---|---|---|---|---|---|---|---|
| ab-test-readout | Data | 11 | 7/11 | 7/11 | 6.3 | 6.1 | 0.80× |
| alert-rules | Operations and communication | 11 | 2/11 | 4/11 | 5.7 | 5.5 | 0.30× |
| bug-fix-tdd | Code | 11 | 11/11 | 9/11 | 6.8 | 6.6 | 0.19× |
| codemod-sweep | Code | 11 | 11/11 | 4/11 | 8.1 | 6.3 | 0.09× |
| cohort-analysis | Data | 16 | 9/16 | 5/16 | 5.5 | 3.7 | 0.41× |
| content-accuracy-review | Research and documents | 11 | 9/11 | 10/11 | 8.0 | 7.1 | 0.33× |
| corpus-synthesis | Research and documents | 11 | 9/11 | 3/11 | 6.1 | 4.2 | 0.44× |
| csv-transformer | Data | 11 | 10/11 | 10/11 | 9.5 | 9.9 | 0.42× |
| data-quality-audit | Data | 11 | 2/11 | 3/11 | 5.5 | 4.7 | 0.56× |
| engineering-retrospective | Research and documents | 16 | 10/16 | 1/16 | 5.3 | 5.4 | 0.18× |
| html-arcade-game | Several deliverables | 11 | 10/11 | 9/11 | 5.2 | 4.5 | 0.40× |
| invoice-run | Several deliverables | 16 | 15/16 | 11/16 | 6.9 | 5.1 | 0.35× |
| market-scan | Research and documents | 11 | 5/11 | 6/11 | 6.1 | 6.0 | 0.30× |
| powerpoint-deck | Research and documents | 16 | 10/16 | 15/16 | 4.5 | 6.0 | 0.62× |
| press-release | Operations and communication | 11 | 3/11 | 3/11 | 5.8 | 7.0 | 0.29× |
| refactor-module | Code | 16 | 13/16 | 8/16 | 7.1 | 5.3 | 0.30× |
| research-report | Research and documents | 11 | 10/11 | 8/11 | 7.6 | 7.8 | 0.46× |
| runbook | Operations and communication | 16 | 11/16 | 11/16 | 6.2 | 5.7 | 0.10× |

### Round 1, every book, model and strategy

Passed / trials · mean judged quality. Qwen 3.8 27B ran three replicates, the others two.

**Gemma 4 E4B**

| Book | Step by step | One owner, whole recipe | Goal, recipe as advice | Goal only |
|---|---|---|---|---|
| research-report | 1/2 · 6.4 | 0/2 · 6.7 | 1/2 · 6.7 | 2/2 · 7.4 |
| powerpoint-deck | 1/2 · 3.1 | 1/2 · 3.3 | 0/2 · 0.5 | 0/2 · 1.1 |
| corpus-synthesis | 0/2 · 0.0 | 0/2 · 0.0 | 0/2 · 6.2 | 2/2 · 6.1 |
| market-scan | 1/2 · 5.3 | 1/2 · 5.5 | 0/2 · 5.3 | 0/2 · 5.6 |
| content-accuracy-review | 2/2 · 5.7 | 0/2 · 7.3 | 1/2 · 7.5 | 2/2 · 7.6 |
| engineering-retrospective | 0/2 · 4.7 | 0/2 · 2.2 | 1/2 · 5.4 | 1/2 · 3.7 |
| bug-fix-tdd | 2/2 · 6.4 | 2/2 · 6.2 | 2/2 · 6.2 | 2/2 · 6.3 |
| refactor-module | 1/2 · 3.8 | 0/2 · 5.0 | 2/2 · 6.9 | 1/2 · 5.5 |
| codemod-sweep | 0/2 · 5.5 | 1/2 · 6.8 | 2/2 · 7.7 | 2/2 · 8.2 |
| ab-test-readout | 1/2 · 5.0 | 0/2 · 5.0 | 1/2 · 5.5 | 1/2 · 5.4 |
| cohort-analysis | 0/2 · 0.0 | 0/2 · 0.0 | 0/2 · 1.9 | 0/2 · 2.0 |
| data-quality-audit | 0/2 · 3.4 | 0/2 · 3.5 | 0/2 · 3.3 | 0/2 · 4.3 |
| csv-transformer | 2/2 · 9.8 | 2/2 · 9.9 | 2/2 · 9.9 | 1/2 · 9.4 |
| alert-rules | 1/2 · 5.5 | 0/2 · 4.7 | 1/2 · 5.5 | 0/2 · 5.3 |
| runbook | 2/2 · 6.8 | 1/2 · 5.4 | 2/2 · 5.3 | 1/2 · 6.1 |
| press-release | 0/2 · 6.3 | 0/2 · 7.0 | 0/2 · 6.7 | 0/2 · 5.2 |
| invoice-run | 2/2 · 4.3 | 2/2 · 4.5 | 2/2 · 6.0 | 1/2 · 4.4 |
| html-arcade-game | 1/2 · 3.8 | 2/2 · 5.3 | 1/2 · 4.4 | 2/2 · 5.0 |

**Qwen 3.5 9B**

| Book | Step by step | One owner, whole recipe | Goal, recipe as advice | Goal only |
|---|---|---|---|---|
| research-report | 1/2 · 7.7 | 0/2 · 7.9 | 2/2 · 7.4 | 1/2 · 6.9 |
| powerpoint-deck | 2/2 · 5.5 | 2/2 · 6.0 | 2/2 · 5.6 | 1/2 · 4.4 |
| corpus-synthesis | 0/2 · 6.2 | 1/2 · 5.4 | 1/2 · 6.4 | 2/2 · 5.3 |
| market-scan | 1/2 · 5.6 | 1/2 · 5.1 | 0/2 · 5.5 | 0/2 · 5.5 |
| content-accuracy-review | 2/2 · 7.5 | 2/2 · 7.7 | 2/2 · 5.5 | 2/2 · 7.9 |
| engineering-retrospective | 0/2 · 5.0 | 2/2 · 5.0 | 1/2 · 5.0 | 1/2 · 4.9 |
| bug-fix-tdd | 1/2 · 6.2 | 2/2 · 5.8 | 2/2 · 7.0 | 2/2 · 6.6 |
| refactor-module | 0/2 · 2.6 | 0/2 · 2.8 | 1/2 · 3.5 | 1/2 · 6.1 |
| codemod-sweep | 1/2 · 4.5 | 2/2 · 8.1 | 2/2 · 8.0 | 2/2 · 8.2 |
| ab-test-readout | 1/2 · 5.5 | 1/2 · 6.1 | 0/2 · 4.8 | 1/2 · 6.4 |
| cohort-analysis | 0/2 · 3.8 | 2/2 · 6.4 | 0/2 · 3.3 | 2/2 · 6.4 |
| data-quality-audit | 0/2 · 3.9 | 0/2 · 3.2 | 0/2 · 4.7 | 0/2 · 5.9 |
| csv-transformer | 2/2 · 10.0 | 2/2 · 10.0 | 1/2 · 7.8 | 2/2 · 8.1 |
| alert-rules | 0/2 · 4.3 | 0/2 · 5.0 | 0/2 · 5.4 | 0/2 · 4.8 |
| runbook | 1/2 · 4.5 | 2/2 · 5.2 | 0/2 · 5.4 | 2/2 · 5.1 |
| press-release | 0/2 · 6.3 | 0/2 · 6.5 | 0/2 · 4.7 | 0/2 · 4.3 |
| invoice-run | 2/2 · 4.9 | 2/2 · 4.4 | 2/2 · 7.7 | 2/2 · 7.2 |
| html-arcade-game | 2/2 · 3.7 | 2/2 · 5.1 | 2/2 · 3.8 | 2/2 · 2.9 |

**Qwen 3.8 27B**

| Book | Step by step | One owner, whole recipe | Goal, recipe as advice | Goal only |
|---|---|---|---|---|
| research-report | 3/3 · 8.8 | 3/3 · 8.8 | 3/3 · 9.1 | 3/3 · 9.2 |
| powerpoint-deck | 3/3 · 7.0 | 3/3 · 7.3 | 3/3 · 7.5 | 3/3 · 7.1 |
| corpus-synthesis | 3/3 · 7.7 | 3/3 · 7.5 | 2/3 · 8.0 | 1/3 · 7.4 |
| market-scan | 3/3 · 8.0 | 1/3 · 7.5 | 2/3 · 7.7 | 3/3 · 7.3 |
| content-accuracy-review | 3/3 · 8.4 | 3/3 · 8.9 | 3/3 · 9.1 | 3/3 · 8.5 |
| engineering-retrospective | 0/3 · 7.9 | 2/3 · 7.9 | 2/3 · 7.6 | 3/3 · 6.8 |
| bug-fix-tdd | 3/3 · 7.1 | 3/3 · 7.3 | 3/3 · 7.1 | 3/3 · 7.3 |
| refactor-module | 3/3 · 8.1 | 3/3 · 8.1 | 3/3 · 8.0 | 3/3 · 8.1 |
| codemod-sweep | 3/3 · 8.1 | 3/3 · 7.9 | 3/3 · 8.0 | 3/3 · 8.0 |
| ab-test-readout | 3/3 · 7.8 | 2/3 · 7.4 | 3/3 · 7.5 | 3/3 · 7.4 |
| cohort-analysis | 3/3 · 7.9 | 3/3 · 8.1 | 3/3 · 8.6 | 3/3 · 8.4 |
| data-quality-audit | 3/3 · 7.5 | 0/3 · 7.3 | 2/3 · 7.6 | 2/3 · 7.8 |
| csv-transformer | 3/3 · 10.0 | 3/3 · 10.0 | 3/3 · 10.0 | 3/3 · 10.0 |
| alert-rules | 3/3 · 7.2 | 3/3 · 7.9 | 3/3 · 7.5 | 2/3 · 7.6 |
| runbook | 3/3 · 7.7 | 2/3 · 7.6 | 2/3 · 8.1 | 3/3 · 7.7 |
| press-release | 3/3 · 8.8 | 2/3 · 7.6 | 2/3 · 7.1 | 3/3 · 7.1 |
| invoice-run | 3/3 · 7.0 | 3/3 · 6.8 | 3/3 · 7.7 | 3/3 · 8.2 |
| html-arcade-game | 2/3 · 7.6 | 2/3 · 6.9 | 2/3 · 8.3 | 3/3 · 8.3 |

### Outside tools on local models

Passed / trials · mean judged quality, from the rerun (amendment 3). "Passed" runs each code book's tests on the final folder.

**Qwen 3.5 9B**

| Book | Goal only | Request only | pi | pi + book | OpenCode | OpenCode + book |
|---|---|---|---|---|---|---|
| engineering-retrospective | 1/2 · 3.9 | 0/2 · 3.5 | 0/2 · 3.5 | 0/2 · 3.6 | 0/2 · 3.8 | 0/2 · 3.6 |
| refactor-module | 2/2 · 8.0 | 2/2 · 7.3 | 2/2 · 6.9 | 2/2 · 6.9 | 2/2 · 7.0 | 2/2 · 7.0 |
| cohort-analysis | 1/2 · 6.1 | 0/2 · 5.9 | 0/2 · 6.8 | 0/2 · 4.6 | 0/2 · 4.0 | 0/2 · 7.2 |
| runbook | 2/2 · 5.4 | 1/2 · 5.6 | 2/2 · 5.8 | 0/2 · 2.2 | 0/2 · 3.1 | 0/2 · 5.5 |
| invoice-run | 2/2 · 7.7 | 0/2 · 5.2 | 0/2 · 2.6 | 0/2 · 4.9 | 0/2 · 3.0 | 0/2 · 4.0 |
| bug-fix-tdd | 2/2 · 7.1 | 2/2 · 7.1 | 2/2 · 7.2 | 2/2 · 7.6 | 2/2 · 7.6 | 2/2 · 6.8 |
| codemod-sweep | 2/2 · 7.9 | 2/2 · 8.0 | 2/2 · 8.3 | 2/2 · 8.0 | 1/2 · 4.1 | 2/2 · 8.1 |

**Qwen 3.8 27B**

| Book | Goal only | Request only | pi | pi + book | OpenCode | OpenCode + book |
|---|---|---|---|---|---|---|
| engineering-retrospective | 2/2 · 7.4 | 0/2 · 6.2 | 0/2 · 7.2 | 0/2 · 6.6 | 0/2 · 6.5 | 0/2 · 6.3 |
| refactor-module | 2/2 · 8.1 | 2/2 · 8.3 | 2/2 · 7.0 | 2/2 · 8.0 | 2/2 · 7.0 | 2/2 · 8.1 |
| cohort-analysis | 2/2 · 8.9 | 2/2 · 7.9 | 2/2 · 8.4 | 1/2 · 7.6 | 2/2 · 8.1 | 2/2 · 8.0 |
| runbook | 2/2 · 7.6 | 2/2 · 7.8 | 2/2 · 6.9 | 2/2 · 7.4 | 2/2 · 7.4 | 1/2 · 7.0 |
| invoice-run | 2/2 · 8.3 | 0/2 · 7.3 | 0/2 · 4.5 | 0/2 · 7.1 | 0/2 · 4.8 | 0/2 · 7.0 |
| bug-fix-tdd | 1/2 · 5.4 | 2/2 · 7.4 | 2/2 · 7.0 | 2/2 · 7.3 | 2/2 · 7.3 | 2/2 · 7.5 |
| codemod-sweep | 2/2 · 8.0 | 2/2 · 8.0 | 2/2 · 8.1 | 2/2 · 8.3 | 2/2 · 8.0 | 2/2 · 8.3 |

### Sonnet follow-up, all 18 books

Passed / trials · mean judged quality. Three replicates.

| Book | One owner, whole recipe | Recipe as advice | Goal only |
|---|---|---|---|
| research-report | 3/3 · 9.4 | 3/3 · 9.2 | 3/3 · 9.5 |
| powerpoint-deck | 3/3 · 7.6 | 3/3 · 8.3 | 3/3 · 8.0 |
| corpus-synthesis | 2/3 · 8.3 | 3/3 · 8.7 | 2/3 · 8.8 |
| market-scan | 0/3 · 8.7 | 0/3 · 8.6 | 0/3 · 8.4 |
| content-accuracy-review | 3/3 · 9.2 | 3/3 · 9.4 | 3/3 · 9.3 |
| engineering-retrospective | 3/3 · 7.9 | 3/3 · 8.6 | 3/3 · 8.5 |
| bug-fix-tdd | 3/3 · 7.6 | 3/3 · 7.1 | 3/3 · 7.4 |
| refactor-module | 3/3 · 8.2 | 3/3 · 8.4 | 3/3 · 8.2 |
| codemod-sweep | 3/3 · 8.1 | 3/3 · 8.0 | 2/3 · 7.4 |
| ab-test-readout | 3/3 · 9.4 | 3/3 · 9.4 | 3/3 · 9.5 |
| cohort-analysis | 3/3 · 9.0 | 3/3 · 8.9 | 3/3 · 8.9 |
| data-quality-audit | 2/3 · 8.4 | 3/3 · 8.5 | 0/3 · 8.7 |
| csv-transformer | 3/3 · 10.0 | 3/3 · 10.0 | 3/3 · 10.0 |
| alert-rules | 3/3 · 8.3 | 3/3 · 8.0 | 3/3 · 8.6 |
| runbook | 2/3 · 8.8 | 3/3 · 8.6 | 1/3 · 8.7 |
| press-release | 3/3 · 9.0 | 3/3 · 9.1 | 3/3 · 9.2 |
| invoice-run | 3/3 · 7.6 | 3/3 · 8.8 | 3/3 · 8.8 |
| html-arcade-game | 3/3 · 8.8 | 3/3 · 8.3 | 3/3 · 8.5 |

### GPT-6.1 Sol through Codex CLI, all 18 books

Passed / trials · mean judged quality. Three replicates.

| Book | One owner, whole recipe | Recipe as advice | Goal only |
|---|---|---|---|
| research-report | 2/3 · 9.5 | 2/3 · 9.4 | 3/3 · 9.4 |
| powerpoint-deck | 3/3 · 7.5 | 3/3 · 7.1 | 3/3 · 7.4 |
| corpus-synthesis | 1/3 · 8.8 | 3/3 · 9.0 | 1/3 · 8.9 |
| market-scan | 0/3 · 8.4 | 0/3 · 9.0 | 0/3 · 8.9 |
| content-accuracy-review | 2/3 · 8.9 | 3/3 · 9.1 | 3/3 · 9.3 |
| engineering-retrospective | 1/3 · 7.2 | 2/3 · 8.6 | 3/3 · 8.6 |
| bug-fix-tdd | 3/3 · 7.3 | 3/3 · 7.0 | 3/3 · 7.4 |
| refactor-module | 3/3 · 8.3 | 3/3 · 8.1 | 3/3 · 8.2 |
| codemod-sweep | 0/3 · 5.4 | 1/3 · 6.2 | 3/3 · 7.9 |
| ab-test-readout | 3/3 · 8.4 | 3/3 · 8.6 | 3/3 · 8.5 |
| cohort-analysis | 3/3 · 8.8 | 3/3 · 9.1 | 3/3 · 9.3 |
| data-quality-audit | 2/3 · 8.6 | 1/3 · 8.8 | 1/3 · 8.9 |
| csv-transformer | 3/3 · 10.0 | 3/3 · 10.0 | 3/3 · 10.0 |
| alert-rules | 3/3 · 7.7 | 3/3 · 7.7 | 3/3 · 8.1 |
| runbook | 0/3 · 8.2 | 3/3 · 8.3 | 3/3 · 8.0 |
| press-release | 3/3 · 9.1 | 3/3 · 9.2 | 3/3 · 9.2 |
| invoice-run | 3/3 · 8.2 | 3/3 · 8.1 | 3/3 · 8.4 |
| html-arcade-game | 3/3 · 8.6 | 3/3 · 8.5 | 3/3 · 8.5 |

Every other table, including rounds 2 and 3, the screen and the superseded first outside-tool run, is in `evals/runs/report-2026-11/numbers.md`.

## Appendix C: the superseded first outside-tool run

The first run of the outside-tool arms gave pi and OpenCode the project
description in Gezel's wording and left out the mission objectives ("What we
found and fixed"). Its figures, beside the rerun that replaced them. The Gezel
arms were not rerun; they are the same trials in both.

| Model | Arm | First run: passed | First run: quality | Rerun: passed | Rerun: quality |
|---|---|---|---|---|---|
| Qwen 3.5 9B | pi | 7/14 | 5.29 | 8/14 | 5.88 |
| | pi + book description | 7/14 | 6.13 | 6/14 | 5.41 |
| | OpenCode | 6/14 | 5.62 | 5/14 | 4.64 |
| | OpenCode + book description | 8/14 | 5.46 | 6/14 | 6.02 |
| Qwen 3.8 27B | pi | 8/14 | 6.86 | 10/14 | 7.01 |
| | pi + book description | 8/14 | 6.95 | 9/14 | 7.46 |
| | OpenCode | 8/14 | 7.10 | 10/14 | 6.99 |
| | OpenCode + book description | 8/14 | 7.52 | 9/14 | 7.45 |
| Claude Sonnet 5.5 | pi | 8/14 | 6.76 | 8/14 | 6.90 |
| | pi + book description | 8/14 | 7.83 | 10/14 | 7.86 |
| | OpenCode | 10/14 | 7.53 | 9/14 | 7.49 |
| | OpenCode + book description | 8/14 | 7.98 | 8/14 | 8.07 |

The correction helped most on the 27B, where every outside arm passed one or
two more. On the 9B, three of the four arms passed fewer in the rerun, mostly
from the file-path and strict-check failures described in the main text. On
Sonnet the changes went both ways. Across all three models, the outside tools
passed 98 of 168 in the rerun against 94 in the first run.

