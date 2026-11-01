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

### Every result in one table {[dataTable src=../assets/scorecards/all-results.csv previewRows=5000 follow=scorecard group=run_id columns=model,suite,pass_rate_pct,judge_score,decode_tok_s,prefill_tok_s,device,started_at,run_id,successes,attributable_trials,rate_quotable,engine,perf_source,scope]}

Every round laid end to end, one row per round, task set, and model, grouped
by round, newest first. [Download every result as CSV](../assets/scorecards/all-results.csv);
the file adds per-rubric judge scores, memory, context, and build details.

::handboek-model-scorecard{suites=core,productivity,developer,complex-work}

::handboek-scorecard-notes

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

**Every result in one table** sets every round's rows side by side, under the
column names the download uses. `pass_rate_pct` counts only the attempts the
model was responsible for, and `rate_quotable` is `no` where a job ran fewer
than three times, so read that figure as a count. `judge_score` is the one
place task rubrics are averaged: a summary across a round's rubrics, weighted
by how many pieces each covered, and fair to compare only within one judge;
the download keeps each rubric's own score. Speeds are the median of each
attempt's engine log where a round recorded them and the older probe
otherwise, as `perf_source` says, and a round measured across separate
hardware periods has no single speed, so those cells stay empty. Focused
reruns show `subset` under `scope`.

## Choosing from this

A high score on the office set is the better guide for everyday document,
planning, and analysis work. A high score on the general set matters more if
you want a gezel writing or fixing code, and the engineering set, where a round
has it, is the stricter test of that.

If a model you're considering isn't listed, it hasn't been measured here yet
— which is not a verdict on it either way. The Models catalog in the app
will still tell you whether it fits this machine.
