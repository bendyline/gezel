---
id: docbench
title: "Docbench: models for document work"
order: 13.2
summary: How well each local model reviews, writes, draws, and summarizes documents in DocBlocks, as one score from 0 to 100.
subcategory:
  id: models-and-testing
  title: Models and Testing
  order: 4
---
# Docbench: models for document work

The [model scorecard](model-scorecard.md) asks whether a model can finish a job on its own. Docbench asks a different question: when DocBlocks hands a model a single piece of document work, how good is what comes back? It runs the same prompts, parsers, and repairs DocBlocks itself uses, so the score describes what you would see in the editor, not a lab version of it.

## What it measures

Every model gets the same documents and the same requests, in six groups:

- **Review** — the eight review styles, from a general read to resume feedback, fact checking, and plain-language edits. Each test document has known problems written into it, and a reviewer checks which ones the model found, which suggestions were real but small, and which were wrong. Clean documents check that a model does not invent problems.
- **Writing** — new content from a brief, plus text added to the end of a document or inserted in the middle of one, and rewrites (shorter, more formal, fixed grammar, bullets to prose).
- **Pictures** — choosing what to illustrate, building diagrams of thirteen kinds, drawing simple illustrations, and writing briefs for an image model. Drawings are judged as rendered pictures.
- **Slides** — turning a document into a slide deck.
- **Study** — summaries, notes, quizzes, and flashcards that stay true to the source.
- **Narration** — cleaning up a dictated transcript without changing what was said.

Each answer gets two kinds of marks. Automatic checks catch answers DocBlocks could not use at all: cut off, unparseable, or ignoring the request. An AI reviewer then grades the rest against a written rubric. An answer DocBlocks could not use scores zero.

## Reading the score

**Docbench** is a weighted average of the six groups, from 0 to 100. Review and writing count for a quarter each, pictures a fifth, study aids 15%, slides 10%, and narration 5%.

**95% range** is how far the score could plausibly move if we had picked different test documents. Two models whose ranges overlap are not reliably different, so they share a **band**, and the band is the fairest way to read the order.

**Usable** is the share of answers DocBlocks could show you at all, before any grading.

**Suggestions per document** breaks general review down by how much each suggestion would change the draft: small fixes, moderate changes, and substantial ones, beside the trivial and wrong suggestions a model added. A model that finds few substantial problems but many trivial ones will feel busy without being helpful.

Scores compare fairly only within one round: the same test set, the same reviewer, and the same version of the prompts. Each round says which it used.

Sometimes a fix to Gezel changes what a model can do, such as a model that could not produce structured answers until Gezel worked around it. Then that model is measured again in a **focused re-run** under the same tests, reviewer and date, and listed beneath the full round. Its row in the full table says it was re-measured, and its band is its place in the full field.

## Results

::handboek-docbench-scorecard

## How the reviewer is checked

An AI reviewer is only worth trusting if it is consistent and hard to fool, so before a round is published the reviewer passes three tests: it must give nearly the same marks when asked twice, agree with a second reviewer from a different model family, and mark down deliberately damaged answers (cut short, padded, with invented numbers, or ignoring the request) at least nine times in ten.

Some test documents are kept private and used only in published rounds. If a model does much better on the public documents than the private ones, that is a sign the prompts have been tuned to the test rather than to real work.

## Choosing from this

In DocBlocks, the model list ranks models that fit your computer by their docbench score, so the first suggestion is the best measured model your hardware can run. If a model has no score, it has not been measured yet. That is not a verdict either way.
