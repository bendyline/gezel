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
a person, so nobody's favorite gets the benefit of the doubt.

## Four sets of jobs

Every test below links to what defines it. Most link to the scenario's source
in the repository: the files it starts from, the instructions, and the checks
that decide a pass. A test named `craftbook-` followed by a craftbook's name
runs that library craftbook as it ships, so it links to the craftbook's own
page; its inputs and checks travel with the craftbook in the catalog as a
`test.json` file, and the harness that runs them is in
[`evals/src/craftbooks`](https://github.com/bendyline/gezel/tree/main/evals/src/craftbooks).

**The core set** is general capability — writing a small working program,
fixing a bug from a description of the symptoms, following a checklist and
stopping when something looks wrong, turning several documents into one
reconciled summary.

### Core (11 tests)

| Test | What the task entails |
|---|---|
| Tic-tac-toe ([`tictactoe`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/tictactoe.ts)) | Create a new project and build a working two-player tic-tac-toe game in a single HTML file, including a clear win state. |
| Pet shop ([`petshop`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/petshop.ts)) | Build a single-page pet-shop website, generate a custom logo with the image tool, and make sure the page uses that logo. |
| Tank combat ([`tankcombat`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/tankcombat.ts)) | Build a playable top-down tank game in one HTML file, with keyboard controls, shooting, an enemy tank, and a visible score. |
| Schema migration ([`schema-migration`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/schema-migration.ts)) | Refactor a small multi-file TypeScript app from one name field to first and last names, preserve every record, add tests and notes, and pass the type check. |
| Tests as the specification ([`failing-tests-spec`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/failing-tests-spec.ts)) | Work out an order-lifecycle state machine from its tests alone, implement it, and make every test pass without changing the tests. |
| Debug from symptoms ([`symptom-debug`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/symptom-debug.ts)) | Diagnose an undocumented pagination error from the failing output, then fix the implementation without changing the acceptance check. |
| Data wrangling ([`data-wrangle`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/data-wrangle.ts)) | Clean three messy CSV exports, standardize dates and email addresses, remove duplicates, sort the records, and produce the exact required JSON. |
| Incident postmortem ([`incident-postmortem`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/incident-postmortem.ts)) | Read five evidence files and write a structured, blame-free postmortem with accurate facts and citations, without inventing unmeasured impact. |
| Runbook anomaly ([`ops-runbook-anomaly`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/ops-runbook.ts)) | Follow a maintenance checklist step by step, verify and record each action, and stop with a grounded report when a planted backup check fails. |
| Plan and estimate ([`plan-and-estimate`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/plan-and-estimate.ts)) | Produce an office-relocation plan with valid owners, correctly ordered dependencies, risks, and a checkable definition of done for every task. |
| Conflict synthesis ([`conflict-synthesis`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/conflict-synthesis.ts)) | Reconcile five documents that disagree about a launch date, budget, and owner; show each conflict and use the authoritative answer consistently. |

**The productivity set** is office work — a customer notice written to a hard
word limit, a meeting turned into an action register, a research brief with
its sources cited, an A/B test read-out, a spreadsheet model, a slide deck,
a Word document.

### Productivity (13 tests)

| Test | What the task entails |
|---|---|
| Constrained communications ([`constrained-comms`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/constrained-comms.ts)) | Write a 140–220 word customer outage notice containing the required facts and disclosures while avoiding banned or unsupported claims. |
| Plan the week ([`craftbook-week-plan`](https://gezel.com/docs/craftbook/week-plan/)) | Turn eight calendar events into a five-day plan, flag meetings that need preparation, resolve a Tuesday conflict, and protect focus time. |
| A/B test read-out ([`craftbook-ab-test-readout`](https://gezel.com/docs/craftbook/ab-test-readout/)) | Calculate the experiment results correctly and apply a pre-set decision rule, including a safety measure that overrides an otherwise positive result. |
| Annotated bibliography ([`craftbook-annotated-bibliography`](https://gezel.com/docs/craftbook/annotated-bibliography/)) | Produce six consistently formatted source entries, each with a summary, an evaluation of the source, and its relevance to the question. |
| Records intake ([`records-intake`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/records-intake.ts)) | Combine registrations from emails, phone notes, and an old CSV into one correctly shaped, deduplicated record set with standardized dates. |
| Plan and estimate ([`plan-and-estimate`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/plan-and-estimate.ts)) | Produce an office-relocation plan with valid owners, correctly ordered dependencies, risks, and a checkable definition of done for every task. |
| Meeting follow-up ([`meeting-followup`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/meeting-followup.ts)) | Reconcile a noisy transcript, stale agenda, and current staff list into a decision brief and an exact action register with owners, dates, dependencies, questions, and risks. |
| Spreadsheet model ([`craftbook-spreadsheet-model`](https://gezel.com/docs/craftbook/spreadsheet-model/)) | Calculate the correct roll-ups from seeded records and turn them into a useful spreadsheet-style model and read-out that highlights the main risk. |
| Conflict synthesis ([`conflict-synthesis`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/conflict-synthesis.ts)) | Reconcile five documents that disagree about a launch date, budget, and owner; show each conflict and use the authoritative answer consistently. |
| Theme round-trip ([`docblocks-theme-roundtrip`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/docblocks-theme-roundtrip.ts)) | Read the theme from a brand document, apply it to a presentation, inspect the result, and report only fonts, colors, page counts, and unresolved styles returned by the document tools. |
| Research to Word ([`craftbook-research-to-document`](https://gezel.com/docs/craftbook/research-to-document/)) | Turn reviewed, source-grounded Markdown into a real editable Word document, preview it, and save the finished `.docx` as an artifact. |
| PowerPoint deck ([`craftbook-powerpoint-deck`](https://gezel.com/docs/craftbook/powerpoint-deck/)) | Acquire and cite source material, create an outline, make every slide match it, and save a real editable `.pptx` presentation. |
| Wikipedia research brief ([`wikipedia-research-brief`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/wikipedia-research-brief.ts)) | Use a closed local copy of Wikipedia to select the relevant sources and write a cited 700–1,500 word brief with correct chronology and careful treatment of a disputed claim. |

**The engineering set** (10 tests) is developer work, and it is deliberately
harder than the first two. A model has to pick the right recipe out of a
library of several hundred when two of them look almost identical, find real
defects in a change set without flagging code that is perfectly correct, and
prove a fix by running the tests rather than by claiming it works.

### Engineering (10 tests)

| Test | What the task entails |
|---|---|
| Fix three documented bugs ([`fix-squisq-bugs`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/fix-squisq-bugs.ts)) | Find and fix three behavioral bugs in a seeded TypeScript codebase from its bug report — wrong distance math across the antimeridian, validation that only checks the top level, and functions that throw instead of returning safely — proven by running the code, with the type check as a guard. |
| Pick the right recipe ([`dev-craftbook-routing`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/route-dev.ts)) | Given a plain developer brief, choose the one library recipe that fits out of three plausible ones that overlap (two share the trigger phrase "fix this bug"); a wrong-but-plausible pick fails. |
| Agree on a shared interface ([`interface-contract`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/interface-contract.ts)) | Two developers build the producer and consumer halves of a small event pipeline around a shared type module; the halves must type-check together and round-trip events through an integration script they never saw. |
| Code review ([`craftbook-code-review`](https://gezel.com/docs/craftbook/code-review/)) | Review one staged change set from its snapshot and diff, write a gated report, and deliver a verdict — graded on finding the real defect without flagging code that is correct. |
| API contract review ([`craftbook-api-contract-review`](https://gezel.com/docs/craftbook/api-contract-review/)) | Reconcile an OpenAPI contract against the implemented routes, lock a design checklist, and produce a findings report. |
| Deep security review ([`craftbook-deep-security-review`](https://gezel.com/docs/craftbook/deep-security-review/)) | Audit a whole seeded codebase for systemic weaknesses, cluster the findings into themes, and write a report plus a structured findings file — graded on precision as well as recall against planted source-to-sink vulnerabilities. |
| Large pull-request review ([`large-pr-review`](https://github.com/bendyline/gezel/blob/main/evals/src/scenarios/large-pr-review.ts)) | Review a 120-file change set that contains one planted defect and one planted false-positive trap, and report coverage of every file. |
| Codemod sweep ([`craftbook-codemod-sweep`](https://gezel.com/docs/craftbook/codemod-sweep/)) | Rename a function across nine files — the export, the re-export, every import, call site and log string — while leaving the CHANGELOG untouched, with every claim reconciled by a real search. |
| Behavior-preserving refactor ([`craftbook-refactor-module`](https://gezel.com/docs/craftbook/refactor-module/)) | Extract duplicated, drifted logic into one shared module without changing behavior, proven by a behavior-equivalence matrix and a duplication check. |
| Reproduce, then fix ([`craftbook-bug-fix-tdd`](https://gezel.com/docs/craftbook/bug-fix-tdd/)) | Write a failing test that reproduces a reported pricing bug, make the smallest fix, and prove red-then-green by running the suite, with a mutant check that the new test really catches the bug. |

**The complex-workflow set** (9 tests) asks a model to build the recipe, not
just follow one: write a reusable procedure with its own quality gates, run it
twice against different inputs, repair one that is broken, and turn a job it
just did by hand into something the crew can run again next quarter.

### Complex workflows (9 tests)

| Test | What the task entails |
|---|---|
| Find, don't write ([`craftbook-find-vs-create`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/find-vs-create.ts)) | Given a brief that paraphrases a bundled recipe's domain, find and start the library recipe instead of authoring a new one. |
| Repair a stuck recipe ([`craftbook-edit-midtask`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/edit-midtask.ts)) | Diagnose a live task stuck on a quality gate it can never pass, rewrite the failing step of its recipe, add a verification step, and run it to completion. |
| Monthly invoice run ([`craftbook-invoice-run`](https://gezel.com/docs/craftbook/invoice-run/)) | Run a fan-out recipe: one invoice per client from the ledger, numbering that continues the sequence without a skip or a repeat, due dates per client's terms, and a one-page summary. |
| Author a recipe ([`craftbook-author-linear`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/author-linear.ts)) | Write a reusable three-step recipe from scratch, with a file deliverable gating every step, then run it to completion. |
| Select, then execute ([`craftbook-route-multi`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/route-multi.ts)) | Find the right library recipe and run it to a deliverable that holds up — graded on both the route taken and the properties a real deliverable of that kind has. |
| Generalize finished work ([`craftbook-export-generalize`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/export-generalize.ts)) | Do one quarter's data clean-up by hand, then turn that one-off pass into a reusable recipe and run it on the next quarter's different data. |
| Author a parameterized recipe ([`craftbook-author-params`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/author-params.ts)) | Write one recipe that serves two regions through an input parameter rather than by editing the recipe between runs; the two outputs must differ. |
| Author a gate script ([`craftbook-author-gate-script`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/gate-script.ts)) | Write a recipe whose build step is checked by a custom script embedded in the recipe itself; a script that approves everything fails. |
| Author a fan-out recipe ([`craftbook-author-fanout`](https://github.com/bendyline/gezel/blob/main/evals/src/craftbooks/authoring/author-fanout.ts)) | Write a recipe whose spawn block reads a list and produces one child run per item, with no tool call driving it; repeating the steps once per item by hand does not score. |

Nobody should expect full marks on either of these two. They exist because the
best models now score close to full marks on the first two sets, and a column
of near-perfect scores cannot tell you which model to choose. Low numbers here
are headroom, not breakage. Each task has a time limit, and at one attempt
per task the limits add up to 10 hours for the engineering set and 11 hours
25 minutes for the complex-workflow set. They are run less often than the
first two, so not every round in the scorecard includes them.

A model gets a score on each set it was run on. The sets measure different
things, and it is normal for a model to be strong on one and weak on another.
Plan and estimate and conflict synthesis deliberately appear in both the core
and productivity sets because they test capabilities that matter to each.

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
on a laptop at all. The Models catalog in the app is what knows your
hardware.

**A score is not a ceiling.** These are tasks we chose. A model that does
poorly here may be excellent at something we didn't think to measure.

## Run the same tests on your machine

Every install carries the test harness. **Settings → Benchmarks**, or
`gezel bench` in a terminal, runs any of the four sets against a model on your
own computer, with the same scenarios, the same automatic checks and the same
counting rules as the published scorecard. A run keeps going in the
background, and the results stay on your disk. One trial of a set is a spot
check and shows as counts; three trials is what it takes to quote a rate. The
two harder sets take most of a day at three trials, so both show the
worst-case time before anything starts. `gezel bench --json` writes a results
file in the scorecard's own format, and `gezel bench submit` shares it as a
GitHub issue; community rounds are shown separately from ours, with the
hardware named beside every number.

## Adding a model

New models get added to the same rounds and run through the same jobs, with
the same number of attempts, on the same machine. Nothing is graded on a
curve, and nothing is added to a table it didn't actually run in.

The current results are in [Model scorecard](model-scorecard.md).
