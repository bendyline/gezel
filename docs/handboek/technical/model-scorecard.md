---
id: model-scorecard
title: "Model scorecard"
order: 13
summary: Measured results for every model we have tested, on each task set.
subcategory:
  id: models-and-testing
  title: Models and Testing
  order: 4
---
# Model scorecard

These are measured task outcomes. Each pass count records attempts that met
the automatic checks on a real machine. Artifact reviews can reveal missing
requirements or defects that those checks missed.

[How we test models](how-we-test-models.md) explains what was counted and
what these numbers do not tell you. Each round states its repeat count; jobs
run fewer than three times show counts rather than percentages. A job passes
when its automatic checks pass, and runs lost to
machine trouble are set aside rather than blamed on the model.

## Results by test round

Focused reruns are labeled as subsets and retain their own round. They can
verify a fix, but do not replace a full-suite comparison. Round notes explain
unfinished coverage and documented evaluator failures; those failures remain
recorded without being counted as model weaknesses.

Each round has one table for each task set it ran, all measured on the same
machine and build. Most rounds ran two sets. **General capability** covers
writing a small working program, fixing a bug from its symptoms, following a
procedure and stopping at a problem, and turning several documents into one
reconciled summary. **Office and knowledge work** covers a customer notice
under a hard word limit, a meeting turned into an action register, a
cited research brief, an experiment read-out, a spreadsheet model, a slide
deck, and a Word document. Some rounds add the two harder sets: **Engineering
work**, which is developer work such as reviewing a change and proving a fix
with tests, and **Complex workflows**, which asks a model to write and repair
reusable recipes of its own.

::handboek-model-scorecard{suites=core,productivity,developer,complex-work}

## October 28–30 R9700 comparison and review data

The Qwen 3.8 27B Q4 and Gemma 4 12B Q4 comparison completed all **258 trials**
across four task sets, with three repetitions per model and scenario.
Qwen passed 104/125 eligible attempts; Gemma passed 81/127. Six raw exclusions
remain recorded: three Windows sandbox failures and three model-authored
gate configurations that the harness classified as infrastructure failures.
Qwen's complex-work suite has no eligible custom-gate attempt, so that suite's
headline is withheld while all its observations remain available.

Download the [scorecard data](../assets/scorecards/2026-10-28-r9700-native-0-1-54/scorecard.json)
and [full run data with judging and performance](../assets/scorecards/2026-10-28-r9700-native-0-1-54/scorecard-details.json).
The companion includes per-trial fixed scores, both advisory judge ledgers,
scenario and repetition results, latency, throughput, RAM/GPU measurements,
postmortems and review audits. Known setup and evaluator problems remain
visible beside the frozen results. Different review rubrics stay separate;
misaligned A/B and incidental fixture-page opinions are excluded from the
website's quality means and retained in the download.

A **separate six-trial activation subset** exposed the missing DocBlocks tools
and produced two Qwen passes and no Gemma passes. It does not replace the
original six setup failures. Binary repair messages were rejected before
delivery; the postmortem distinguishes that framework limitation from initial
schema and grounding errors. All trials and judging are complete.

Both models ran on Windows with a Radeon AI PRO R9700 and native 0.1.54.
The task tables show engine-log measurements across all attempts; system RSS
and GPU memory remain separate, and one GPU observation is missing.
[Download notes and validation](../assets/scorecards/2026-10-28-r9700-native-0-1-54/README.md)
explain all denominators, review selections, timing limitations and the
frozen capability implementation's differences from its prose rubric.

## October 28 Windows Gemma 4 12B results

Gemma 4 12B completed all four task sets on an RTX 5070 Ti laptop using
native 0.1.54: 129 attempts, three per scenario in each suite, with 89 raw
passes. Twelve attempts lacked required tools and one had an unevaluable
model-authored gate. The reviewed subset contains 89 passes in 116 attempts;
the download retains every raw verdict and exclusion reason.

All 59 applicable artifacts were judged, including outputs from failed
attempts. The **Artifact reviews** tables keep each rubric separate, exclude
three A/B reviews with mismatched axes, and distinguish 70 tasks with no
applicable rubric from missing artifacts. These were unblinded source and
artifact reviews by `codex-inline/current-session`. Nine deferred browser
checks subsequently passed on unchanged saved artifacts; these short checks
do not establish complete gameplay or visual quality.

The **Task performance** tables cover all 129 attempts, with per-trial
medians, ranges and sample counts for native output and prefill speed, wall
time, peak system RSS and peak GPU memory. The overall median native output
rate was 121.16 tokens/s. Admission-probe rates remain separate. Exact token
counts, GPU utilization, memory samples and fixed-score breakdowns are in the
download.

Download the [scorecard data](../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/scorecard.json),
[full judging and performance report](../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/scorecard-details.json),
and [measurement notes](../assets/scorecards/2026-10-27-windows-gemma4-12b-native-0-1-54/README.md).
The run identifier retains the October 27 scheduling date; execution occurred
on October 28.

## October 25 M5 Max Bolt comparison and review data

The five-model core campaign completed all 165 trials: 11 scenarios, three
repeats, five models. Bolt and Gemma E4B each passed 26/33, Gemma E2B 14/33,
Gemma 12B 23/33 and Qwen 9B 21/33. Every trial was reviewed, including failed
outputs: 158 artifacts have advisory scores and seven missing outputs have
no invented score. HTML, code, data and document quality remain separate.

Download the [scorecard data](../assets/scorecards/2026-10-25-m5max-bolt-five/scorecard.json)
and [full report JSON with judging and performance](../assets/scorecards/2026-10-25-m5max-bolt-five/scorecard-details.json).
The full report preserves exact review axes and rationales, per-trial timings,
token coverage, fixed-score breakdowns, model identities and 32 documented
framework/evaluator findings. Some gate passes contained incomplete or broken
artifacts; some gates also rejected valid outputs. Raw verdicts remain
unchanged, and these findings do not establish when a defect was introduced.

Bolt ran on llama.cpp Metal using NVIDIA's October 23 revision; the other
models used MLX. The **Task performance** rows show task medians, ranges and
sample counts, including failed attempts and recovery. Bolt throughput is
request-derived; MLX decode is an active-stream estimate and MLX prefill is
unavailable. Token streams have incomplete coverage, first-write latency is
not completed-output latency, and process RSS is not GPU telemetry.
[Download notes and validation](../assets/scorecards/2026-10-25-m5max-bolt-five/README.md)
explain the frozen comparison, measurement limits and excluded older trials.

## October 2026 Windows results and review data

The eight-model core evaluation completed all 264 requested attempts on an
RTX 5070 Ti laptop: 182 passed, 70 failed their tasks, and 12 were excluded
after exceeding Nanbeige's 32K context. These were context failures, not GPU
out-of-memory failures. Every attempt has been reviewed.

The tables preserve three runtime rounds: 49 original trials, 182 trials
after a runtime correction, and the separate 33-trial Nanbeige 32K rerun.
The original and continuation rounds show counts because neither alone has
three repeats of every task. Nanbeige's full-suite score is withheld because
some tasks have no attributable results. Its 12 passes, nine model failures
and 12 infrastructure exclusions remain available in the data.

Download the [scorecard data](../assets/scorecards/2026-10-19-windows-small-model-core/scorecard.json)
and [full judging and performance data](../assets/scorecards/2026-10-19-windows-small-model-core/scorecard-details.json).
The companion preserves all 254 artifact reviews: 247 eligible reviews,
six infrastructure diagnostics and one excluded review that exceeded its
input limit. Ten attempts produced no artifact to score. The four task
rubrics stay separate: the **Artifact reviews** tables show HTML, code, data
and document quality means with eligible artifact counts, plus counts for
missing artifacts and excluded reviews. These were unblinded reviews by
`codex-inline/current-session`; no combined quality score is calculated.

The **Task performance** tables show output and prefill speed, wall time,
peak system RSS and peak GPU memory as per-trial medians with ranges and
sample counts. They include available observations from all attempts,
including failures. These engine-log measurements are separate from
admission probes. GPU performance changed during the run, so each journal
keeps its own measurement period, including Nanbeige's slower and later
faster periods. [Download notes](../assets/scorecards/2026-10-19-windows-small-model-core/README.md)
explain provenance, exclusions, memory headroom and validation.

## October 2026 Mac results and review data

The Apple M5 Max campaign closed at 601 recorded attempts: 476 passed,
119 failed their tasks, and six were excluded for infrastructure problems.
LFM 2.5, Qwen 3.6, Qwen 3.8 and BTL4 each completed 129 attempts. Ornith
completed 85 of 129 planned attempts; Nemotron and MiniCPM were not run.

The tables retain 600 attempts in two separate rounds: four complete model
arms and the partial Ornith round. One additional failed Ornith attempt had
comparison-identity drift and remains in the evidence download with its
original classification, outside the comparison tables.

The [scorecard data](../assets/scorecards/2026-10-16-m5max-local-seven/scorecard.json)
and [full judging and performance data](../assets/scorecards/2026-10-16-m5max-local-seven/scorecard-details.json)
are available as JSON. The companion includes all 601 observations, 248
artifact reviews, each task's rubric and sample counts, and per-trial speed
and memory measurements. Four declared artifacts were missing, 14 reviews
had a mismatched rubric, and 335 tasks had no applicable declared rubric.
No review is pending. Different task rubrics are kept separate, so this
round has no combined quality score in the tables.

All nine admission probes generated fewer than 256 output tokens; Ornith's
single probe generated 84. Treat the table's speeds as preliminary. The
companion also records engine-derived speeds during the actual tasks and
their sample counts. [Download notes and validation details](../assets/scorecards/2026-10-16-m5max-local-seven/README.md)
explain the populations and caveats.

## Reading the table

**Tasks passed** counts every attempt across every job in the set. A model
with `24/33 (73%)` finished 24 of 33 attempts correctly. If any job in the
set ran fewer than three times you'll see a raw count instead of a
percentage — too small a sample to quote as a rate. A model whose results
were incomplete is left out of the table entirely rather than shown with a
gap.

**Quality** is an AI reviewer's opinion of the finished work, and the count
beside it is how many pieces that opinion covers. It only grades work that
was actually produced, including declared artifacts from failed attempts
where the round used inline judging. Missing artifacts receive no invented
quality score — `6.5/10 (18 pieces)` is a weaker claim than `6.5/10 (26
pieces)`. Treat it as color next to the pass rate, never as a substitute
for it. Task-specific rubrics stay separate rather than being averaged into
one score.

**Performance** shows two measured speeds on the machine named above: output
speed is how fast the model writes its answer, and prefill speed is how fast it
takes in your prompt and documents. Both matter for how a gezel *feels* —
prefill governs the pause before it starts, while output governs how fast text
appears. A dash means that round did not record a throughput probe.

**Context** is the working memory the model was given for these runs — how
much it can hold at once. **Memory used** is the most memory the model and its
engine held on the test machine. What that number covers depends on the
machine, so each round says which one it measured:

- **On a Mac** the graphics chip shares the computer's memory and our
  measurement sees all of it, so **Memory used** is the model's whole
  footprint.
- **On a PC with a separate graphics card** the column is called **System
  memory**. It counts the computer's own memory only, not what the model keeps
  on the graphics card.
- **On machines like the DGX Spark**, where the graphics chip shares memory in
  a way our measurement can't see, the column is left out. The number would
  read far below what the model really uses.

Treat these as a rough guide from one machine, not a promise about yours. The
Models catalog in the app is the better check for whether a model fits your
computer. When the engine reported its KV-cache precision, it appears beside
the model name — for example, `(kv: q8_0)`.

Each **test round** keeps all of its tables together under one provenance
stamp. Earlier rounds stay separate from
the latest because a change to gezel or to the task set can move a score
without any model changing.

**Size** is the model's parameter count where we know it. Bigger is often but
not always better: on office work in particular, some smaller models beat
larger ones, and a model family's habits matter more than its size.

## Choosing from this

A high score on the office set is the better guide for everyday document,
planning, and analysis work. A high score on the general set matters more if
you want a gezel writing or fixing code, and the engineering set, where a round
has it, is the stricter test of that.

If a model you're considering isn't listed, it hasn't been measured here yet
— which is not a verdict on it either way. The Models catalog in the app
will still tell you whether it fits this machine.
