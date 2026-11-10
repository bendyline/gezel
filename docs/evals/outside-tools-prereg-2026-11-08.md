# Gezel against pi on the same local model (2026-11-08)

*A copy of `evals/runs/pi-compare-2026-11-08/PREREG.md`, unchanged. That file is the record.*

Written before any pi trial ran.

**Question.** What does Gezel's runtime add over an outside agent tool running the
same local model? Round 2 measured Gezel without the contract (the `harness` arm);
this measures pi (pi.dev, `@earendil-works/pi-coding-agent` 1.4.0) with none of
Gezel's prompts, tools, gates or recovery.

**Arms** (`evals/src/strategy/books.ts`):

- `outcome-bare`: the shipped default for these models (outcome, no recipe, contract enforced). Control.
- `harness`: Gezel with only the request (no recipe, contract hidden, nothing checked).
- `pi`: pi in the seeded folder, on the same model through the trial daemon's `/v1`,
  described to pi as Gezel's own pi setup does (`buildRoster`). Pi gets the same
  request text as the Gezel arms, verbatim, and the project's about text as an
  appended system prompt (Gezel injects it as "About this project"). Its default
  tools (read, bash, edit, write), no extensions, skills or MCP. It runs inside
  bubblewrap: read-only filesystem, home folders hidden, only the workspace and
  pi's state writable, network shared for loopback. The gezel task is still
  created, assigned to the person and never dispatched, so its contract snapshot
  grades the folder like every other arm. A deliverable the contract keeps in the
  artifacts drawer is copied from the folder at the same path when pi exits.
  The trial ends when pi exits, or at the time cap.

**Models:** Qwen 3.5 9B (45-minute cap) and Qwen 3.8 27B (60 minutes).

**Books.** Leg A: the scorecard's five file-based books (engineering-retrospective,
refactor-module, cohort-analysis, runbook, invoice-run); powerpoint-deck needs
Gezel's document tools and is left out. Leg B, after A: bug-fix-tdd and
codemod-sweep. Two replicates per cell, arm order rotated.

**Catalog and build.** Round 3's catalog (`round3-2026-11-06/gilde-drafted/data`,
gilde a4189acf1 plus drafts), gezel 0ecb986c, native 0.1.62.

**Endpoints.** P1, P2, P3 as in the strategy pre-registration, plus:

- **P1-result.** Pi leaves no Gezel tool records, so a criterion checked by
  `commandEvidence` (the code books' `suite-green`) can never pass for it. P1-result
  replaces that check, in every arm, with the project's own tests run on the final
  folder. P1-result is the fair comparison; P1 is reported as registered.
- Wall time, turns and tool calls (pi from its event stream).

**Reading.** Descriptive: paired deltas against `outcome-bare` per model with
book-cluster bootstrap intervals, and P1/P1-result counts. This informs positioning
and the docs, not `auto`.

## Amendment, 2026-11-08 (after the main run, before the `pi-book` trials)

**A grading defect, re-judged.** One scenario object serves every arm of a book,
and the drop of Gezel's task-graph check rode its once-per-scenario contract
scoping, so it held only when pi happened to run first. 16 of the 28 pi trials
(engineering-retrospective, refactor-module, bug-fix-tdd and codemod-sweep, where
pi never ran first) were judged on a task graph pi never touches, and their test
count included two task-graph requirements as passes. Pi's files are not affected:
it runs once and exits, and the check never nudges it. Those trials are re-judged
from their recorded verdicts (`analyze.mts`, audit in `task-graph-regrade.json`);
`scenario.ts` now applies the drop per trial.

**An information gap, measured.** Both Gezel arms' kickoff carries the craftbook's
description (`renderEntryPreface`). For the gallery books that description outlines
the recipe's phases, file paths and formats (invoice-run: "each child writes
invoices/{number}.html"), so `procedure: none` is not recipe-free and pi had less
to go on than either Gezel arm. A fourth arm, `pi-book`, gives pi that description
verbatim in its system prompt. Same models, books, caps and two replicates, run
after the main legs. It separates what pi lacks in information from what it lacks
in runtime. Read descriptively against `outcome-bare`, `harness` and `pi`.

## Amendment 2, 2026-11-09 (before any OpenCode or Sonnet trial counted here)

A single OpenCode smoke trial (9B, runbook, `smoke-opencode/`) checked the
plumbing and is not counted.

**OpenCode arms.** `opencode` and `opencode-book` mirror `pi` and `pi-book` with
OpenCode 1.19.4 (`opencode-ai`, released 2026-10-22). They take the product path
end to end: the trial daemon's own OpenCode setup (`PUT /api/opencode-setup`)
writes the managed `opencode.json` and starts the OpenCode bridge, and OpenCode
runs on that file (`OPENCODE_CONFIG=…`, `opencode run --format json --auto --pure`).
It gets the request verbatim, and the about text (plus, on `-book`, the craftbook
description) as an instruction file, the same appendix pi gets. Same sandbox as
pi. Three settings differ from a person's own OpenCode, each so no arm differs in
reach: web tools are denied (pi has none, Gezel's trial homes have none); LSP
downloads are off (a fresh trial would fetch language servers from npm); ripgrep is
supplied on PATH (OpenCode's grep and glob need it and its first-use download does
not complete in the sandbox; we supply the ripgrep 15.0.0 that ships with VS Code,
where OpenCode would fetch 15.1.0). `--auto` approves every permission not denied,
as pi asks for none. Same books, models, caps, replicates and endpoints as pi.

**Sonnet 5.5.** The same seven books, two replicates, 45-minute cap, on
`claude-sonnet-5-5`. Arms: `stepwise`, `generalist`, `outcome`, `outcome-bare`,
`harness`, `pi`, `pi-book`, `opencode`, `opencode-book`.

- Gezel runs Sonnet through its `anthropic` provider (the Messages API, Gezel's
  own tool loop), with the model's catalog tuning.
- Pi and OpenCode each run Sonnet through their own built-in Anthropic provider
  with the same API key, so nothing of Gezel sits in their path. Each uses its own
  defaults for the model (thinking or effort level included); those are recorded,
  not equalized, because they are what a person using the tool gets.
- Control: `generalist`, which `auto` resolves to for hosted frontier providers
  today. Seven books are too few for the registered decision rule, so the Sonnet
  readout is descriptive: it can motivate a larger frontier run, not change `auto`.
- Judge: unchanged (Opus 5.5 via the CLI). It is the same model family as Sonnet,
  so comparisons between Sonnet arms are sound but a Sonnet-versus-Qwen level
  comparison may carry self-preference; the report says so.
- Two Sonnet smoke trials measure cost first; if the projected cost is far above
  the owner's expectation the run waits for the owner. Smoke trials are not counted.

*Note, 2026-11-09 07:34 UTC.* The Sonnet leg first ran serially; after two
trials (about 4.5 minutes each, so about 9.5 hours in all) it was stopped and
relaunched as three parallel processes of three arms each (stepwise,
generalist, outcome / outcome-bare, harness, pi / pi-book, opencode,
opencode-book), the same books, replicates and caps. The serial run's trials
are kept in `superseded-sonnet-serial/` and not counted. Parallel cloud trials
share this machine's CPU but not its GPU; the local OpenCode legs run beside
them, so their wall times are checked against decode speed before comparing
them with pi's.

*Note, 2026-11-09, a harness race.* The live check read "is the outside tool
still running?" twice per pass: while listing failures and again when deciding
the trial was over. A tool that exited between the two reads ended its trial
failed with "<tool> has not finished" beside complete work. One Sonnet pi
trial (runbook) failed this way; as of this note none of the other 135
outside-tool trials had. `scenario.ts` now reads it once per pass (regression
test in `scenario.test.ts`); the legs already running keep the old code, so
the analysis (`grade-lib.mts` `correctExitRace`) removes that one message for
any trial whose tool log shows it exited, and records each correction in
`report-2026-11/corrections.json`.

*Note, 2026-11-09, a sandbox gap.* The sandbox hid every home folder but left
the system Gezel install readable: `/var/lib/gezel/service` holds the full
catalog, every book's `test.json` included (its parent is not listable, so it
is reachable only by exact path), and `/opt/Gezel` the app. Told by a book
description about Gezel's "artifacts drawer", a 27B OpenCode trial went
grepping `/opt/Gezel`. An audit of every outside-tool trial's tool calls and
outputs found none that received catalog or grading content. Both sandboxes
now hide `/opt/Gezel` and `/var/lib/gezel` (`hiddenPathArgs`); the 27B
OpenCode leg already running keeps the old sandbox, and the audit is repeated
over every trial before the analysis. A trial that read grading content would
be excluded and rerun.

## Amendment 3 (2026-11-09, before any rerun trial): outside tools rerun with a neutral project description

**What went wrong.** The eval harness appends "Eval harness rules" to every
project's description (`craftbookEvalProjectAbout`). The rules list the seeded
inputs and the required deliverables, and they are written for Gezel: read
inputs "with the workspace `read_file` tool", write artifact deliverables "with
`write_artifact` / `read_artifact`; workspace copies ... do not satisfy them",
and "declared artifact outputs live in the project artifacts drawer". Pi and
OpenCode received that description verbatim as "About this project". It named
tools they do not have and a drawer they cannot reach. Found while auditing the
27B OpenCode leg: a plain OpenCode trial wrote "The instructions reference
`write_artifact`/`read_artifact` tools that aren't in my function list" and
spent its time searching the machine for the drawer. On codemod-sweep the rules
also ask for four drawer notes files (`sites.md`, `change-notes.md`,
`verification.md`, `review.md`) that the contract does not grade. Outside tools
wrote them into the repo, and the book's sweep verifier then failed the trial
because those notes mention the old name (27B OpenCode, 9B pi-book). The
defect works against the outside tools only. Gezel arms read the same text in
their own vocabulary.

**Change.** Outside tools now get `outsideToolProjectAbout`. It carries the
project's own description and the same eval facts (the inputs; every required
workspace deliverable; each drawer deliverable the contract grades, asked for
at the same path in the folder, where `deliverDrawerDeliverables` already picks
it up), with no Gezel tool names and no drawer. Drawer files the contract does
not grade are recipe records that Gezel keeps outside the folder. They are left
out, because an outside tool has nowhere outside the folder to put them. The
outside tools also get the project's mission objectives, as their own section
(`piPromptAppendix`). Gezel injects them into every session in the project, and
four of the seven books have them (engineering-retrospective, cohort-analysis,
runbook, invoice-run); the first run left them out, a second gap in Gezel's
favor. The harness's own mission lines about invoking craftbooks and creating
tasks are Gezel-specific and are not passed. The
person's request is unchanged and identical in every arm. Four of the seven
requests still say "Use the <name> craftbook for this"; the `-book` arms are the
comparison that resolves that reference.

**Rerun.** Every outside-tool arm (`pi`, `pi-book`, `opencode`, `opencode-book`)
on Qwen 3.5 9B, Qwen 3.8 27B and Sonnet 5.5, the same seven books, two
replicates, the same caps (45, 60 and 45 minutes), into `trials-v2/`. The Gezel
arms are not rerun: the text was native to them. The analysis pairs the rerun
outside-tool trials with the existing Gezel trials (linked into `trials-v2/`).
The first outside-tool trials stay in `trials/`, are reported as superseded with
their pass counts, and are not pooled with the rerun. The audit of outside reads
runs over the rerun before the analysis.

*Note, 2026-11-09 11:50 UTC.* The rerun first started without the mission
objectives. It was stopped after about 20 minutes, when the gap was found, and
restarted from scratch. Its 11 started trials (8 finished) are kept in
`superseded-v2-restart/`; none was graded or judged, and none is counted.

*Note, 2026-11-09 18:33 UTC, before any rerun result was graded.* The rerun
finished (168 outside-tool trials: 56 per model). The audit of outside reads
over all of them (`report-2026-11/audit-outside-reads.py`, output
`audit-outside-reads-trials-v2.json`) found 13 trials that searched outside
their workspace and none that received catalog or grading content, so no
trial is excluded.
