---
id: model-scorecard
title: "Model scorecard"
order: 11
summary: Measured results for every model we have tested, on both task sets.
---
# Model scorecard

These are measured results, not estimates. Each number is the count of jobs a
model actually finished correctly, checked by a program on a real machine.

[How we test models](how-we-test-models.md) explains what was counted and
what these numbers do not tell you. The short version: each job is run three
times, a job passes only when every requirement is met, and runs lost to
machine trouble are set aside rather than blamed on the model.

## General capability

Writing a small working program, fixing a bug from its symptoms, following a
procedure and stopping at a problem, turning several documents into one
reconciled summary.

::handboek-model-scorecard{suite=core}

## Office and knowledge work

A customer notice under a hard word limit, a meeting turned into an action
register, a cited research brief, an experiment read-out, a spreadsheet
model, a slide deck, a Word document.

::handboek-model-scorecard{suite=productivity}

## Reading the table

**Tasks passed** counts every attempt across every job in the set. A model
with `24/33 (73%)` finished 24 of 33 attempts correctly. If any job in the
set ran fewer than three times you'll see a raw count instead of a
percentage — too small a sample to quote as a rate. A model whose results
were incomplete is left out of the table entirely rather than shown with a
gap.

**Quality** is an AI reviewer's opinion of the finished work, and the count
beside it is how many pieces that opinion covers. It only grades work that
was actually produced, so a model that fails often is judged on its
successes alone — `6.5/10 (18 pieces)` is a weaker claim than `6.5/10 (26
pieces)`. Treat it as colour next to the pass rate, never as a substitute
for it.

**Reads at / Writes at** are measured speeds on the machine named above:
how fast the model takes in your documents, and how fast it writes its
answer. Both matter for how a gezel *feels* — reading speed governs the
pause before it starts, writing speed governs how fast text appears.

**Context** is the working memory the model was given for these runs — how
much it can hold at once. **Memory used** is the peak RAM the model and its
engine actually occupied, which is the number to check against your own
machine.

**Earlier rounds** appear as separate tables below each set, with their own
stamps. They are kept apart rather than merged because a change to gezel or
to the task set can move a score without any model changing.

**Size** is the model's parameter count where we know it. Bigger is often but
not always better: on office work in particular, some smaller models beat
larger ones, and a model family's habits matter more than its size.

## Choosing from this

A high score on the office set is the better guide for everyday document,
planning, and analysis work. A high score on the general set matters more if
you want a gezel writing or fixing code.

If a model you're considering isn't listed, it hasn't been measured here yet
— which is not a verdict on it either way. The Models catalogue in the app
will still tell you whether it fits this machine.
