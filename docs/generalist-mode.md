# Generalist mode — spec and status

**Status:** v2 runtime shipped 2026-09-18 (this document); eval campaign pending
(see §8). Supersedes `frontier-adaptive-execution.md`, whose original spec is
kept as an appendix below.

## 1. What it is

One switch, `config.generalistMode: 'auto' | 'on' | 'off'`, decides how much
orchestration wraps a piece of work. Two things hang off it:

| Facet | `on` | `off` | `auto` (default, incl. unset) |
|---|---|---|---|
| **Task execution** (`resolveTaskExecutionMode`) | `generalist` | `stepwise` | `generalist` for hosted frontier providers (copilot, anthropic, anthropic-cli, openai, codex-cli); `stepwise` for every on-device model at every tier |
| **Kickoff shape** (`resolveGeneralistKickoff`, the Meester's `start_project`) | solo lead (Builder template) | crew | solo for frontier providers **and** local `medium` (the measured 2026-07-17 rule); crew otherwise |

Both live in [core/src/generalist-mode.ts](../packages/core/src/generalist-mode.ts).
The resolver ignores the tier for task execution on purpose: the single-session
plus union-tool-surface semantics are unmeasured on local engines, where tool
schemas dominate prompt mass. The eval campaign (§8) decides whether local
`medium` joins.

The Settings switch is under Artificial Intelligence → "Run in generalist mode".
The pre-v2 key `executionDensity` (`flat` ≙ `on`, `scaffold` ≙ `off`) is
migrated once by `Store.ensureLayout` and is never written by current code.

## 2. The contract of a generalist task

- **One owner.** Every step of the task — and every fanout child — is pinned
  to one gezel. Generalist mode overrides *role resolution* (a `suggestedRole`
  that would recruit a specialist), never an explicit pin: a task whose caller
  named an assignee keeps that gezel as the owner, `assignee.kind === 'user'`
  steps stay with the user, and a step explicitly pinned to another gezel is
  left alone. An auto-assigned task gets the **Generalist** gezel (gilde
  template `generalist`, one per install, reused by template id, pulled onto
  the project roster).
- **One continuous session.** Adjacent steps already shared a session when the
  same gezel owned them; a generalist task extends that to every step,
  including when a send is queued behind the current turn (the re-pin waits
  for the queue to drain) and when the caller did not label the handoff as a
  self-handoff. A fresh session is opened only when the provider or model
  changed under the task (logged as `generalist continuity broken`), or on a
  retry whose prior transcript ended in a context overflow or a
  compaction-loop halt — resuming that transcript would replay the failure.
- **Steps and gates are unchanged.** The active step still advances one at a
  time through `advance_task_step`; every step gate is still evaluated. There
  is no tier-collapse and no gate union in this mode.
- **The whole outline is in view.** The task block carries `### Task outline`
  — the book's goal and every step marked done / active / pending, with
  fanout steps annotated — and the recency anchor says the owner owns every
  step while only the active step's procedure is in force. It lives inside the
  task block so the `focused` prompt profile keeps it.
- **The tool surface is the union.** The deliverable kit, the tools every
  step's procedure mandates, the conditional built-ins and the research-intent
  flag are unions over all of the task's steps, under the same `mode: 'never'`
  security ceiling. The active step's authored `toolPolicy` still applies
  afterwards — fixed-action steps depend on it for auto-advance. The union is
  invariant across steps, so the tools block stays prefix-cache-stable on local
  engines; only the task block changes per step.
- **No per-step model routing.** The runner passes no `capabilityFloor` for a
  generalist task: one model per run, the owner's pin or the install default.
  Routing per step would move the owner between models, and a model change is
  exactly what breaks the shared transcript.
- **Fanout is preserved.** A `spawnFanout` step still spawns one child task
  per item; each child inherits `executionMode` and the pinned owner, and runs
  in its own session (that is the parallelism). The host's session is held by
  the fanout barrier and re-engaged — same session — when the last child
  settles.
- **Resolved once.** The mode is decided at task create (or at `activate()`
  for a draft, which carries an explicit request through) and stamped as
  `Task.executionMode`; children copy it. Flipping the setting never changes a
  running task.

## 3. Where it lives

| Concern | Code |
|---|---|
| Setting, resolvers, legacy mapping | [core/src/generalist-mode.ts](../packages/core/src/generalist-mode.ts); schema docblock in `core/src/schemas/api.ts` |
| Task stamp and per-invocation override | `Task.executionMode`, `CreateTaskRequest.executionMode` in [core/src/schemas/task.ts](../packages/core/src/schemas/task.ts) (not on the model-facing MCP schemas) |
| Resolution + owner pinning | `TaskManager.applyExecutionMode` / `setExecutionModeResolver`, `pinCraftbookOwner` in [tasks/craftbook-instantiation.ts](../packages/service/src/tasks/craftbook-instantiation.ts); the closure in `product-service.ts` beside the role resolver; `ChatManager.classifyExecutionTier` |
| Generalist gezel | `ensureGezel({ templateId: GENERALIST_TEMPLATE_ID })` in [gezels/ensure.ts](../packages/service/src/gezels/ensure.ts); role `generalist` in `core/src/roles/registry.ts` |
| Session continuity | `ChatManager.startHandoffSession` (`generalistTask`, `compatibleTranscript`); `sessionContextPoisoned`, `renderEntryPreface`, `classifyExecutionTierFor` in [chat/generalist-continuity.ts](../packages/service/src/chat/generalist-continuity.ts); resolver types + `applyExecutionMode` in [tasks/execution-mode.ts](../packages/service/src/tasks/execution-mode.ts) |
| Routing skip | `TaskRunner.tickOnce` floor derivation |
| Outline + anchor | `renderTaskOutline` in [chat/instructions.ts](../packages/service/src/chat/instructions.ts) |
| Union surface | `generalistSteps` / `unionStepKit` in [chat/session-tool-surface.ts](../packages/service/src/chat/session-tool-surface.ts) |
| Kickoff env to the MCP child | `GEZEL_GENERALIST_KICKOFF=on|off` (was `GEZEL_EXECUTION_DENSITY`) |
| Log marker (evals read it) | `[tasks] <ref> generalist-mode resolved=<mode> setting=<s> provider=<p> tier=<t>` |

## 4. Why the kickoff keeps a local-medium exception

The 2026-07-17 paired A/B (llama.cpp, N=3 core) measured *solo kickoff* for
local 12–45B models: flat ≥ scaffold on every scenario, zero regressions over
24 paired trials. That mechanism is unchanged, so its rule is kept. The v2
task-execution semantics are a different mechanism and are unmeasured on local
engines; they stay off under `auto` until §8 says otherwise. A consequence to
know about: `anthropic` / `openai` SDK installs on `auto` now get solo kickoff
as well (the frontier rule applies to every hosted provider); `off` is the
escape hatch.

## 5. Known gaps

**Found by the first campaign cell (fixed 2026-09-18):** the scheduler's
stuck-step sweep re-drove steps through `messageGezel`, bypassing both the
runner's fanout admission and the fanout barrier. On `fanout-stories` it
opened five child sessions at once on a one-slot MLX engine at the 8-minute
stall bar, drove the barrier-held host early, and its own dispatch then made
the real barrier release look like a duplicate handoff, so the host never
collected. The sweep now skips a step whose handoff the runner already holds
(`TaskRunner.hasHandoffFor`) and a spawn host with active children. Two
scenario-side lessons rode along: a fanout child inherits the host's
description unless the variation carries its own (a child tried to advance to
the host's `collect` step), and a mechanics probe should disable the project's
Meester nudge (`nudgeConfig.enabled: false`), which otherwise spends the
engine slot mid-fanout.

**Found by the dry run's craftbook cells (fixed 2026-09-18, harness side):**
under the default `harness` repair policy the eval harness was a third actor
in the A/B. Twenty milliseconds after `invoice-run` was dispatched it told the
owner, in a plain session, that the task "has not reached a terminal step";
the 27B read the task ref as a file path ten times and then edited the ledger
fixture back and forth under the real task session's feet. Two minutes in,
because the worker's role ("Office manager") scored 0 as an implementer for
`report.md`, the harness recruited a Developer who wrote the book's LAST
deliverable outside the task, and the trial was then failed on that file
while the real task sat on step one. Both arms lost the cell the same way, so
the cell measured the harness, not the mode. Three changes: the running-
workflow nudge now waits out a start-up grace and is held while the owner is
mid-turn (`RUNNING_WORKFLOW_GRACE_POLLS`), missing-deliverable nudges are
pinned to the task's assignee (`targetGezelId`) so no Developer is recruited
for an assigned task, and a `--repair-policy runtime` override exists at
trial level, which `pnpm eval:ab-generalist` uses by default so craftbook
cells run on the runtime's own gates, retries and stall sweep alone. The
stepwise `codemod-sweep` cell of the same run fell to a fourth edge of the
same channel: the harness's poisoned-session recovery could not map the
sniff to a file, wrote `write_file({ path: "<workspace-relative-file>" })`
into the Codebase Analyst's task session, and the daemon's read-pacing
guard lifted that placeholder as the expected file and aborted the
read-heavy `enumerate` step after six reads. The harness no longer quotes a
placeholder as a path, and `deliverable-read-pacing.ts` ignores any target
carrying angle brackets or template braces.

**Runtime defects the generalist `codemod-sweep` cell exposed (fixed
2026-09-18, service side):** the tool-argument coercion accepted only
lowercase `true`/`false`, so a model writing Python-style `True` looped on
the validator until the five-failure abort (`verify_outcome`, `list_artifacts`,
`grep_artifact` all hit it); completing a step on a paused task threw a bare
error that reached the model as `internal_error`, so it retried the same call
twice (now a typed `StepCompletionBlockedError` answered with 409 and an
instruction); and the stage-one gate nudge opened with "EXISTS but fails"
directly above bullets reading "not found", after which the model decided the
gate was stale and kept re-reading a same-named workspace copy instead of
writing the artifact (the nudge now says the deliverable does not exist and
names the drawer). The mode itself behaved: one task session for the whole
run, the outline in the prompt, no compaction at 21k of 262k tokens.

**Found by the first relaunch on the rebuilt dist (fixed 2026-09-18, service
side):** with the stall sweep no longer re-driving around fanout admission,
`fanout-stories` exposed the cadence the old sweep had been masking. A local
provider closes an immediate-write turn the moment the requested file lands,
before the model can call `advance_task_step`; the child then sat idle with
its admission slot held until the eight-minute stall bar, so five serial
children on one MLX slot could never finish inside the scenario's thirty-minute
ceiling (the previous run's "two stories at nine minutes" was exactly this).
Providers now report the bail on the session (`LLMSession.lastTurnBail`) and
a task handoff whose first turn ended that way with the step still active
sends one bounded continuation in the same session; the sweep remains the
backstop.

**Found by the second relaunch's `invoice-run` cells (fixed 2026-09-18):** on
qwen3.8-27b-q4 the `scope` step dies the same way in both arms — a `read_file`
call-shape loop, then a `write_task_note` repeat loop — and the handoff's three
bounded sends are spent inside ten minutes. What followed was the finding: the
runner dropped the failed handoff and left the task active with nothing queued,
and the stall sweep never touched it because its only session had aborted its
last turn (`landingPoisoned`, a silent return). Meanwhile the Meester's
check-in opened a fresh 27B session every few minutes and a recruited gezel
made 31 `consult_meester` calls, which the harness counted as hard progress,
so the trial ran to its 100-minute cap. Three changes: a failed dispatch now
pauses the task for help with the reason on record (`pauseAfterFailedDispatch`,
wired in product-service), the sweep escalates a stalled step whose landing
session is poisoned instead of skipping it silently, and under the runtime
repair policy the harness earns ceiling extensions only from deliverable
movement (workspace bytes, sniff verdict), never from tool calls or sessions.
The codemod stepwise cell that followed showed the runner-side pause never
sees the common case — `startHandoffSession` detaches its sends, so the
bounded retries exhaust inside the chat manager — and the sweep's poisoned
branch ended that cell at 22 minutes instead; the chat manager now reports
exhaustion through `setHandoffExhaustedHandler` and product-service pauses
the task at that moment through the same guarded closure.
Open: the Meester check-in cadence on a one-slot local engine is expensive
supervision (about 33 sessions in 90 minutes here) and is worth its own look.

The `scope` loop itself turned out to be a drawer confusion the runtime could
speak to (fixed 2026-09-18): the first gate verdict named `tasks/1/scope.md`
as missing, the model tried to READ that path with the workspace tool five
times, and the failure tracker then blamed the call shape — the one diagnosis
that could not help, since the file was the model's own deliverable to create
with `write_artifact`. The tracker now recognises a read that keeps answering
"not found", says the path does not exist, and names only the writer the turn
actually wired; the first gate verdict for a missing artifact or workspace
deliverable now says which drawer it lives in and which tool creates it.

**Found by the breadth run's first cell (fixed 2026-09-18, pending rebuild):**
the `fanout-tally` host completed its terminal `merge` step with
`next: merge` — naming its own step — and the runtime completed the step and
then re-activated it as the jump target, turning "done" into a self-loop that
the stall sweep broke nine minutes later. The step-complete route now refuses
a `next` that names the current step, and any `next` on a terminal step,
with the same kind of explanatory 400 as an unknown `next`.

**Found by gemma4-12b-q4's `invoice-run` cell (fixed 2026-09-19, pending
rebuild):** gemma cleared `scope`, the fanout spawned three invoice children,
and each child then completed its only step `draft-invoice` three times over
— the runtime answered every completion with "Active step is now 'Draft the
invoice…'" and started a fresh handoff. A step with no `next` and no
following step left `newActive` holding the completed step's own id, so the
book's last step re-activated itself forever; the host's barrier waited on
children that could never settle and the trial died of silence. A dead-end
last step now completes the task, for every task type; a deliberate
self-loop says so with `next`, as the night-shift oversight task does. This
is the same gilde dead end recorded under open items, now harmless at the
runtime.

**Found by the same gemma cells (fixed 2026-09-19, pending rebuild):** an
artifact-checkpoint step advances on one file (`billables.json` for
`scope`) but its procedure writes another first (`scope.md`), and the
provider treated the FIRST `write_artifact` as the step's terminal action:
the turn ended on `scope.md`, the bounded recovery restarted the procedure
from the top, and whether the checkpoint ever got written came down to luck
(the stepwise specialist wrote it on its third and last try; the generalist
owner wrote `scope.md` three times and was paused). A checkpoint step's
terminal write is now only the write of the checkpoint file
(`terminalToolPolicy.onlyWhenArgEquals`), and the recovery message names
that file.

**Found by the Opus smoke probe (fixed 2026-09-19, in the rebuilt dist):**
`codemod-sweep` failed its `verify` step in both arms for one cause that has
nothing to do with the mode. The Claude CLI and Codex CLI providers hide
gezel-mcp tools that overlap their built-ins, and that list included
`run_package_script`, `run_npx` and `list_package_scripts` as Bash duplicates.
But a `commandEvidence` gate counts only the run receipts those runners
write; a Bash run of the same command leaves none. So the gate rejected
"no `npm run test` run was observed" while Opus had already run the suite
through Bash, and its search for the runner the gate named found nothing.
Every book that proves its work by running the suite (`codemod-sweep`,
`refactor-module`, `bug-fix-tdd`) was unpassable on both CLI providers in
both execution modes. The receipt-bearing runners now stay advertised on
those providers (pinned by a test), and the gate's rejection offers an honest
exit when the runner is genuinely absent. A second, harness-side hole hid
behind the first: the eval worker's toolset roster had no `code-execution`
group, which the stepwise arm masked (a recruited developer brings the group
in its own role kit) and the generalist arm exposed (the pinned worker's
roster IS the surface). The group is now part of the worker's base roster.

**Found in every Opus cell's side traffic (fixed 2026-09-19, in the rebuilt
dist):** the bundled night-shift oversight task runs a single step whose
`next` is its own id. When the Meester finished a run and called
`advance_task_step`, the step completed and was immediately re-activated as
its own successor, which bumped its activation stamp; the task runner's
stale-dispatch sweep read the new stamp as a superseding dispatch and
cancelled the very turn that had just advanced the step ("The task moved on
… so this turn was ended"), while it was streaming its closing words. The
runner then treated the cancelled turn as a failed handoff and re-ran the
whole oversight — twice the Opus spend per run, a spurious "handoff failed"
warning, and in one cell a "paused for help" after the bounded retries. A
gate hold already hands its re-activation to the live dispatch; a
self-routing completion now does the same, so the turn finishes and the
step stays armed for the next window.

**Found by the smoke rerun's codemod cell (2026-09-19):** with the runners
advertised, the generalist owner ran the whole book in one session in under
nine minutes, two suite runs receipted, the review a PASS, the task complete.
The trial still booked as a failure on two checks that are not the mode's.
The harness required every seeded workspace fixture to be opened, and
`package.json` never was: the owner ran the suite through the runner, which
reads the manifest itself, and the book never asks anyone to open it. A
successful package-script call now counts as reading a seeded `package.json`.
The second check is the eval spec's own: the DONE note must name the literal
test command (`npm run test` or `node --test`), while the book's `finish`
step asks for deliverable paths and per-criterion evidence and never mentions
the command. That gap is in the gilde sidecar (`codemod-sweep/test.json`, and the
same rule in 26 sibling specs), left as it is. The stepwise crew cleared
both checks in the same rerun: its analyst opened `package.json` while
enumerating and its project lead's DONE note cited `node --test`, so on
this cell the spec's strictness produced a real pass/fail split between
the arms that the book's own instructions do not explain.

**Found by the reference run's first stepwise cell (fixed 2026-09-19, in
source; the dist is rebuilt after the run):** `fanout-tally` passed in both
arms, but the generalist host finished 63 seconds after launch and the
stepwise host took 536 seconds for identical work. The stepwise host's log
shows the barrier release firing when its last child settled, then nothing
for eight minutes until the stall sweep messaged it. The step-activated hook
resolved the next owner from the step's own binding only; a create-time
fanout host, like any ad-hoc task with a task-level assignee and plain
steps, has no step binding in stepwise mode (generalist mode pins every
step, which is why that arm never noticed), so the release enqueued no
handoff and the host waited for the sweep. The hook now resolves the owner
through the same three-level rule entry dispatch uses, falling back to the
task-level assignee. Every stepwise fanout wall-clock recorded before this
fix carries that eight-minute penalty (runs 3, 5, 6, 7, 8 and the first two
cells of run 9); the generalist figures are unaffected.

**Found by the reference run's `schema-migration` pair (fixed 2026-09-19 in
the evals source; this run's pair is a wash):** both arms stopped at four of
seven signals and died of the fifteen-minute no-progress watchdog. The
handlers file Opus wrote was correct: it composed the display name through
the file's own `formatDisplayName` and used that in the card and the log
summary. The oracle's card check demanded the `firstName`/`lastName` reads
inside `renderUserCardHtml` itself, although its summary check already
accepted the same delegation. Under the runtime repair policy a scenario's
sniff is a pure oracle with nobody to relay its verdict, so an oracle that
is stricter than the book's own contract does not merely mis-score, it
strands the trial. The card check now accepts the helper. The same
investigation showed the scenario is not the kickoff canary the suite called
it: its setup pre-recruits a Developer and messages it directly.

**Found by the reference run's generalist `codemod-sweep` cell (fixed
2026-09-19 in source; the dist is rebuilt after the run):** the cell passed,
but took 35 minutes for work the smoke rerun did in nine. The owner ran
`enumerate`, `apply`, `verify` and `evaluate` in one session, graded its own
sweep REVISE, and the gate routed the task to `repair`. Three things then
went wrong at once. The gate loop-back path fires no handoff when the
rejecting call came from a model turn, on the theory that the live turn
"continues the repair loop" — true for a self-route, not for a route to a
different step: that turn is pinned to `evaluate`'s procedure and cannot
see `repair`'s. The step-scope write guard then refused the owner's first
repair edit with "yield to the active step's gezel", which was itself. And
with the turn ended, nothing re-engaged the owner until the Meester's
ten-minute check-in, after which the voorman reassigned the task twice,
added a step, and the stall sweep finally re-drove `repair` 22 minutes
later. A route to a different step now dispatches its target (a continuity
re-pin for the same owner, a handoff otherwise), the guard tells a session
that also owns the new step to end its turn and wait for the re-pin, and
the claim-check nudge counts `write_artifact` as a deliverable write, which
it did not before.

**Found by the reference run's generalist `refactor-module` cell (fixed
2026-09-19 in the evals source):** the owner shipped a passing refactor (29
of 30 checks, tests green, the DONE note naming the command) and was failed
for "never having read" the five seeded inputs. It had read all five in one
`read_artifacts` call: the artifact readers fall through to the workspace
when the path is not an artifact, and on the Claude CLI, where `read_file`
is hidden, a model that goes looking for a workspace reader lands on them.
The seeded-read rule now counts the artifact readers when the path they
name is a seeded workspace path. Same defect family as the fanout receipts
and the `package.json` rule above: the harness knowing fewer ways to read a
file than the provider has.

**Found by the local rates run's gemma `invoice-run` cell (fixed 2026-09-19
in source; the dist is rebuilt after the run):** the third invoice child
had its `write_file` rejected ten times for a missing `path` while the
model insisted, correctly, that it had sent one. It had opened `content`
with Gemma's native quote token and closed it with a Python-style `"""`
before writing `, path: "invoices/2026-044.html"}`; the native parser's
unterminated-string fallback, meant for output that was cut off, took the
rest of the buffer as the content, path and all. The barrier waited on
that child for half an hour until the stall sweep and the unresolved-tool
ledger paused it. The fallback now splits at the last run of plain quotes
that is followed by another argument or the closing brace; a genuinely
truncated string still takes the whole remainder.

- **Anthropic SDK replays without compaction.** `checkContextPressure` returns
  early for non-local providers while the `anthropic` provider replays the
  whole transcript. A long generalist run on that provider can overflow. The
  fix is to give `AnthropicSession` a `numCtx` (from the catalog context
  window) and an `estimatePromptChars()` and admit it to the pressure gate;
  tracked, not yet built. The eval campaign uses `anthropic-cli`, whose CLI
  owns its own compaction.
- **CLI providers and a rebuilt system prompt.** anthropic-cli re-spawns each
  turn with `--resume` plus a freshly written `--append-system-prompt-file`,
  codex-cli writes `instructions` per `codex exec resume`. Verified for
  anthropic-cli by the Opus probe (2026-09-19): the generalist owner of
  `codemod-sweep` ran `enumerate`, `apply` and `verify` in one session, and at
  each step it followed that step's own procedure (the `apply` deliverable
  with its three required sections cleared the gate on the first attempt),
  which only the rebuilt prompt carries. codex-cli remains to be checked with
  a two-step book; the seed message and the outline make a stale prompt
  survivable either way.

## 6. Evaluation

**Lever.** `--generalist auto|on|off` (`TrialOptions.generalistMode`, stamped
on `result.json` and `facts.json`). Arms force `on` / `off`; `auto` is never an
arm (for task-driven scenarios it equals `off` on local models). Note that
`schema-migration` is not Meester-driven: its setup pre-recruits a Developer
and messages it directly, so both arms run the same plain chat with no task
and no kickoff, and its pair measures the model, never the mode or the
kickoff shape (the campaign's earlier read-outs called it a kickoff canary;
corrected 2026-09-19).

**Facts.** `facts.continuity` ([evals/src/continuity-facts.ts](../evals/src/continuity-facts.ts)):
steps activated/completed and per-step timings, gate rejections, sessions per
step and sessions reused across steps (the generalist signature, joined
through `tool.called` events), compactions between-turn / mid-turn / force-fit
with the max context fill, fanout children spawned/completed with barrier
holds and releases, and budget trips. Compaction is `observable: false` for
CLI wrappers and Copilot — their zeros are `n/a`. Failure classes gained
`cloud-context-overflow`, `fanout-skipped`, `fanout-barrier-stuck`,
`cli-resume-failed`, `compaction-degraded` (infra) and `compaction-loop`,
`task-budget-hard-pause`, `tool-repeat-abort-storm` (model).

**Suites.** `generalist` (7 members, cheapest-first: `fanout-tally`,
`fanout-stories`, `schema-migration`, `craftbook-invoice-run`,
`craftbook-author-linear`, `craftbook-codemod-sweep`,
`craftbook-refactor-module`) and `generalist-smoke` (`fanout-stories`,
`craftbook-invoice-run`, `craftbook-codemod-sweep`). The two `fanout-*`
scenarios are hermetic create-time fanouts (no gilde book) that grade fanout
mechanics: N children spawned and completed, each deliverable written by its
own child, the host writing none of them, the barrier held until the last
child settled.

**Bin.** `pnpm eval:ab-generalist` ([evals/src/bin/ab-generalist-mode.ts](../evals/src/bin/ab-generalist-mode.ts))
runs the arms interleaved per scenario (drift hits both arms), lays them out as
`evals/runs/ab-generalist-<ts>/<model>/<stepwise|generalist>/<scenario>/<trial>/`,
and writes `ab-summary.json` + `ab-summary.md` with pass n/N, median
wall-clock, steps, sessions per step, compactions, max context fill, fanout
integrity, failure classes and bug-watch flags per cell, plus the gilde data
dir, git sha and host so arms are provably comparable. The harness's per-gezel
toolset override applies in both arms and the craftbook scenarios pin an
explicit assignee, so the campaign measures the mode mechanics with the same
worker; the Generalist persona itself is not exercised (a follow-up run drops
the explicit assignee). Craftbook cells run under `--repair-policy runtime`
unless told otherwise, so the harness's repair channel (sniff nudges in plain
sessions, missing-deliverable kicks, Developer recruitment, poisoned-session
recovery, plateau kills) never speaks during a cell; the progress watchdogs
still bound a hang, and the policy is stamped on every `result.json` and in
the summary meta. `--repair-policy harness` restores the standard
craftbook-matrix behaviour for a deliberate comparison with older runs. The
override applies to every scenario in the run; until 2026-09-18 it skipped
scenarios without a `repairPolicy` key of their own, so the first breadth
run's `schema-migration` and `craftbook-author-linear` cells ran with the
harness channel on (equally in both arms). Since 2026-09-19 the policy is
enforced inside the feedback posters themselves, so a hand-written scenario
that calls them directly is held too; gemma4-12b-q4's `schema-migration`
cells (both arms) still ran with the ladder active.

**Fanout attribution on CLI providers.** The two fanout probes attribute each
child's file to the child's own session through `tool.called` history, and
they looked for `write_file` by name. The Claude CLI provider does record its
tool uses, but under the CLI's own tool names (`Write`, `Read`, `Glob`),
because gezel-mcp's `write_file` is hidden from it as a duplicate; so Opus
finished `fanout-stories` in under two minutes with every check green and was
failed on five missing `write_file` receipts while five `Write` receipts sat
in the same history (2026-09-19). A first correction assumed CLI providers
wrote no tool history at all and changed nothing. The attribution now accepts
the provider's native file writers as well (`isWorkspaceWriteReceipt`), and a
project whose history holds no tool events at all (Copilot's SDK loop) is
reported as unobservable (`diagnostics.fanout.receiptsObservable: false`)
with the file, oracle and completion checks deciding. The host-writes check
stays blind on CLI providers, whose history carries argument names but not
paths. Opus fanout cells before this change are not quotable.

### Campaign runbook (this Mac, MLX, serial, A/B/A)

Preconditions: `pnpm build`; `qwen3.8-27b-q4` and `gemma4-12b-q4` installed
under `~/.gezel-dev/engines/mlx/models/`; `claude login` (or
`ANTHROPIC_API_KEY`) for the Opus arm; while the Generalist template is
unpublished, `export GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data` for every
arm (never `link:gilde` mid-campaign — the bin records which content root was
used). Only `failureClass: model` trials count toward pass rate; n=1 deltas are
leads, the smoke n=3 cells are quotable; compaction columns are `n/a` for the
CLI arm. Since 2026-09-19 the trial daemon runs with the night shift disabled:
runs 3-7 started at night and every cell also ran the bundled Meester
oversight task on the provider under test (§5).

1. Dry run (~3-4 h): `pnpm eval:ab-generalist --suite generalist-smoke --model qwen3.8-27b-q4 --count 1 --arms off,on --aba` (the 2026-09-18 first pass ran the craftbook cells under the harness policy and is not quotable for them; rerun after the service rebuild)
2. Breadth, local (~7-9 h each, one per day): `pnpm eval:ab-generalist --suite generalist --model qwen3.8-27b-q4 --count 1 --count-strict`, then `--model gemma4-12b-q4`
3. Cloud reference (overnight): `pnpm eval:ab-generalist --suite generalist --provider anthropic-cli --model opus --count 3 --arms on,off` (the CLI default is Sonnet; `opus` must be explicit; dot-form ids fail). Run the smoke suite once first: the 2026-09-19 probe found the CLI providers hiding the package-script runners every `commandEvidence` gate depends on (§5), so any CLI result on a suite-verifying book that predates the fix is not quotable.
4. Rates, local: `pnpm eval:ab-generalist --suite generalist-smoke --model qwen3.8-27b-q4,gemma4-12b-q4 --count 3 --count-strict` (~15 h, two nights)
5. Reports: `pnpm eval:postmortems <root>`, then `pnpm --filter @bendyline/gezel-evals run postmortems:enrich --out <root>/MATRIX-SUMMARY.md <root>/*/stepwise <root>/*/generalist` (absolute paths, no `--` separator: pnpm forwards it literally and the bin rejects it; the enricher keys rows on model plus arm, so both arms go in one call), then read the bin's `ab-summary.md` (the enricher, `pnpm --filter @bendyline/gezel-evals run compare:scores` and `tsx src/bin/perf-matrix.ts <root>` all key their rows by model plus arm, so an A/B root reads as two models); write one narrative postmortem per arm root citing `facts.continuity.*`, and append the readout to §7 below. Revisit the `auto` rule for local `medium` on that evidence.

## 7. Results

### Smoke, qwen3.8-27b-q4 on MLX, 2026-09-18 (run 3, root `evals/runs/ab-generalist-2026-09-18T18-52-17-313Z`)

The first quotable run: rebuilt dist with the stall-sweep guard and the
write-bail continuation, `--repair-policy runtime`, n=1 per cell plus an
A/B/A rerun of the first cell. Runs 1 and 2 of the same day are not quotable
(§5).

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-stories` | pass, 9m42s; A/B/A rerun pass, 14m13s | pass, 7m22s | Both arms: 5 children each wrote their story, barrier held, host collected after release, one write-bail continuation per child, no compaction at 4% fill. The stepwise/stepwise spread exceeds the arm delta, so wall-clock at n=1 is noise. |
| `craftbook-invoice-run` | fail, 100m (ceiling) | fail, 18m (no-progress) | Same failure in both arms on step `scope`: a `read_file` not-found loop, then a `write_task_note` repeat loop, three sends spent inside ten minutes. The wall-clock difference is a harness artefact (§5). |
| `craftbook-codemod-sweep` | fail, 22m (paused) | fail, 20m (paused) | Same failure in both arms on step `enumerate`: read/grep/stat loops against the step's own not-yet-written artifact, then the sweep's poisoned-stall pause. |

What it says so far: the generalist mechanics hold on the one scenario this
model can do (fanout integrity 5/5 in both arms, the owner pinned, children
inheriting the mode), and the two craftbook scenarios are a wash on this
model for one shared cause — the drawer-and-create confusion around
`tasks/<n>/` deliverables — which the fixes recorded at the end of §5 target.
### Craftbook rerun on the rebuilt dist, 2026-09-18 (run 4, root `evals/runs/ab-generalist-2026-09-18T22-15-05-399Z`)

Same two craftbook scenarios, both arms, with every fix of the day in the
dist (drawer hint on the first verdict, not-found corrective, exhaustion
pause).

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `craftbook-invoice-run` | fail, 6m (paused for help) | fail, 8m (paused for help) | Both arms: the first verdict now says `tasks/1/billables.json` lives in the artifacts drawer and must be created with `write_artifact`; the model answered with fifteen task notes describing files it never wrote. |
| `craftbook-codemod-sweep` | fail, 11m (paused for help) | fail, 14m (paused for help) | Both arms: `validate` on the step's own unwritten artifact fifteen times, through the new corrective naming the writer; the generalist owner also spent 31 calls on `save_memory`. |

What it says: on qwen3.8-27b-q4 these two books fail at their first
artifact-producing step in either mode, and after today's fixes the runtime
now says so within minutes and pauses for help instead of drifting for an
hour — a capability result for the model on these books, not a mode result.
One generalist-specific observation to carry forward: the union tool surface
hands a weak model more ways to spend a turn (31 `save_memory` calls in one
step); trimming ambient toolsets (memory, history, handboek) from the union on
local tiers is a candidate follow-up.

### Breadth, qwen3.8-27b-q4 on MLX, 2026-09-18/19 (run 5, root `evals/runs/ab-generalist-2026-09-18T22-55-02-914Z`)

The full `generalist` suite, n=1 per cell, `--count-strict`. Two caveats:
`schema-migration` and `craftbook-author-linear` ran with the harness channel
on in both arms (the override bug noted in §6), and the terminal-step
self-loop fix (§5) landed after this run.

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-tally` | pass, 19m | pass, 3m | 4 shards, total 635 correct in both arms. The stepwise host's extra nine minutes were the terminal-step self-loop (`next: merge`), not the mode. |
| `fanout-stories` | pass, 10m | pass, 8m | 5/5 both arms; fourth and fifth consecutive passes for this scenario. |
| `schema-migration` | pass, 6m | pass, 6m | All seven signals including a clean `tsc` in both arms. Corrected 2026-09-19: the scenario messages a pre-recruited Developer directly, so both arms ran the same plain chat with no task; `generalist-not-resolved` is expected because nothing was created. This pair says nothing about kickoff. |
| `craftbook-invoice-run` | fail, 4m | fail, 8m | Known: `scope` never writes its artifacts; paused for help. |
| `craftbook-author-linear` | fail, 56m | fail, 49m | Meester-driven authoring: the crew (and the solo Builder) wrote scripts but never invoked the authored book; 3/7 vs 4/7 signals; harness watchdogs ended both. |
| `craftbook-codemod-sweep` | fail, 6m | fail, 19m | Known: `enumerate` never writes its artifacts; paused for help. |
| `craftbook-refactor-module` | fail, 5m | fail, 6m | Same `tasks/<n>/baseline.md` pattern at the first step; the compaction stressor never got far enough to stress compaction. |

Totals: stepwise 3/7, generalist 3/7. Every pass is a fanout probe or the
plain-chat refactor and every failure is a book whose first step writes a
`tasks/<n>/` artifact, in both arms. On qwen3.8-27b-q4 the mode does not move pass rate;
the fanout cells suggest a wall-clock edge for the single owner (3m vs 19m,
8m vs 10m, 7m vs 10m earlier) that n=1 cannot separate from drift. No
compaction was observed anywhere (max fill 16%). Next: the same suite on
gemma4-12b-q4, then the Opus reference.

### Breadth, gemma4-12b-q4 on MLX, 2026-09-19 (run 6, root `evals/runs/ab-generalist-2026-09-19T02-23-16-337Z`)

Same suite, n=1, on the dist with the self-loop guard. The `schema-migration`
and `author-linear` cells ran with the harness ladder active in both arms
(the poster-level hold landed after this run); the dead-end and checkpoint
fixes found in these cells (§5) landed after it too.

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-tally` | fail, 9m | fail, 2m | Mechanics fine in both arms (4/4 children, host completed, no self-loop); three of four shard totals wrong in both arms — the 12B's arithmetic, which this oracle exists to catch. |
| `fanout-stories` | pass, 9m | pass, 5m | 5/5 both arms; six of six across both models. |
| `schema-migration` | pass, 8m | fail, 11m | The same pre-recruited Developer in both arms (corrected 2026-09-19: no kickoff is involved); the second run wrote tests that did not typecheck (`Cannot find name 'User'`) and the harness ladder ended it. Run-to-run variance of one model on one plain chat, not a mode result. |
| `craftbook-invoice-run` | fail, 43m | fail, 2m | Stepwise got further than any qwen cell: `scope` passed, three invoice children spawned — and each child re-ran its dead-end `draft-invoice` step forever (§5, fixed); the crew also created four stray tasks. Generalist: the owner wrote `scope.md` three times and never the checkpoint (§5, fixed), paused for help. |
| `craftbook-author-linear` | fail, 31m | fail, 15m | Both arms authored the book and invoked it TWICE (two active tasks each); the solo Builder's tasks reached step three of three before the ladder ended it. Duplicate invocation is the failure in both arms. |
| `craftbook-codemod-sweep` | fail, 3m | fail, 6m | `sites.md` written in both arms, gate not cleared, paused for help; the generalist owner also hit a prose-overrun abort. |
| `craftbook-refactor-module` | fail, 20m | fail, 4m | Paused on `baseline` in both arms after the handoff's bounded sends. |

Totals: stepwise 2/7, generalist 1/7. Compaction never triggered (max fill
9%). What gemma adds to the picture: it gets one step further into the
books than qwen3.8-27b-q4 does, which is what exposed the dead-end and
checkpoint defects. The `schema-migration` split was first read as evidence
against solo kickoff for this model; it is not, because that scenario never
involves the Meester or a kickoff (§6). The `auto` rule for local medium has
no data point from this campaign either way.

### Smoke probe, Claude Opus via anthropic-cli, 2026-09-19 (run 7, root `evals/runs/ab-generalist-2026-09-19T05-15-27-669Z`)

The first cloud pass, n=1 on the smoke suite, on the dist with all sixteen
local-run fixes. Its job was to validate the CLI path before the 42-cell
reference run, and it paid for itself: two of its three scenarios exposed
defects in the harness and the runtime rather than measuring the mode.

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-stories` | fail, 10m | fail, 2m | Functionally clean in both arms (5/5 children, host completed, barrier held) but booked as failures: the scenario attributed child writes through tool-call history, which CLI providers do not produce (§5, fixed). Not quotable; rerun. |
| `craftbook-invoice-run` | pass, 8m38s | pass, 3m21s | The first craftbook passes of the campaign. The generalist owner ran `scope`, `collect`, `evaluate` and `finish` in one session (continuity reuse logged three times), the fanout spawned three children and the barrier released on the last one. Stepwise took 2.6x the wall-clock for the same result. |
| `craftbook-codemod-sweep` | fail, 11m | fail, 11m | Both arms reached `verify` and were rejected for a missing `npm run test` receipt while the CLI provider hid the only runner that writes one (§5, fixed). The generalist owner recognised the trap and paused after one gate attempt; the stepwise developer asked the user and was told to proceed. Not a mode result. |

Totals as booked: stepwise 1/3, generalist 1/3. The one clean pair says the
generalist mechanics hold end to end on a frontier model at a fraction of the
stepwise wall-clock; everything else in this run is a defect it found. The
smoke suite is being rerun on the corrected dist before the reference run.

### Smoke rerun, Claude Opus via anthropic-cli, 2026-09-19 (run 8, root `evals/runs/ab-generalist-2026-09-19T06-08-45-754Z`)

Same three scenarios, n=1, on the dist with the CLI runner exposure and the
worker roster fix (§5). The fanout attribution fix landed in the evals
source after this process had started, so its fanout cells ran the old
receipt logic and are not quotable; the self-routing fix landed in the dist
after this run.

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-stories` | fail, 9m | fail, 2m | Clean in both arms (5/5 children, host completed, barrier held), booked as failures by the receipt logic this process was compiled with (§5). Not quotable. |
| `craftbook-invoice-run` | pass, 5m34s | pass, 4m01s | Second consecutive paired pass. Generalist: one session across `scope`, `collect`, `evaluate`, `finish`; three children; barrier released on the last. |
| `craftbook-codemod-sweep` | pass, 7m04s | fail, 8m40s | Both arms ran the suite through `run_package_script` and cleared the `verify` gate on receipts. The generalist owner completed the whole book in one session (review PASS, task complete) and failed two spec checks: `package.json` was never opened (harness rule, since fixed) and its DONE note did not name the literal test command (spec rule, §5). The stepwise crew's analyst opened the manifest and its project lead's note cited `node --test`. |

Totals as booked: stepwise 2/3, generalist 1/3. Quotable content: invoice-run
pass/pass with the generalist arm 1.4x faster, and codemod-sweep mechanically
complete in both arms once the runners were visible, with the split decided
by a spec rule the book never states. The oversight side task ran again in
every cell of this run (the night-shift switch landed after it).

### Reduced reference, Claude Opus via anthropic-cli, 2026-09-19 (run 9, root `evals/runs/ab-generalist-2026-09-19T12-37-57-361Z`)

The full `generalist` suite at n=1 (the user chose 14 cells over the
runbook's 42 because the account was near its weekly Claude limit), on the
dist with the runner exposure, the worker roster, the self-routing fix and
the night shift off, and with the corrected fanout attribution in the evals
source. Started at 12:38Z, finished at 15:12Z.

| Scenario | Stepwise | Generalist | Read-out |
|---|---|---|---|
| `fanout-tally` | pass, 8m56s | pass, 1m03s | Both arms correct (4/4 shards, total 635). The stepwise host waited eight minutes for the stall sweep after its crew finished (§5, fixed after this run); the generalist host resumed 3.9 s after the last child. |
| `fanout-stories` | pass, 10m26s | pass, 1m28s | Same shape: 5/5 stories in both arms, the stepwise host again rescued by the sweep. Receipts now attribute the Claude CLI's `Write` calls to the children. |
| `schema-migration` | fail, 16m46s | fail, 16m56s | Both arms wrote the identical, correct handlers file and were rejected by the same oracle check, then died of the no-progress watchdog because nothing relays a sniff verdict under the runtime policy (§5, oracle fixed). A wash, booked as infra by the failure-class rules. |
| `craftbook-invoice-run` | pass, 5m09s | pass, 3m41s | Third consecutive paired pass across runs 7, 8 and 9. |
| `craftbook-author-linear` | pass, 7m21s | pass, 6m04s | First passes of this scenario in the campaign: the Meester authored a gated three-step book, invoked it once, and the task ran to completion in both arms. |
| `craftbook-codemod-sweep` | pass, 10m05s | pass, 35m01s | Both arms passed every check, and the generalist arm graded its own sweep REVISE. The route to `repair` then stranded the owner for 22 minutes (§5, fixed after this run); the first four steps had taken five minutes in one session. |
| `craftbook-refactor-module` | pass, 16m00s | fail, 15m14s | 29 of 30 checks in the generalist arm, tests green, the last one the seeded-read rule, which did not know the artifact readers reroute to workspace files (§5, fixed). Functionally a pass. |

Totals as booked: stepwise 6/7, generalist 5/7. Read with the corrections
above, the arms are 6/6 each on the scenarios the oracle could judge, and
the generalist arm was faster on five of the six, by 1.2x to 8.5x, with the
fanout gaps inflated by the stepwise stall. The one slower generalist cell
is the reroute stall the run found. Everything the run exposed is a runtime
or harness defect, fixed and tested; no cell shows the generalist mechanics
failing on a frontier model. The n=3 rates run of the same suite waits for
the account's weekly reset, and the local-model rates run (runbook step 4)
is still to come.

---

## Appendix — original spec: frontier-adaptive execution (2026-07)

The design that preceded v2. Its "flat" density shipped as solo kickoff; its
collapse renderer for pinned craftbooks was never built and is superseded by
the contract above (steps and gates kept, one session, union tools).

## 0. Motivation and design rationale

Self-orchestrating providers bring their own read/edit/verify loop: codex runs that loop inside
one CLI invocation, while Copilot does so inside its SDK. Wrapping every such invocation in a
full `meester → klerk → specialist` relay can duplicate orchestration that the provider already
supplies. Raw local providers do not bring that loop, so the gezel scaffold remains
load-bearing for them.

Objective gates remain valuable at either density: they define the quality floor independently
of whether a task is executed by one Builder or a larger crew.

**Thesis:** scaffold density should be **elastic**, scaled to the provider's self-orchestration and the task size — not a binary "frontier mode." Frontier/agentic providers need the **quality bar** (gates), not the **team relay** or the **step-by-step recipe**. Keep one task model across the whole capability range so a task stays portable (same definition runs on a 2B local model and on Sonnet).

## 1. Core concept — one task model, two renderings

A task is invariantly `{ goal/end-state, deliverables, acceptance criteria → gates }`. The same task definition renders at two **execution densities**:

| Density | Who executes | Craftbook shape | For |
|---|---|---|---|
| **scaffold** (today) | `meester → voorman → specialists` | granular per-step recipe, per-step gates | raw-completion local models (the loop *is* the agent) |
| **flat** (new) | a single **Builder** | collapsed: goal + unioned criteria + **gates at end**, procedure demoted to advisory | self-orchestrating / frontier providers |

**Gates are the invariant floor across both densities.** Density is chosen by `orchestrationClass(provider) × taskSize`; it never changes *what* "done" means, only *how* the work is staffed and sequenced.

## 2. The decision function — `executionDensity(provider, task)`

Add a small classifier (new shared helper; service currently categorizes by name at `chat/manager.ts:5887`):

```
orchestrationClass(providerName):
  'self-orchestrating'  // brings its own agent loop: codex-cli, anthropic-cli, copilot
  'raw-strong'          // strong, but no built-in loop: anthropic, openai (cloud SDK)
  'raw'                 // no loop, weaker: llama-cpp, mlx (local engines)
```

```
executionDensity(provider, task, config):
  if config.executionDensity != 'auto': return config.executionDensity   // escape hatch / A/B
  cls = orchestrationClass(provider)
  if cls == 'self-orchestrating': return taskFitsOneContext(task) ? 'flat' : 'flat-phased'
  if cls == 'raw-strong':         return taskFitsOneContext(task) ? 'flat' : 'scaffold'
  return 'scaffold'
```

- `flat-phased` = collapse to a *few coarse phases* rather than one step (the collapse spectrum, §4).
- `taskFitsOneContext(task)` heuristic: deliverable count + estimated bytes + craftbook step count under a threshold. Conservative default; large/multi-file projects stay phased even for frontier.
- Config: `executionDensity: 'auto' | 'flat' | 'flat-phased' | 'scaffold'` at **global** and **per-project** scope, plus a **per-task** override. `auto` is the default and the only one that consults the classifier.

**Where:** the classifier belongs in `@bendyline/gezel` (core) so the eval harness and runtime share one definition (mirrors how `categorizeProvider` lives in `evals/src/providers.ts` today — unify them).

## 3. Component A — the Builder (flat team)

**What:** a single generalist gezel owns a task end-to-end (plan → execute → self-verify), with the full tool surface, replacing `meester → voorman → specialists`. It uses the existing solo project storage mode internally, selected by `start_project` from the effective execution density rather than by a model-facing “job” type.

**Integration points:**
- `gezels/roster.ts` `deriveGezelRoster:30` — when density is flat, return a single **Builder** instead of a derived crew.
- `gezels/roster.ts` `pickRosterVoorman:115` — short-circuit (no voorman in flat mode).
- `gezels/ensure.ts` `resolveGildeTemplateForRole:171` — resolve the `builder` template.
- Builder role template `<gilde>/data/gezel-templates/bu/builder/` (bendyline/gilde repo) — about.md: a generalist who owns the whole task, plans briefly, executes, and **runs/verifies before declaring done**. All tools in schema.
- The **meester** layer stays only as a *thin* multi-task scheduler/coordinator (or is skipped entirely for solo projects); it assigns the task to the Builder rather than recruiting a crew.

**Design constraints:**
1. **Per-task bounded context + project memory** — do NOT run one infinite per-project conversation (it will blow the window on long projects). Each task gets a fresh Builder context; cross-task continuity comes from project memory/summary (existing `memory/` machinery).
2. **Second-perspective safety** — a single executor reviewing its own work has the self-review blind spot. Offset with (a) the objective **gates** (already impartial) and (b) an optional final **fresh-context skeptical self-review** turn — not a per-step Reviewer role.
3. **Team escalation exceptions** — even in flat mode, spawn a team when there is genuine **parallelism** (independent workstreams → concurrency + separate contexts) or a genuine **tool/permission boundary**. Default flat; escalate on those signals only.
4. **Tool surface** — broad by default (frontier models handle large schemas); scope by task type only if tool-selection noise is observed.

## 4. Component B — Craftbook collapse (outcome rendering)

**What:** render a granular (local-authored) craftbook into a collapsed form for flat density. Source of truth is unchanged — **craftbooks are still authored granularly, assuming local models.** The collapse is a render-time transform.

**The transform** `collapseCraftbook(book, density) → TaskCraftbookStep[]`:
- **end-state**: from the book's explicit end-state / acceptance-criteria block (see §4.1).
- **criteria**: the union of all steps' acceptance criteria.
- **gates**: the union of all steps' `gate.checks` → attached to the collapsed step's **completion** gate (run once at the end). On reject, hand back the **full** failed-criteria list at once (frontier models fix a batch in one pass — preserves "one fix-pass").
- **procedure**: the per-step `prompt`s concatenated into a single **"Recommended approach (advisory)"** block — sequencing wisdom ("write characterization tests *before* refactoring", "lock the schema *before* the pipeline") is **preserved as guidance, not enforced as steps.** Demote, don't delete.
- **suggestedRole**: `builder`.

**Integration point:** `tasks/manager.ts:~94-143`, where `book.steps` is mapped into the task's `craftbook.steps`. Apply `collapseCraftbook` before materialization when density ≠ scaffold.

**Collapse spectrum (`flat` vs `flat-phased`):**
- `flat` → one collapsed step (bounded task).
- `flat-phased` → group the book's steps into a few coarse phases (e.g., {design, build, verify}) with a gate per phase — checkpoints to bound context and catch a wrong direction early on large work. Heuristic on step count / deliverable size.

### 4.1 New authoring requirement — explicit end-state block

Collapse is only faithful if the book declares its goal + acceptance criteria explicitly rather than only implicitly through steps. Most books already carry a "numbered acceptance-criteria checklist of 5–9 items" in the plan step — formalize it:
- Add `endState` / `acceptanceCriteria` to the craftbook manifest schema (`core/src/schemas/craftbook.ts`).
- Add a **lint** (`packages/catalog` `lint-manifests`) requiring every book to declare it.
- `collapseCraftbook` reads that block + the union of step gates.

## 5. Component C — Gates stay universal (near-zero change)

No change to the gate engine (`tasks/gate-eval.ts`, `tasks/step-gate.ts`, `tasks/manager.ts` completion-gate at `:1122-1488`). The only adaptation is that in flat mode the collapsed step's completion gate is the **union** of the source steps' gates, evaluated once at the end. `maxAttempts` and pause-for-help behavior unchanged. This is the cheap-local-compute floor that stays on for every provider and remains load-bearing for local execution.

## 6. Component D — Provider-class-aware progress tolerance ✅ DONE (eval harness)

Self-orchestrating providers emit gezel-visible "turns" infrequently (one long CLI/SDK invocation
can represent an entire work loop), so watchdogs tuned for chatty local cadence need a
provider-aware silence window.

**Implemented (eval harness):**
- `isSelfOrchestratingProvider(p)` in `evals/src/providers.ts` — codex-cli / anthropic-cli / copilot (a finer cut than `categorizeProvider`: copilot is `cloud-sdk` but self-orchestrates; raw `anthropic`/`openai` do not).
- `defaultSoftProgressTimeoutMsForModel` in `evals/src/runner.ts` now floors the **silence** window at **20 min** for self-orchestrating providers (`SELF_ORCHESTRATING_MIN_SOFT_PROGRESS_MS`), on top of the existing size-based + MLX×2 logic. The 45-min HARD progress watchdog (real product progress) stays the true backstop. Tests in `providers.test.ts` + `runner.test.ts`.
- The **daemon spawn timeout** was already 120s + a one-shot batch retry (`runner.ts:417-422`, `runTrialWithSpawnRetry`) — the copilot spawn-timeout artifact is already covered.

Deferred (lower priority): the *runtime* chat-stall watchdog (if any) should get the same class-aware treatment; and the proper long-term fix is a **streaming-aware** watchdog that doesn't fire while the provider reports active token decode.

## 7. The A/B validation (do this before/with rollout)

- Eval flag `--render-mode flat|flat-phased|scaffold|auto` → sets `executionDensity` for the trial.
- **Instrument: codex-cli** (partial tool-call diagnosability — tc 1–26 visible — vs copilot's opaque built-ins).
- Run a representative subset (e.g. `tictactoe, data-wrangle, bookstore-openapi, codebase-evolution, squisq-review, refactor-style`) **flat vs scaffold**, count ≥3 each.
- **Compare:** pass rate (hypothesis: equal), gezels/turns/tokens (hypothesis: large reduction), and **quality on sequencing-sensitive scenarios** (refactor / test-first) — the place where demoting procedure could regress.
- **Success criteria:** flat matches scaffold pass rate at materially fewer gezels/turns/tokens, with no quality regression on the sequencing-sensitive set.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Self-review blind spot (Builder reviews own work) | Objective gates + optional fresh-context skeptical review turn |
| Context-window blowout on long projects | Per-task bounded context + project memory (not one infinite thread) |
| Lost sequencing wisdom (collapse drops "test-first") | Demote procedure to *advisory*, don't delete |
| Tool-schema bloat (all tools) | Broad default; scope by task type only if selection degrades |
| Portability / local fallback | Collapse is a render-time transform; granular source retained → a flat task still falls back to scaffold for local models |
| Collapse infidelity | Mandatory explicit end-state block + lint (§4.1) |
| Over-collapsing large work | `flat-phased` spectrum (coarse phases, not always one step) |
| Losing parallelism on big projects | Team-escalation exception (§3.3) |

## 9. Rollout plan (phased, each independently shippable)

- **Phase 0 — plumbing (no behavior change at default):** `orchestrationClass` + `executionDensity` config + `--render-mode` eval flag. Unify with the eval's `categorizeProvider`.
- **Phase 1 — collapse renderer:** `collapseCraftbook` + mandatory end-state block + lint, gated behind `--render-mode flat`. A/B it (§7).
- **Phase 2 — Builder:** role template + flat `deriveGezelRoster` + thin/skipped meester. A/B it.
- **Phase 3 — progress tolerance** (§6).
- **Phase 4 — enable `auto` by default** for self-orchestrating providers; monitor pass rate + cost (tokens/turns/quota) on the next frontier matrix.

## 10. Open questions

1. Exact home for `orchestrationClass` (core, shared with eval) and how `raw-strong` cloud SDKs (anthropic/openai direct — strong but no built-in loop) should render: flat team but gezel still provides the turn loop. Confirm classification.
2. `taskFitsOneContext` heuristic — what inputs (deliverable count/bytes, book step count, model context window) and thresholds?
3. Project-memory strategy for the per-task Builder (what carries across tasks, how summarized).
4. Should `flat-phased` reuse the existing phase machinery or a lighter grouping?
5. Does removing the per-step Reviewer measurably lower quality on subjective deliverables? (the A/B's quality check should answer this).

## Appendix — file / integration map

| Concern | File(s) |
|---|---|
| Provider classifier | new in `packages/core/src` (unify with `evals/src/providers.ts` `categorizeProvider`); service categorizes by name at `chat/manager.ts:5887` |
| Execution-density config | `core` config schema; consumed in `gezels/roster.ts` + `tasks/manager.ts` |
| Builder roster | `gezels/roster.ts` `deriveGezelRoster:30`, `pickRosterVoorman:115`; `gezels/ensure.ts` `resolveGildeTemplateForRole:171`; template `<gilde>/data/gezel-templates/bu/builder/` |
| Craftbook collapse | `tasks/manager.ts:~94-143` (materialization); new `collapseCraftbook`; manifest `endState` in `core/src/schemas/craftbook.ts`; lint in `catalog` |
| Gates (union at collapse) | unchanged engine (`tasks/gate-eval.ts`, `tasks/step-gate.ts`, `tasks/manager.ts:1122-1488`); union built in `collapseCraftbook` |
| Progress tolerance | `evals/src/runner.ts` (soft-progress, generalize MLX "T2"); runtime stall watchdog |
| A/B harness | `evals/src/bin` + `evals/src/runner.ts` (`--render-mode`) |
