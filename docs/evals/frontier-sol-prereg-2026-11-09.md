# Task strategy on a second frontier model: GPT-6.1 Sol through Codex CLI (2026-11-09)

*A copy of `evals/runs/frontier-sol-2026-11-09/PREREG.md`, unchanged. That file is the record.*

Written before any trial of this run.

**Question.** Does the Sonnet 5.5 result (`frontier-2026-11-09`) hold on a
frontier model from another maker? There, "recipe as advice" (`outcome`)
qualified to replace "one owner, whole recipe" (`generalist`, today's `auto`
choice for hosted frontier providers), and "goal only" (`outcome-bare`)
missed only the pass-rate condition. That pre-registration required at least
one more frontier model before the default for every hosted frontier model
changes. This is that model.

**Model and provider.** `gpt-6.1-sol`, Gezel's default Codex model, through
Gezel's `codex-cli` provider (Codex CLI 0.167.0, signed in with a ChatGPT
account). Gezel pins no reasoning effort, so Codex uses the model's own
default (low). This is how Gezel runs Sol for a person today.

Two things differ from the Sonnet run, and both are part of what is
measured, not controlled away:

- Codex runs its own tool loop with its own shell and file editing, beside
  Gezel's MCP tools. Gezel hides the gezel-mcp tools that duplicate Codex
  built-ins (file writes, deletes, web, script execution) and keeps the
  scoped readers and the receipt-writing script runners. Sonnet ran through
  the `anthropic` provider, Gezel's own tool loop.
- Sonnet ran at Gezel's default effort for it (high); Sol at its default
  (low).

So the result applies to Sol through Codex CLI, not to Sol through the
OpenAI API.

**Arms** (`evals/src/strategy/books.ts`), as in the Sonnet run:

- `generalist`: control, today's default for this model.
- `outcome`: goal, recipe as advice (contract enforced, recipe shown as optional).
- `outcome-bare`: goal only (contract enforced, no recipe).

**Books, groups, replicates.** All 18 strategy benchmark books, three
replicates per cell, 162 trials. Arm order rotates by replicate and book
(`armOrder`). Three processes run side by side, with the Sonnet run's
groups:

- A: research-report, powerpoint-deck, bug-fix-tdd, ab-test-readout, alert-rules, invoice-run
- B: corpus-synthesis, market-scan, refactor-module, cohort-analysis, runbook, html-arcade-game
- C: content-accuracy-review, engineering-retrospective, codemod-sweep, data-quality-audit, csv-transformer, press-release

**Build and catalog.** The Sonnet run's: Gezel at `c9ce13ed` with the same
built output (service dist 2026-11-09 13:51 local), and round 3's catalog
(`round3-2026-11-06/gilde-drafted/data`). Time cap 45 minutes per trial.

**Smoke, not counted.** Three books (research-report, bug-fix-tdd,
invoice-run) once in each arm, nine trials, to catch plumbing faults and to
measure plan usage. A fault found there is fixed before the counted run and
recorded here. Its results are not analyzed.

**Endpoints.** As in the Sonnet run: P1 (primary binary), P1-result beside
it, P2 (criteria met), P3 (Opus 5.5 judge v3, three samples, blinded,
sources attached), wall time, and cost per task. Cost is what the same tokens
would cost on OpenAI's API at its list price for `gpt-6.1-sol`
(developers.openai.com, read 2026-11-09): $2.00 per million input tokens,
$0.10 cached input, $10.00 output, $2.50 cache writes. Gezel records
uncached input, cached input and output; uncached input is priced at $2.00.
The run itself is billed to a ChatGPT plan, not per token.

**Judge validity.** The grade pass runs `--judge-validity`. Test-retest SD
must stay at or under 0.7, the judge must catch at least 90% of planted
defects, and, since neither judge (Opus 5.5, second judge Sonnet 5.5) is
from Sol's maker, inter-judge alpha must reach 0.6. If any fails, P3 is
reported descriptively and the decision rests on the other conditions. The
judge is an Anthropic model; it judged Sonnet's work too, so quality
comparisons between the two runs are descriptive only.

**Decision rule** (the registered rule, generalist as control). A candidate
qualifies to replace generalist for this model if all of these hold:

- P2 delta lower bound above −0.05;
- P3 delta lower bound above −0.5;
- pooled P1 rate delta lower bound above −10 points;
- median wall-time ratio at or under 1.0 (or 1.25 if significantly better);
- no failure mode in two or more of its trials that never occurs in the control's.

If both candidates qualify, the cheaper by median cost per task wins, unless
their P3 difference has an interval that excludes zero. If neither
qualifies, generalist stays.

**Checks.** The primary analysis grades with round 3's checks unchanged, as
the Sonnet run did, so the two runs compare. The benchmark report lists
seven of those checks as misreading correct work. Their corrected versions,
and the rule for re-grading with them, are frozen in a note below before the
counted run starts. That re-grading is the registered secondary analysis.
If the two disagree, both are reported and the primary stands.

**Scope of the decision.** A qualifying result sets Sol's measured strategy
through Codex CLI. Cloud models have no Gilde catalog entry, so a hosted
model's measured strategy is recorded in Gezel (`task-strategy.ts`), keyed
by provider and model. If `outcome` qualifies here as it did for Sonnet,
both frontier models measured agree, which is the condition the Sonnet
pre-registration set before the hosted-frontier default can change. That
change is the owner's decision, made separately.

**Analysis.** Pairs are (book, replicate), 54 per comparison. Intervals are
95% percentile bootstraps resampling books; P1 uses exact McNemar on
discordant pairs, Holm-adjusted over the two candidates. Per-book and
per-kind figures are descriptive.

**Exclusions.** An infrastructure failure (an outage or overload error the
provider reports, a ChatGPT plan usage limit, the trial daemon failing to
start) is rerun once, then dropped and reported. Timeouts and anything the
model does count as failures.

**Plan usage.** The account's weekly Codex window was 9% used at 02:20 UTC on
2026-11-10 and resets on 2026-11-15. If the smoke or the first replicate
projects the run past 70% of the window, the run pauses for the owner. That
check reads usage only, never outcomes.

*Note, 2026-11-10 02:42 UTC, before the counted run.* **The smoke found one
plumbing fault, now fixed.** Gezel hides its own file and shell tools from
Codex (`write_file`, `rename`, `run_nodejs_script` and others) because Codex
has its own, but nothing told the model so. Where a step's procedure says to
add a test with `write_file`, Sol reported the tool missing and stopped: the
bug-fix-tdd generalist trial paused itself at its first step after four
rejections, and one invoice-run sub-task ended its turn "blocked", leaving
its parent waiting (that trial was stopped at about twelve minutes instead of
running to the cap, so invoice-run's goal-based arms never ran). The arms
that see the recipe read those procedures and goal only does not, so the
fault would have biased the comparison against the control. The fix is in
the Codex tool guide (`packages/service/src/providers/codex-cli/tool-guide.ts`):
a session that may edit is told that this work goes to Codex's built-in file
editing, shell and web search, and that `run_package_script` and `run_npx`
stay because the step checks read their run records. It affects Codex
sessions only; the Sonnet run never used this provider. The service was
rebuilt with it (dist 2026-11-09 18:32 local; the source diff against
`c9ce13ed` is `build-diff.patch`, hash `d3b48d48f3518ac6` in
`provenance.txt`). A second smoke on the fixed build (`smoke2/`: bug-fix-tdd generalist,
invoice-run in all three arms) ran without a plumbing fault. Neither smoke is
analyzed.

A second product issue the smoke showed, not fixed here: a fan-out sub-task
that ends its turn reporting a blocker, without pausing, stays active, and
its parent waits for it until the time cap.

**Plan usage.** 9% before the smokes, 10% after both (seventeen trials),
which projects the run to roughly 30% of the weekly window, under the 70%
pause line.

**The registered secondary analysis, frozen.** The corrected checks are
version 1.0.6 of runbook, data-quality-audit, corpus-synthesis, market-scan
and cohort-analysis in the Gilde checkout (not yet published), whose only
changes from 1.0.5 are the corrected patterns. `corrected-checks.mts` reads
both versions, finds the changed checks, and counts a failed trial as a pass
when everything that failed it is one of those checks and its deliverable
passes the corrected version. Run on the Sonnet trials before any counted
Sol trial, it reproduces the hand-checked reading in that run's Result
exactly (54, 54 and 53 of 54). Checksums (sha256):

```
734d856827ae9fa0ea62544e7f7bf1f06d7a6f24625880d2cc68261869acf311  gilde/data/craftbook-templates/ru/runbook/versions/1.0.6/craftbook.json
1de29fcc86e388b850ec4ac5d7c70240a1281e1291e9f026268e6022c6c889a5  gilde/data/craftbook-templates/ru/runbook/versions/1.0.6/test.json
fef07006284200b3da535ed0087685467f83ecf3253ded42c33c4ac5be888806  gilde/data/craftbook-templates/da/data-quality-audit/versions/1.0.6/craftbook.json
2079c3f489febd56b7d24919fba450d14d14e6fcf6a8fb8f6c2f6f5005a390bd  gilde/data/craftbook-templates/da/data-quality-audit/versions/1.0.6/test.json
7944a6b1c13e78ee7d63fb199c667bd77b6ed8fa3eb5a9a064ad8dd1d6ae42c3  gilde/data/craftbook-templates/co/corpus-synthesis/versions/1.0.6/craftbook.json
e39a2249681e93599eafaf83b5122221300d4e75513dce70f5c39b29ab00d633  gilde/data/craftbook-templates/co/corpus-synthesis/versions/1.0.6/test.json
cee310abcce6324bdfdadd31affe1477a05f5d362ecbfe385f04655affe475b3  gilde/data/craftbook-templates/ma/market-scan/versions/1.0.6/craftbook.json
ff54a22e8abd7a06c4c10f0cd4da07aaeec3dfd350f94f6749dd0742ea6e7191  gilde/data/craftbook-templates/ma/market-scan/versions/1.0.6/test.json
7fda680bd291ff2aea9ebfad4fe102a3523513648712e947f788d514b33a5038  gilde/data/craftbook-templates/co/cohort-analysis/versions/1.0.6/craftbook.json
6a40dc681ecb11a9f0110ab73c32382c15051ae7a8c5c766f3223a224144b474  gilde/data/craftbook-templates/co/cohort-analysis/versions/1.0.6/test.json
4673d4390d0dfd022a39bec1337d59e48f51541badb3de4215aa083b34cb2310  evals/runs/frontier-sol-2026-11-09/corrected-checks.mts
```

*Note, 2026-11-10 03:21 UTC, plan usage.* After the first replicate (55
trials) the weekly window was 12% used, up from 10% at the start, which
projects the run to about 16%. Under the 70% line; the run continues. Only
the usage reading was looked at.

*Note, 2026-11-10 04:50 UTC, after the counted run, before grading.* **The
counted run did not measure cost, so one more replicate measures it.** Codex
CLI reports a turn's tokens only when the turn completes, and the harness
stops the daemon as soon as the task's checks pass, usually while a Codex turn
is still running. That last turn records no tokens. A task finished in one
Codex turn records none at all: 32 of 54 `outcome` trials and 27 of 54
`outcome-bare` trials show zero, and every generalist trial is missing its
last turn. The recorded usage therefore understates every arm by different
amounts and cannot price them. Codex's own rollout files log the tokens of
every model call, but they live in the trial's home, which the harness
deletes.

The harness now keeps those rollout files in the trial folder before the home
is deleted (`evals/src/codex-rollouts.ts`, eval-only; no product code and no
build changed). One replicate (18 books, three arms, 54 trials) runs with the
counted run's build, catalog, groups, cap and arm order (`cost-trials/`). From
it:

- Cost per task is the sum over every model call in the kept rollouts, priced
  as registered ($2.00 uncached input, $0.10 cached input, $10.00 output).
  Median and total per arm, and the per-book ratio to generalist, are reported.
  If both candidates qualify, this is the cost the tie-break uses.
- Its outcomes are not part of the decision analysis. They are reported only as
  a replication beside the counted run.
- Check: in each trial, the rollout tokens must be at least the tokens Gezel
  recorded.

Before this note, the counted run's per-arm failure counts were seen (16, 9 and
7 model-classified failures of 54 for generalist, outcome and outcome-bare)
while checking for infrastructure failures to rerun. There were none: no usage
limit, outage or daemon failure in any trial log. No graded result, judge score
or wall time had been looked at. Plan usage was 15% at the end of the counted
run.

## Result (2026-11-10)

All 162 trials ran and none was excluded: no usage limit, outage or daemon
failure, and no timeout (the longest trial took 6 minutes). The weekly plan
window went from 9% before the smokes to 15% after the counted run and 17%
after the cost replicate. The judge passed every validity check: test-retest
SD 0.25 over 162 trials, 27 of 27 planted defects caught, and inter-judge alpha
0.61 over 41 trials (second judge Sonnet 5.5), just over the 0.6 gate. By axis
the two judges agreed least on grounding (0.28) and fitness (0.45).

| Arm | P1 | P2 | P3 | Wall (median min) |
|---|---|---|---|---|
| generalist (control) | 38/54 | 0.98 | 8.28 | 2.7 |
| outcome | 45/54 | 0.99 | 8.43 | 1.3 |
| outcome-bare | 47/54 | 0.99 | 8.61 | 1.1 |

Against generalist, 54 pairs:

| Arm | P1 rate delta | Discordant (Holm p) | P2 delta | P3 delta | Wall ratio |
|---|---|---|---|---|---|
| outcome | +0.13 [+0.00, +0.28] | 9 / 2 (0.065) | +0.009 [−0.001, +0.019] | +0.15 [−0.02, +0.36] | 0.51 |
| outcome-bare | +0.17 [+0.02, +0.35] | 10 / 1 (0.023) | +0.014 [+0.005, +0.024] | +0.33 [+0.08, +0.67] | 0.42 |

The harness's failure classes show no failure mode new to either candidate.

**Decision, as registered.** Both candidates meet every condition. Their P3
difference, outcome minus outcome-bare, is −0.18 [−0.40, −0.03]; the interval
excludes zero, so the cost tie-break does not apply and the higher-scoring
`outcome-bare` is Sol's measured strategy through Codex CLI. (It is also the
cheaper of the two; see cost below.) It is recorded as
`'codex-cli:gpt-6.1-sol': { strategy: 'outcome', procedure: 'none' }` in
`HOSTED_MODEL_TASK_STRATEGIES`. With the Sonnet run, both frontier models
measured now prefer a goal-based strategy to generalist, which is the
condition the Sonnet pre-registration set; they differ on which one (Sonnet's
registered pick was `outcome`). Whether the default for every hosted frontier
model changes, and to which, is the owner's decision.

Quality does not rest on one book. Without codemod-sweep, where generalist
scored lowest (5.4), outcome-bare minus generalist is +0.20 [+0.05, +0.41] and
outcome minus outcome-bare −0.09 [−0.18, −0.01].

**Registered secondary analysis (corrected checks).** `corrected-checks.mts`,
run on the frozen files (checksums verified before the run): generalist 40,
outcome 47, outcome-bare 52 of 54; outcome +0.13 [+0.00, +0.28] (10 / 3),
outcome-bare +0.22 [+0.07, +0.39] (13 / 1). The decision does not change.

**Cost (the replicate registered at 04:50 UTC).** 54 trials, every one with its
Codex rollouts kept. Median cost per task, priced as registered: generalist
$0.28, outcome $0.10, outcome-bare $0.07 (totals $5.57, $2.02 and $1.65).
Against generalist the per-book cost ratio has a median of 0.34 for outcome
and 0.27 for outcome-bare, and each was cheaper on all 18 books. Outcome-bare
was cheaper than outcome on 13 of 18 books; the difference in median cost is
−$0.03 [−$0.055, −$0.003] (books resampled). The replicate's passes, reported
only as a replication: generalist 12, outcome 16, outcome-bare 15 of 18.

The registered check on these figures failed, and the cause is Gezel's record,
not the rollouts. In all 18 generalist trials the rollout tokens were below
what Gezel recorded. `codex exec resume` reports the thread's running total in
`turn.completed`, and Gezel added each running total as if it were one turn's
use. In all 38 replicate trials that completed a turn, Gezel's record equals
the sum of the running totals at each completed turn exactly, in input, cached
input and output. So Gezel overstated any Codex session that resumed a thread
(every generalist trial) and, as the 04:50 note found, recorded nothing for a
turn still running at shutdown. The rollouts count every model call once. The
provider now charges each turn the difference from the thread's last total
(`packages/service/src/providers/codex-cli/thread-usage.ts`); the counted
run's recorded usage is not used for cost.

**What the interrupted turns did not change.** In 86 of the 162 counted trials
a Codex turn was still running when the harness stopped the daemon (25
generalist, 33 outcome, 28 outcome-bare). Every task that completed did so
through Sol's own `advance_task_step` or `set_task_status` call (47, 54 and
54), so each graded deliverable is the one Sol handed in, and the wall time
ends where Sol finished. The interruption cost only the closing message and
the usage record.

**Post hoc, reported as such.** Every failure was read. Of 32, 19 were checks
rejecting correct work:

- market-scan, all 9 trials, every arm: "forecast" in sentences saying the
  sources give none ("not a verified forecast", "provides no adoption rates
  or forecasts"). The corrected check passes five; the other four are
  cautions it does not recognize ("Avoid converting these directional
  signals into precision forecasts", "before attaching revenue forecasts",
  and in one trial "seamless", another term on the same list, in "validate
  integration requirements before promising seamless returns/refunds
  automation"). *Corrected 2026-11-10, after the replay for Gilde 1.0.7:
  this line first named a sentence starting "No" as the fourth; 1.0.6
  already accepts that one, and "seamless" is what failed the trial.*
- data-quality-audit, 5 trials: the row count in a form the check misses,
  such as "6 CSV data rows" and "6 customer rows" (two outcome and two
  outcome-bare trials; the corrected check passes two of them), and a section
  headed "Failing evidence" where the check accepts only "failing examples"
  and similar (one generalist trial and one of those outcome-bare trials, both
  listing every failing row).
- corpus-synthesis, 2 outcome-bare trials: the SLA claim, as in the Sonnet
  run.
- engineering-retrospective, 1 outcome trial: "not an adjustment to a
  performance score".
- engineering-retrospective, 2 generalist trials, strict rather than wrong:
  all six required sections, with "Evidence limits" before "Experiments".
  The contract checks each section; only the test requires the listed order.

The 13 real failures:

- codemod-sweep, 3 generalist and 2 outcome: the rename also rewrote the brief
  that defined it ("Rename brief: loadUser -> loadUser"), a fixture the task
  must leave unchanged. No outcome-bare trial did this.
- 4 generalist trials paused by Sol itself: three runbooks, where the
  recipe's evaluation step failed Sol's own runbook for what the incident
  brief does not supply (paging routes, an approved way to pause and resume
  the consumers) and Sol paused the task as blocked,
  and one corpus synthesis after its final gate rejected the citation form.
- 3 generalist trials paused by the runtime after the citation check rejected
  a reference list of plain paths (the contract asks for backticked paths):
  twice when a second session started for a re-activated step while the first
  was still mid-turn and the first one's end was counted as a failed handoff,
  and once when the gate's plateau guard paused the task after a single
  rejection. Both are runtime defects that only a multi-step task can hit;
  they are reported, not fixed.
- research-report, 1 outcome: the report cites the five data sources but not
  the brief, which the check requires.

Counting every misread and the order check as passes: generalist 44, outcome
51, outcome-bare 54 of 54 (Sonnet's reading: 54, 54 and 53).
