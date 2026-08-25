---
id: how-we-test-models
title: "How we test models"
order: 12
summary: What the model scores mean, how they are measured, and what they don't tell you.
subcategory:
  id: models-and-testing
  title: Models and Testing
  order: 4
---
# How we test models

Gezel can run many different AI models, and they are not equally good at the
work. A model that writes a lovely paragraph may be hopeless at filling in a
spreadsheet correctly; a small one that fits comfortably on a laptop may
quietly get dates wrong.

So we measure. This article explains how, because a score is only worth
something if you know what was counted.

## Tasks, not questions

We don't quiz models with trivia. We give them **real jobs** and check the
work they hand back.

A job looks like this: here is a meeting transcript, an out-of-date agenda,
and a list of who works here. Produce a written brief and a table of action
items with the right owner, the right date, and the right dependencies. Then
we open the files and check them. Did the September 14th decision survive?
Did the cancelled proposal stay cancelled? Is the action assigned to someone
who actually works here?

Every task is checked the same way for every model, by a program rather than
a person, so nobody's favourite gets the benefit of the doubt.

## Two sets of jobs

**The core set** is general capability — writing a small working program,
fixing a bug from a description of the symptoms, following a checklist and
stopping when something looks wrong, turning several documents into one
reconciled summary.

### Core (11 tests)

| Test | What the task entails |
|---|---|
| Tic-tac-toe (`tictactoe`) | Create a new project and build a working two-player tic-tac-toe game in a single HTML file, including a clear win state. |
| Pet shop (`petshop`) | Build a single-page pet-shop website, generate a custom logo with the image tool, and make sure the page uses that logo. |
| Tank combat (`tankcombat`) | Build a playable top-down tank game in one HTML file, with keyboard controls, shooting, an enemy tank, and a visible score. |
| Schema migration (`schema-migration`) | Refactor a small multi-file TypeScript app from one name field to first and last names, preserve every record, add tests and notes, and pass the type check. |
| Tests as the specification (`failing-tests-spec`) | Work out an order-lifecycle state machine from its tests alone, implement it, and make every test pass without changing the tests. |
| Debug from symptoms (`symptom-debug`) | Diagnose an undocumented pagination error from the failing output, then fix the implementation without changing the acceptance check. |
| Data wrangling (`data-wrangle`) | Clean three messy CSV exports, standardise dates and email addresses, remove duplicates, sort the records, and produce the exact required JSON. |
| Incident postmortem (`incident-postmortem`) | Read five evidence files and write a structured, blame-free postmortem with accurate facts and citations, without inventing unmeasured impact. |
| Runbook anomaly (`ops-runbook-anomaly`) | Follow a maintenance checklist step by step, verify and record each action, and stop with a grounded report when a planted backup check fails. |
| Plan and estimate (`plan-and-estimate`) | Produce an office-relocation plan with valid owners, correctly ordered dependencies, risks, and a checkable definition of done for every task. |
| Conflict synthesis (`conflict-synthesis`) | Reconcile five documents that disagree about a launch date, budget, and owner; show each conflict and use the authoritative answer consistently. |

**The productivity set** is office work — a customer notice written to a hard
word limit, a meeting turned into an action register, a research brief with
its sources cited, an A/B test read-out, a spreadsheet model, a slide deck,
a Word document.

### Productivity (13 tests)

| Test | What the task entails |
|---|---|
| Constrained communications (`constrained-comms`) | Write a 140–220 word customer outage notice containing the required facts and disclosures while avoiding banned or unsupported claims. |
| Plan the week (`craftbook-week-plan`) | Turn eight calendar events into a five-day plan, flag meetings that need preparation, resolve a Tuesday conflict, and protect focus time. |
| A/B test read-out (`craftbook-ab-test-readout`) | Calculate the experiment results correctly and apply a pre-set decision rule, including a safety measure that overrides an otherwise positive result. |
| Annotated bibliography (`craftbook-annotated-bibliography`) | Produce six consistently formatted source entries, each with a summary, an evaluation of the source, and its relevance to the question. |
| Records intake (`records-intake`) | Combine registrations from emails, phone notes, and an old CSV into one correctly shaped, deduplicated record set with standardised dates. |
| Plan and estimate (`plan-and-estimate`) | Produce an office-relocation plan with valid owners, correctly ordered dependencies, risks, and a checkable definition of done for every task. |
| Meeting follow-up (`meeting-followup`) | Reconcile a noisy transcript, stale agenda, and current staff list into a decision brief and an exact action register with owners, dates, dependencies, questions, and risks. |
| Spreadsheet model (`craftbook-spreadsheet-model`) | Calculate the correct roll-ups from seeded records and turn them into a useful spreadsheet-style model and read-out that highlights the main risk. |
| Conflict synthesis (`conflict-synthesis`) | Reconcile five documents that disagree about a launch date, budget, and owner; show each conflict and use the authoritative answer consistently. |
| Theme round-trip (`docblocks-theme-roundtrip`) | Read the theme from a brand document, apply it to a presentation, inspect the result, and report only fonts, colours, page counts, and unresolved styles returned by the document tools. |
| Research to Word (`craftbook-research-to-document`) | Turn reviewed, source-grounded Markdown into a real editable Word document, preview it, and save the finished `.docx` as an artifact. |
| PowerPoint deck (`craftbook-powerpoint-deck`) | Acquire and cite source material, create an outline, make every slide match it, and save a real editable `.pptx` presentation. |
| Wikipedia research brief (`wikipedia-research-brief`) | Use a closed local copy of Wikipedia to select the relevant sources and write a cited 700–1,500 word brief with correct chronology and careful treatment of a disputed claim. |

A model gets a score on each set. They measure different things, and it is
normal for a model to be strong on one and weak on the other. Plan and
estimate and conflict synthesis deliberately appear in both sets because
they test capabilities that matter to each.

## What "passed" means

A task passes when the finished work meets every requirement that was stated
in the instructions. Not most of them. There is no partial credit for a
beautiful document with the wrong numbers in it — that is precisely the
failure that costs you an afternoon.

Some tasks are checked by arithmetic. For the A/B test read-out we know what
the right answer is, because we made the data up: the conversion lift is
1.25 percentage points and the refund rate rose by 0.23. A model that reports
different figures fails, however confident the prose sounds.

Some are checked by opening the file. When a task asks for a PowerPoint, we
check the result is really a PowerPoint file and not a text document with the
wrong name on it.

## Why we run everything three times

Models are not perfectly consistent. The same model given the same job twice
can succeed once and fail once.

So each job is run three times, and we report how many succeeded. If a model
has only been run once or twice we print the raw count — "1 of 1" — rather
than a percentage, because "100%" from a single attempt is not a fact, it is
a coin toss that happened to land well.

## When the machine breaks, the model isn't blamed

Sometimes a run fails for reasons that have nothing to do with the model: the
graphics driver falls over, the machine runs out of memory, someone stops the
run. Those attempts are recorded and set aside rather than counted as
failures.

If enough of a model's attempts are lost that its results no longer stand up,
we leave it out of the table rather than publish a score with a hole in it.
A missing model means "not measured properly yet", never "measured and found
wanting".

## What we deliberately don't claim

**Scores from different rounds are not comparable.** Every number comes from
one machine, on one day, with one version of gezel and one version of the
task set. Change any of those and you have a different experiment. When a
model was measured in an earlier round we list it separately and say why —
we never quietly merge it into a newer table to make the list look fuller.

**Quality scores are an opinion, not a measurement.** Alongside the pass/fail
checks we ask a large AI model to rate qualities like clarity, grounding and
candour, and we publish that as a Quality column. Read it with two caveats.

First, it only covers work that got *produced*. A model that gives up early
is graded on the few pieces it did finish, so a high quality score over a
small number of pieces can mean "good when it manages it" rather than
"good". That is why the count always travels with the score — `6.5/10 (18
pieces)` next to `6.5/10 (26 pieces)` are not the same claim.

Second, the rating model changes over time, so quality scores are comparable
*within* a round and not across rounds. The pass/fail results are the ones
that track.

**A score is not a recommendation for your machine.** Results come from one
particular computer. A model that scores well on a large desktop may not fit
on a laptop at all. The Models catalogue in the app is what knows your
hardware.

**A score is not a ceiling.** These are tasks we chose. A model that does
poorly here may be excellent at something we didn't think to measure.

## Adding a model

New models get added to the same rounds and run through the same jobs, with
the same number of attempts, on the same machine. Nothing is graded on a
curve, and nothing is added to a table it didn't actually run in.

The current results are in [Model scorecard](model-scorecard.md).
