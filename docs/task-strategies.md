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
3. The task half of `config.generalistMode`, whose `auto` is generalist for
   hosted frontier providers and stepwise for on-device models.

`auto` never picks outcome. `generalistMode` still decides the Meester's
kickoff shape. A system job is always stepwise. Fanout children inherit the
parent's strategy.

The log marker the eval harness reads keeps its shape and gains a suffix:
`[tasks] <ref> generalist-mode resolved=<mode> setting=<s> provider=<p> tier=<t> requested=<r>[ owner=<id>] strategy=<s>`.

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
match nothing. What the task was handed (its title, request, launch
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
  a procedure names stays callable.
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
