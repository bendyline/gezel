# Task strategy on a frontier model: Claude Sonnet 5.5 (2026-11-09)

*A copy of `evals/runs/frontier-2026-11-09/PREREG.md`, unchanged. That file is the record.*

Written before any trial of this run.

**Question.** Should Gezel stop running Claude Sonnet 5.5 "one owner, whole
recipe" (`generalist`, today's `auto` choice for hosted frontier providers)
and run it goal-based instead?

**Where the hunch comes from.** The outside-tool comparison
(`pi-compare-2026-11-08`, amendment 2) ran Sonnet on seven books, two
replicates. Goal only (`outcome-bare`) passed 14/14 against generalist's 13/14,
with judged quality +0.00 [−0.35, +0.38], at 0.37× the wall time and about a
fifth of the cost. Seven books are too few for the decision rule. That run
generated the hypothesis, so it is reported beside this one and never pooled
with it.

**Arms** (`evals/src/strategy/books.ts`):

- `generalist`: control, today's default for this model.
- `outcome-bare`: goal only (contract enforced, no recipe).
- `outcome`: goal, recipe as advice (contract enforced, recipe shown as optional).

**Model.** `claude-sonnet-5-5` through Gezel's `anthropic` provider (the
Messages API, Gezel's own tool loop) with the model's catalog tuning.

**Books.** All 18 strategy benchmark books. Eleven have not run on Sonnet
before.

**Replicates and order.** Three per cell, 162 trials. Arm order rotates by
replicate and book (`armOrder`). To finish in hours, three processes run
side by side, each with six books balanced by kind of work and all three
arms, so every arm sees the same machine load:

- A: research-report, powerpoint-deck, bug-fix-tdd, ab-test-readout, alert-rules, invoice-run
- B: corpus-synthesis, market-scan, refactor-module, cohort-analysis, runbook, html-arcade-game
- C: content-accuracy-review, engineering-retrospective, codemod-sweep, data-quality-audit, csv-transformer, press-release

**Build and catalog.** Gezel at `c9ce13ed`, rebuilt before the run (the
packages' built output predated the merge's gate and grounding changes).
Catalog: round 3's (`round3-2026-11-06/gilde-drafted/data`), whose 18 books
are byte-identical to `@bendyline/gilde` 0.3.6. Time cap 45 minutes per
trial, as in every Sonnet trial so far.

**Smoke, not counted.** The eleven new books once each in `outcome-bare`, to
catch plumbing faults only. A fault found there is fixed before the run
starts and recorded here. Its results are not analyzed.

**Endpoints.** As in the strategy pre-registration (2026-10-22): P1 (primary
binary), P2 (criteria met), P3 (Opus 5.5 judge v3, three samples, blinded,
sources attached), wall time. P1 is the primary pass measure, since every arm
is Gezel and leaves tool records; P1-result is reported beside it. Added for
this run: **cost per task**, from the provider's token counts priced at
Sonnet 5.5's rates ($2 per million input, $10 output; cache writes $2.50 and
reads $0.10 where the provider reports them).

**Judge validity on frontier output.** Sonnet's work scores near the top of
the scale, where the judge has not been validated. The grade pass runs
`--judge-validity`: test-retest SD must stay at or under 0.7 and the judge
must catch at least 90% of planted defects. If it fails either, P3 is
reported descriptively and the decision rests on the other conditions. The
inter-judge check uses Sonnet as the second judge here, so it is Sonnet
judging Sonnet: reported, not used as a gate.

**Decision rule** (the registered rule, generalist as control). A candidate
qualifies to replace generalist for this model if all of these hold:

- P2 delta lower bound above −0.05;
- P3 delta lower bound above −0.5;
- pooled P1 rate delta lower bound above −10 points;
- median wall-time ratio at or under 1.0 (or 1.25 if significantly better);
- no failure mode in two or more of its trials that never occurs in the control's.

If both candidates qualify, the cheaper by median cost per task wins, unless
their P3 difference has an interval that excludes zero. If neither qualifies,
generalist stays.

**Scope of the decision.** A qualifying result changes Sonnet 5.5's own
measured strategy (`tuning.taskStrategy` in its catalog entry), the same
mechanism the on-device models use. Changing the default for every hosted
frontier model needs at least one more frontier model measured, and is out
of scope here.

**Analysis.** Pairs are (book, replicate), 54 per comparison. Intervals are
95% percentile bootstraps resampling books; P1 uses exact McNemar on
discordant pairs, Holm-adjusted over the two candidates. Per-book and
per-kind figures are descriptive.

**Exclusions.** An infrastructure failure (an API outage or overload error
the provider reports, the trial daemon failing to start) is rerun once, then
dropped and reported. Timeouts and anything the model does count as failures.

**Spend.** Projected at $60 to $120 for the counted trials, from the
seven-book medians. If the first replicate's actual spend projects the run
above $200, the run pauses for the owner. That check reads cost only, never
outcomes.

**Known strict checks.** The four checks the report lists as misreading
correct work (runbook numbered steps and "when not to use it", two cohort
checks) stay as registered. Their effect is reported as a sensitivity
analysis, as in the report.

*Note, 2026-11-09 21:58 UTC, before the counted run.* The dependency sync
(`pnpm deps:install`, Gilde 0.3.6 to 0.3.8, owner approved) and a full
`pnpm build:packages` at `c9ce13ed` came first. The smoke (`smoke/`, 11
trials) found no plumbing fault: every trial ran Sonnet through the
`anthropic` provider and resolved the intended strategy, and the cost
readout works ($1.18 in all). Nothing was changed after it. Its results are
not analyzed.

*Note, 2026-11-09 22:27 UTC, spend check.* After the first replicate (61
trials), spend was $15.69 (median per task: generalist $0.44, outcome $0.11,
outcome-bare $0.12), projecting about $42 for the run. Under the $200 line;
the run continues. Only the cost readout was looked at.

## Result (2026-11-10)

All 162 trials ran; none was excluded (no infrastructure failure, no
timeout). Counted spend $40.89 (median per task: generalist $0.43, outcome
$0.12, outcome-bare $0.11), plus $1.18 for the smoke. The judge passed every
validity check on this run's output: test-retest SD 0.27, 25 of 27 planted
defects caught (93%), inter-judge alpha 0.72 (Sonnet judging Sonnet; not a
gate).

| Arm | P1 | P2 | P3 | Wall (median min) |
|---|---|---|---|---|
| generalist (control) | 48/54 | 0.99 | 8.56 | 2.2 |
| outcome | 51/54 | 1.00 | 8.65 | 0.7 |
| outcome-bare | 44/54 | 0.99 | 8.69 | 0.7 |

Against generalist, 54 pairs:

| Arm | P1 rate delta | Discordant (Holm p) | P2 delta | P3 delta | Wall ratio |
|---|---|---|---|---|---|
| outcome | +0.06 [+0.00, +0.11] | 3 / 0 (0.250) | +0.002 [+0.000, +0.005] | +0.09 [−0.09, +0.29] | 0.35 |
| outcome-bare | −0.07 [−0.17, +0.00] | 0 / 4 (0.250) | −0.004 [−0.008, −0.001] | +0.12 [−0.04, +0.31] | 0.36 |

**Decision, as registered.** `outcome` meets every condition. `outcome-bare`
fails one: its pooled P1 lower bound is −17 points, below −10. Only `outcome`
qualifies, so it replaces generalist for Claude Sonnet 5.5 (its catalog
`tuning.taskStrategy`: outcome, procedure advisory). Publishing that catalog
change is the owner's.

**Registered sensitivity.** Counting the runbook numbered-steps failures (the
only registered strict check that fired: one generalist, two outcome-bare
trials, all numbered as "### Step 1" headings) as passes: generalist 49,
outcome 51, outcome-bare 46; outcome-bare's P1 delta −0.06 [−0.15, +0.00]
still fails. The decision does not change.

**Post hoc, reported as such.** Of the 19 failures, 18 were checks misreading
correct work, found while reading every failure:

- market-scan, all 9 trials, every arm: the forbidden-claims check matched the
  word "forecast" in sentences saying the sources give none.
- data-quality-audit, 1 generalist and 3 outcome-bare: the row-count check
  accepts "6 records" but not "6 customer records", which all four wrote.
- corpus-synthesis, 1 generalist and 1 outcome-bare: the invented-SLA check
  matched an SLA claim the seeded source makes and the synthesis cites.
- runbook, as above (3).

The one real failure: an outcome-bare codemod-sweep run wrote its review
notes to `report.md` in the project root, naming the old identifier, so the
contract's own "no site of the old form" check failed it. Counting every
misread as a pass: generalist 54, outcome 54, outcome-bare 53; outcome-bare's
P1 delta −0.02 [−0.06, +0.00] would then qualify, and as the cheaper by a
cent it would win the tie-break. That reading is post hoc and does not
replace the registered decision. Either way the two goal-based strategies
matched generalist's quality at about a third of the wall time and a quarter
of the cost. (`sensitivity.mts` reproduces these figures.)

*Note, 2026-11-10, on where the decision lives.* This pre-registration and
its Result call the setting Sonnet's "catalog" `tuning.taskStrategy`. Hosted
models have no Gilde catalog entry, so there was no catalog tuning in the
trials ("the model's catalog tuning" above amounts to Gezel's defaults for
the `anthropic` provider) and there is no catalog entry to change. A hosted
model's measured strategy is recorded in Gezel instead:
`HOSTED_MODEL_TASK_STRATEGIES` in `packages/core/src/task-strategy.ts`, keyed
by provider and model (`anthropic:claude-sonnet-5-5`), and it ships with the
app. The decision is unchanged.
