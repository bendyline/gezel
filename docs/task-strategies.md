# Task strategies and book contracts

**Status:** runtime landed 2026-10-22. `auto` is unchanged; the strategy
benchmark (§6) decides whether it changes.

## 1. Three strategies

A task strategy is how much of a craftbook's recipe the runtime imposes on the
gezel doing the work. It is resolved once per task and stamped as
`Task.strategy`, next to `Task.executionMode`.

| | `stepwise` | `generalist` | `outcome` |
|---|---|---|---|
| Who works it | a specialist per step's `suggestedRole` | one owner | one owner |
| Sessions | a fresh one per gezel change | one continuous transcript | one continuous transcript |
| Tools | the active step's kit | the union of every step's | the union of every step's |
| The recipe | enforced, one step at a time | enforced, one step at a time | shown as advice; one step |
| Gates | every step gate | every step gate | the book's contract only |
| Teammates | — | — | `consult_<role>` (on by default) |

Outcome needs generalist's session semantics, so an outcome task runs with
`executionMode: 'generalist'` and an outcome-rendered book
(`craftbook.renderedAs: 'outcome'`). A reader that does not know the marker
sees a one-step generalist book. Code that branches on "one owner, one
session" keeps checking `executionMode === 'generalist'`; code that must treat
outcome differently uses `isOutcomeTask`. Both live in
[core/src/task-strategy.ts](../packages/core/src/task-strategy.ts).

## 2. Choosing a strategy

Precedence, highest first:

1. The task's own request: `CreateTaskRequest.strategy`, then
   `CreateTaskRequest.executionMode`. A launcher's lever (evals, the task
   composer); never on a model-facing tool schema. An explicit `outcome` on a
   book that cannot be rendered (§4) is an error, raised before an owner is
   recruited.
2. `config.taskStrategy` (`auto | stepwise | generalist | outcome`). Under it,
   a book that cannot be rendered as an outcome runs generalist with a
   warning in the log.
3. An explicit `config.generalistMode` (`on` / `off`): the person's choice
   about task execution, so it outranks any model's measurement.
4. The model's measured strategy: `tuning.taskStrategy` on the chat-model
   catalog entry (`{ strategy, procedure?, basis? }`), or a gezel's own
   `tuning.taskStrategy` override. Hosted models have no catalog entry, so
   theirs live in `HOSTED_MODEL_TASK_STRATEGIES` (core `task-strategy.ts`),
   keyed by provider and model: a measurement covers the model through that
   provider's tool loop only. It is read for the model the owner will
   actually run: the assignee's model, or for an auto-assigned single-owner
   task the Generalist gezel's model. An outcome pick that cannot render for
   this book (no contract, owner steps, branches) falls back to
   `generalistMode`'s task rule, with a warning naming the reason.
5. The default for a model nobody measured: outcome without the recipe on
   device (`llama-cpp`, `mlx`, `ds4`, `ollama`, and a paired device's
   `remote`) and on a hosted frontier provider (`copilot`, `anthropic`,
   `anthropic-cli`, `openai`, `codex-cli`). A book that cannot render falls
   back to `generalistMode`'s task rule: stepwise on device, generalist on a
   hosted provider. Any other provider (`mock` among them) gets that rule
   directly.

The pick ships as a gilde patch (the catalog read is tolerant, so older builds
ignore the field), and live gilde updates carry a new measurement to users
without an app release. Picks as of 2026-11-04: Gemma 4 E4B, Qwen 3.5 9B,
Ornith 1.5 9B and Qwen 3.8 27B all run outcome without the recipe. Round 2
scored the 9B higher with the recipe as advice, but the recipe overflowed a
32K window on powerpoint-deck, and a later screen tied the two on five of six
books. Round 1 had picked the 27B with the recipe and the 9B stepwise, but
its judge scored every folder deliverable 0, all three code books included;
re-judged (judge v3, 2026-11-07), round 1 picks outcome without the recipe
for both. Every
measured on-device model beat stepwise at a third of the wall time or less,
which is why an unmeasured one starts there.

A hosted model's pick ships with the app, in that table. Claude Sonnet 5.5
through `anthropic` runs outcome with the recipe as advice: on all 18 books it
matched generalist's quality at about a third of the wall time and a quarter
of the cost (2026-11-09, `evals/runs/frontier-2026-11-09/PREREG.md`).
GPT-6.1 Sol through `codex-cli` runs outcome with no recipe: both goal-based
strategies qualified against generalist, and goal only scored higher than
the recipe as advice, at 0.42x the wall time and a quarter of the cost
(2026-11-10, `evals/runs/frontier-sol-2026-11-09/PREREG.md`). The lookup
uses the model the task will run on, so a Codex session nobody pinned a
model for gets Sol's pick through the provider's own default.

Every other hosted model, including these two through another provider
(Copilot, the Claude CLI, the OpenAI API) and Claude Opus 5.5, is unmeasured
and runs outcome without the recipe (since 2026-11-10). The Sonnet
pre-registration required a second frontier model before the hosted default
could change; with Sol, both measured frontier models preferred a goal-based
strategy to generalist. Goal only is the default because it was Sol's
registered pick, cost less than the recipe as advice on both models, was
faster on Sol and as fast on Sonnet, and matched it on Sonnet's judged
quality. It is not the only reading:
on Sonnet, goal only missed the registered pass-rate bar (44 of 54 against 51),
though all but one of its failures were checks misreading correct work, while
the recipe as advice cleared the registered rule on both models. Sonnet keeps
its own measured pick.

A new model gets its own pick when it differs from a measured one in more than
quantization. Another quant of the same weights inherits the pick (Q3 and
below get a screen). A fine-tune kept its base's strategy in the one case
measured, Ornith 1.5 9B on Qwen 3.5 9B (2026-11-04), so a six-book screen
settles only whether the recipe helps. Another size in a family gets the
screen too.

A new project's shape follows the same pick, read for the install's default
model: a crew under a crew lead when it is `stepwise`, one multirole gezel
working alone otherwise (`resolveNewProjectMode`; see
[generalist-mode.md](generalist-mode.md) §4). A system job is
always stepwise. Fanout children inherit the parent's strategy.

The log marker the eval harness reads keeps its shape and gains a suffix:
`[tasks] <ref> generalist-mode resolved=<mode> setting=<s> provider=<p> tier=<t> requested=<r>[ owner=<id>] strategy=<s>[ source=model|tier][ procedure=none][ contract=shown|hidden]`.

`strategyOptions.contract` is an eval-only lever for measuring the contract
itself: `shown` shows the contract and checks nothing, `hidden` keeps it on the
task for grading but leaves the request as the only brief (the "harness" arm).
Neither turns on fact-checked writing, which enforces the contract.

The phone runs stepwise and generalist. It refuses an outcome request and
stands generalist in for an `outcome` install setting.

## 3. The book contract

A craftbook may declare `contract`
([schemas/craftbook-contract.ts](../packages/core/src/schemas/craftbook-contract.ts)):
the result the person asked for, stated so any strategy can be held to it.

- `goal`: one or two sentences, the outcome and its quality bar.
- `inputs[]`: what the book starts from.
- `deliverables[]`: `{ id, path, artifact?, kind, role, description, textSource? }`.
  At least one is `primary`. `textSource` names the gradable text behind a
  binary file (the `deck.md` behind a `.pptx`).
- `criteria[]`: `{ id, kind: acceptance | quality, text, enforce, checks?, judge? }`.
  `enforce` is `gate` (the default; must have checks), `advisory` (shown, not
  checked) or `eval-only` (graded by the benchmark, never shown to the model).
- `grounding`: `{ sources[], citationStyle: numbered | inline-path | any }`.

**A contract judges the result, never the process.**
`contractLintProblems` ([craftbook-contract-lint.ts](../packages/core/src/craftbook-contract-lint.ts))
flags a check on a file the contract does not declare. A check on
`outline.md` or `verdict.md` would fail every strategy that skips that step,
which is the bias the contract exists to remove. Process belongs in a
contract only when the person's request demands it ("reproduce it with a
failing test first").

The same contract applies under every strategy:

- **The prompt.** Every task session of a book with a contract gets a
  `### Task contract` block: goal, deliverables with their drawers, the
  quality bar with `[checked]` marks, and the citation rule. A stepwise
  session is told the step is its part of it.
- **The gate.** An outcome task's one step is gated by the contract. A
  stepwise or generalist task gets the contract added to its terminal step's
  completion gate (`withTerminalContractGate`), looping back to the step that
  writes the primary deliverable when it fails. A terminal step the person
  does themselves, or one gated at activation, is left alone.
- **Evidence across the whole task.** Contract checks read
  `researchEvidence` and `commandEvidence` with `window: 'task'`: what an
  earlier step, an earlier attempt or a teammate read still counts. A step's
  own checks keep the activation window.
- **Fact-checked writing.** A contract with `grounding` or a `claimsGrounded`
  check turns [factual writing](factual-writing.md) on for whoever works the
  task (`resolveFactualWriting`'s `taskGrounded`, reason `task`), so the
  generalist and outcome owner are held to the citation rule the way a
  stepwise researcher is.

### Facts cited and verified

`claimsGrounded` ([core/src/checks/claims.ts](../packages/core/src/checks/claims.ts))
makes "cited and verified" a check. It reads the deliverable's text, resolves
inline `(source: path)` citations and `[n]` citations against a Sources
list, reads each cited source (a file, or up to 50 text files under a
folder), and runs the same model-free grounding the write-time check uses: a
number, date or quote in a cited sentence must appear in the cited source.
Names are reported, not counted. A URL or `knowledge://` citation cannot be
checked offline and counts as unverifiable, and so does a cited PDF or
Office file: the check reads text, and a container read as text would
match nothing. An HTML deliverable or source is read as the text its reader
sees: the head, styles and scripts are dropped, and headings, lists, tables
and links read as their Markdown forms, so a page's Sources list and its
`<sup>` footnote links cite the way Markdown's do. A bare file name
(`[win-fulfillment.md]`) that exactly one workspace file carries reads as
that file. A parenthesis holding only file names (`(win-fulfillment.md)`,
`(timeline.md:10–13)`) is a citation when those files exist; one naming a
file that does not is prose, since a plan names files still to be written.
The document itself is never its own source, cited or inside a cited folder.
What the task was handed (its title, request, launch
parameters and today's date) is given text: a detail found there needs no
citation. Arithmetic on sourced figures counts as sourced: a sum,
difference or percent change of two figures stated in the same sentence or
within three sentences of it, at the precision written ("5.3-point drop"
beside "14.2% → 8.9%"; "66%" beside "18 hours to 6 hours"). Numbers that
order the text ("Step 2", "#1", "§5", a leading "1.") are not claims. Limits: `maxUnsupported`,
`maxBadCitations`, `maxUncited` (all default 0). A research deck's
"verified" is usually four checks together: `researchEvidence` (the sources
were read), `citationsResolve` (enough citations, all resolvable),
`claimsGrounded` (none unsupported), and `valueGrounding` /
`unsupportedClaims` for planted decoys.

Calibration (2026-10-22, 239 decks and reports left by earlier eval runs):
of the 63 decks that cite a readable source, 53 pass. The ten failures are
seven real problems (an invented "50%", D-Day dates from memory, two decks
citing a brief the model had overwritten, an uncited "250 years") and three
false positives: two short scare-quoted phrases read as quotations, and one
run date (given text now covers it). Reports that cite nothing fail because
every figure in them is uncited; that is the bar working, and a book whose
deliverable is not a fact-stating document should not carry the check.

### Drafting contracts for the catalog

Contracts are static: written once, reviewed, and released with the book, so
every model that runs it meets the same bar and no model writes its own. In
gilde, `node tools/draft-contract.mjs --missing` drafts them with Claude Opus
from each book's latest version (never its `test.json`), parses and lints each
draft, and gives a draft with problems a repair turn. Drafts land in
`tools/contract-drafts/` for review, a folder gilde does not commit, and
`add-contract.mjs --from <folder> --write` releases the reviewed ones as new
book versions. From then on a contract lives only in its book's versions, and
changing it is an ordinary new version. Until a person reviews it, a draft
enforces only checks of a file's form and its citations; the content patterns
are shown, not enforced, and the model's whole draft stays in `drafted.full`
for the reviewer who promotes them. `--reapply` re-derives every draft when
that policy changes, without calling the model.

Before release, `evals/src/bin/contract-replay.ts` grades saved trials with
the drafted contract and the released one, or with the trial's own eval
verdict when the book has none (`--reference ../gilde/data` includes
unreleased versions). It reads the files each trial left and names the
drafted criteria that block passing work. On the 18 benchmark books
(2026-11-05, 1,440 trials) the drafted gates agreed with the reviewed ones on
89% of trials, blocked 37 of 437 trials the judge rated 7 or higher (reviewed:
33), and passed weak work at the reviewed rate. On ten books without a
contract (229 trials) they agreed with the eval's own verdict on 80%. What
still misses is regex breadth: a pattern written without seeing outputs
misses a phrasing models use.

## 4. The outcome render

`renderCraftbookAsOutcome` ([craftbook-outcome.ts](../packages/core/src/craftbook-outcome.ts))
folds the book into one terminal step, `outcome`:

- **Prompt:** deliver the outcome in the Task contract; a note on teammates
  when they are on; then "Recommended approach (advisory)", every original
  step's procedure in order, with a fanout described inline ("for each item
  in `items.json`"). `procedure: 'none'` leaves the recipe out.
- **Gate:** the contract's checked criteria, task-wide. No `onReject`: the
  rejection re-prompts the owner, who can fix anything. `maxAttempts` is 4,
  the tries a stepwise run gets at the same contract on its terminal step
  (where the plateau pause ends the loop on the fourth identical rejection,
  however many loop-backs reset the attempt count).
- **Auto-finish:** the step takes the `advanceWhen` of the step that wrote the
  primary deliverable, so a model that does the work but forgets
  `advance_task_step` still reaches the contract check.
- **Kept from the entry step:** role, assignee, retrieval, `consumes`,
  `onEnter`. The authoring note comes from the producing step.
- **The tool surface** reads `craftbook.sourceSteps` (the original steps and
  the fanout template's, as `each-<id>`) through `taskSurfaceSteps`, so a tool
  a procedure names stays callable. It is the union of those steps' kits, also
  for an owner with its own toolset installs: the installs cap the union rather
  than replacing it, so the owner does not carry its whole roster.
- **Refused** (`outcomeRenderGap`): no contract, or one with nothing checked;
  a step the person does; `runWhen`; script branches; an activation gate; an
  `onEnter` after the entry step; any `onExit`. Each depends on the recipe's
  order, which an outcome gives up.

The prompt anchor changes too: an outcome task gets no "first action" pin and
no "Step procedure takes precedence" line. It is told the contract is what it
is held to and the recipe is advice.

### Teammates

An outcome owner with teammates on gets `consult_researcher`,
`consult_reviewer`, `consult_writer`, `consult_developer`, `consult_planner`
and `consult_designer`, kept through the tier cap. They are synchronous: the
teammate works in the project and answers within the owner's turn. Async
`delegate_<role>` is not offered, because an owner that ends its turn to wait
leaves the task idle for the stuck-step sweep.

The calls go through `POST /api/projects/:id/tasks/:num/teammates`
([tasks/teammates.ts](../packages/service/src/tasks/teammates.ts)), not the
coordinator routes, so the owner never gets the team credential. The guard
binds the request's origin to the session token; the handler admits only the
task's own owner session, on an outcome task with teammates on.

The teammate's session is a consultation stamped `subagentFor: { taskRef,
ownerSessionId }`. It is **not** a task session: no task context, no task
tools, no step binding. Its `tool.called` events and script receipts carry the
task's ref, so what it reads counts toward the contract's task-wide evidence.
`staleStepSessionRefusal` refuses it any status change or step advance on that
task.

### Review once the checks pass

An outcome task can get one review after its contract checks first pass
([core tasks/outcome-review.ts](../packages/core/src/tasks/outcome-review.ts),
[service tasks/outcome-review.ts](../packages/service/src/tasks/outcome-review.ts)).
`self` hands the owner a focused review prompt in its own conversation; `fresh`
has the owner review its deliverables again in a new session with no
transcript (`ChatManager.askFreshEyes`), and its findings go back to the
owner's own conversation. Both use one focus list, a five-finding cap, and the rule that a
fix removes or corrects and adds only what the sources state. The contract
checks run again after the fixes; there is one round.

`resolveOutcomeReview` decides it once at create and stamps it as
`strategyOptions.review`. All four must hold:

- **The person** has not set `config.taskReview` to `off` (Settings →
  Artificial intelligence → "Check work before handing it in"; `auto` when
  unset).
- **The strategy** is outcome. Stepwise and generalist books carry their own
  review steps, and only outcome was measured.
- **The book's work suits a review** (`contractSuitsReview`): the contract's
  `reviewable`, else a primary deliverable that is a report, document, notes,
  spec or security report (`REVIEW_SUITED_DELIVERABLE_KINDS`). Code, data
  files, decks and games are verified by their checks, and reviews of them
  changed little and mostly re-edited code.
- **The model that will run the task** was measured to gain from one:
  `tuning.taskStrategy.review` in its catalog entry, or the gezel's own
  `tuning.taskStrategy`. Unmeasured models, hosted ones included, get none.

A fresh review session is read-only (`ChatSession.reviewFocus`): its built-in
tools are `REVIEW_FOCUS_BUILTIN_TOOLS` whatever the role, installed toolsets,
app tools and project script tools are withheld, and the Claude and Codex CLI
providers run in `plan`. Telling the reviewer not to edit did not hold: in the
counted test the fresh reviewer (then a recruited Reviewer gezel) changed the
project in all six bug-fix trials and twice undid a correct fix. With no write
tool on its roster, a local engine also cannot switch the review into its
write-the-file mode, which the quoted request once triggered. The reviewer is
the owner itself, so the review runs on the model it was measured on and
recruits nobody.

The fresh brief lists the deliverables and marks the ones in the artifacts
drawer. A brief that named the tool for each one (`read_file` in the
workspace, `read_artifact` in the artifacts drawer, a folder listed first)
was measured on Gemma 4 E4B and reverted
(`evals/runs/review-fresh-brief-2026-11-12/`): reports of a deliverable
missing without opening it stayed at 2, and two reviewers read "a folder in
the workspace" as a path and listed `workspace/`, which does not exist.

While the round runs, the request tracker reads the step as checking the work.
Each round's record and a copy of the deliverables from before it go to
`artifacts/outcome-review/<num>/round-<n>/` (`before/`, listed in
`before.json` with whether the copy is complete), hidden from default listings
and from bare-filename lookups.

A review never turns work that passed into a paused task. When the revision
fails the contract checks and the gate is about to pause (attempts spent, or
the plateau ladder at its top), `finishOnPreReviewWork` puts the deliverables
back as they stood before the review, keeps the revision in `revision/`, and
checks the gate again; the task finishes on the restored work when it passes.
Files the revision added inside a deliverable folder are removed. When either
copy is incomplete (a file over 1 MB, more than 200 files), the workspace
cannot be written, or the restored work no longer passes, the revision goes
back and the task pauses as it would have. A revision that fails with attempts
left gets them, as before.

Evidence, from the counted test (2026-11-11/12, 216 trials,
`evals/runs/review-counted-2026-11-11/PREREG.md`): on Qwen 3.8 27B, self-review
improved the work, scoring +0.34 [+0.17, +0.52] in a blind comparison of the
copy from before the review against the final work. It made no regressions, two
rescues, and added a median 1.3 minutes. On Gemma 4 E4B, self-review had no
effect (+0.01), and fresh eyes (+0.23 [+0.05, +0.44]) were excluded because
that reviewer edited the project. The read-only design, re-measured on Gemma
(`evals/runs/review-fresh-confirm-2026-11-12/`, 54 trials), scored +0.19
[+0.02, +0.36], with one regression, two rescues and no reviewer edits, so
Gemma 4 E4B gets `fresh`. Its losses split between wrong findings and revisions
that broke what they fixed, often by rewriting the whole file. A second Gemma
run with the per-tool brief and the restore scored +0.17 [+0.02, +0.35]; two
revisions there dropped required content to answer a finding (an alert rule a
finding said to remove, the amounts in an invoice table), and the runtime's
checks passed both, so the restore had nothing to act on. Rules telling the
reviewer and the owner never to remove required content and to edit in place
were then measured and removed (`evals/runs/review-fresh-keep-2026-11-12/`):
content loss went to 0, but E fell to +0.00 [-0.20, +0.18], with owners
filling gaps by invention or by duplicating text instead. On Qwen 3.5 9B
(`evals/runs/review-9b-self-2026-11-12/`, 51 trials), self-review scored
-0.11 [-0.28, +0.08]: its revisions helped when they took out an unsupported
claim and hurt when they took out or rewired citations, and twice cited the
report itself. The 9B gets no review. Eval homes set `taskReview: 'off'` so
earlier rounds stay comparable.

## 5. Keeping the strategies comparable

Things that used to differ by strategy without anyone choosing it:

- **Tier collapse** fires only for generalist tasks on tiny models. Strategy
  evals set `GEZEL_DISABLE_TIER_COLLAPSE=1`.
- **Fact-checked writing** followed the role. It now follows the contract
  as well (§3).
- **Contract retries.** Outcome's contract gate allows 4 attempts. A
  stepwise run gets the same four tries at the contract on its terminal
  step, because the plateau pause stops it at the fourth identical
  rejection.
- **Grading.** A test that grades intermediate files grades the recipe. For
  a strategy trial, the benchmark grades the contract's deliverables and the
  test's result checks. Everything that grades the recipe being followed is
  reported as process and not judged:
  - process files, and checks against them (including `outlineFile`);
  - unread seeded inputs;
  - required tool calls;
  - History evidence;
  - task notes.
- **Evidence windows.** Contract checks read evidence across the whole task.
  A recipe gate's evidence checks read the step's current visit: a gate
  that sends a rejection back to its own step starts a fresh pass, but
  earlier passes still count (`evidenceSince`). Before this, a stepwise
  or generalist run had to repeat a test run after any rejection, even one
  about citations, while an outcome run did not.
- **Stall windows and retries.** The runtime re-prompts a silent step
  after 8 minutes. The harness therefore waits at least 12 minutes on a
  silent strategy trial, and at least 20 on one making no real progress.
  It never presses "Try again" on a paused strategy task: a pause ends the
  trial, so every arm gets the same gate budget.
- **Context overflows.** A trial ends on an overflow only in its own task's
  sessions (`EvalScenario.ownTasks`). A scheduled check-in that overflowed a
  crew lead's session ended a stepwise trial whose steps were done
  (2026-11-03), and stepwise holds more sessions for such a side
  conversation to land in.
- **Check-ins.** The Meester's scheduled check-in may not start a task: the
  daemon refuses a launch from the turn that answers it (`check_in_turn`).
  Small models had answered "how far along is each goal?" by launching a
  status-report book, which then took turns on the one engine slot beside
  the trial's task, in 4 of 144 round-1 trials and 2 of 47 early round-2
  ones.

## 6. Measuring

The benchmark compares `stepwise`, `generalist`, `outcome`, and two outcome
variants (`outcome-solo`: no teammates; `outcome-bare`: no recipe) per model
tier, on books that carry a contract. The pre-registration is
`docs/evals/strategy-prereg-2026-10-22.md`, the harness is
`pnpm eval:ab-strategy`, and results live under `evals/runs/strategy-*`.
`--judge` adds the blinded judge (P3). `--judge-validity` also runs the
judge's validity checks: test-retest, planted defects, and a second judge
on a quarter of each model's trials.
`auto` changes only when a strategy clears the pre-registered decision rule
for a tier.
