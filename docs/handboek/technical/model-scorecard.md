---
id: model-scorecard
title: "Model scorecard"
order: 8
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
with `24/33 (73%)` finished 24 of 33 attempts correctly. Below three attempts
you'll see a raw count instead of a percentage — too small a sample to quote
as a rate.

**Not measured** counts attempts lost to the machine rather than the model —
a crashed graphics driver, an out-of-memory kill. Those are removed from both
sides of the score. A large number here means the model was tested less
thoroughly than the others, and the score deserves less weight.

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
