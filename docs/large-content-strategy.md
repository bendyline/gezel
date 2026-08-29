# Working with more content than fits in the window

A gezel is regularly handed work whose evidence is larger than its context
window: review 25 changed files, audit a 400-page export, summarize a year of
sessions. Today the runtime handles this by *hoping it fits* — read everything,
then produce the deliverable — and recovers from restarts by replaying what it
can. When the evidence genuinely exceeds the window, that shape does not
degrade gracefully. It loops.

This note records the failure we measured, why the obvious fixes are only
partial, and the strategy the runtime should adopt.

## The incident (2026-08-29, gezel/44 batch 9)

A Reviewer held 25 pull-request records — one batch of a bounded PR review, by
construction the largest single-step read set the craftbook produces. Two
service restarts landed mid-step. Each rebuild logged:

```
session 8e3fe505: replayed 25 tool result(s) (59983 chars) into the rebuilt
                  context; 78 superseded, 30 over budget
```

Thirty results dropped for budget. The replay is honest about this — dropped
results come back as markers naming what to re-read — and the resume seed said
to re-read exactly those. The model did. The next rebuild dropped thirty
again, and its visible output oscillated inside a single turn:

> All 25 records are now in hand. … I have full content for 17 of 25 records
> now. Still missing: record 219 … All 25 records are now in hand.

Nothing here malfunctioned. Each part did its job, and the composition still
could not converge, because **re-reading is only a recovery strategy when the
evidence fits.** Deduplicated, this batch is ~132 KB against a 60 KB cap. The
loop was structural, not a bug in any one component.

The model's 84k-token prompts were fitting comfortably the whole time. The
context existed; the cap refused to use it.

## What we changed immediately

1. **The replay budget scales with the model's context window** — 40% of the
   window, floored at the previous fixed 60 KB so small-context models keep
   today's behavior, ceilinged so a million-token window doesn't volunteer a
   novel (`toolEvidenceBudgetChars`, chat/tool-evidence-replay.ts). A fixed cap
   can only ever be right for one workload; this one was sized to the batch
   that motivated the module and was wrong one batch later.

2. **The resume seed names what the session already persisted** and tells the
   model to continue from it (chat/manager.ts). A restart mid-batch is exactly
   when a model most needs to know its own partial deliverable survived —
   otherwise its only recovery is to reconstruct everything. It also stops
   promising that re-reading is sufficient, and says plainly: work through the
   remainder in small groups, writing conclusions as you go.

Both are real improvements and neither is the answer. (1) buys headroom and
loses it again on the next larger corpus. (2) makes recovery cheaper but still
depends on the model choosing to work incrementally.

## The strategy: make incremental the default shape, not a suggestion

The durable fix is that **no step should require holding all of its evidence at
once.** Three mechanisms, in the order we should build them:

### 1. Persist-as-you-go, enforced by the step contract

A craftbook step that says "read 25 records, then write observations" has
declared a peak memory requirement of 25 records. The same review written as
"for each record: read, judge, append to the deliverable" has a peak of one.
The output is identical; the failure modes are not.

The runtime already has the primitives — `write_artifact` appends, task notes
persist, gates check deliverables. What is missing is the step *shape*: a
`perItem` procedure that the runtime drives, so the model never sees the whole
corpus in one prompt and the gate checks the accumulated artifact rather than a
single final write. This is the highest-value change and it is authoring work,
not engine work.

### 2. A read-and-compact tool contract

When a model must consult more source than fits, the runtime should offer
"read this and give me back only what matters for X" as a *tool*, executed in a
sub-context, returning a compact result to the caller's context. This is the
map step of map-reduce with the map running out-of-band. It differs from
today's summarizers in that the caller states the extraction criterion, so the
compaction is task-directed rather than generic.

Cost: one sub-turn per chunk. Benefit: peak context becomes O(chunk), and the
caller's transcript holds conclusions instead of raw payload — which also makes
the *next* restart cheap, because conclusions replay where payloads cannot.

### 3. Locate-then-read as the default for unknown-position work

`grep_files` / `search_code` / `find_symbol` already exist and are already
cheaper than reading whole files, but the prompt stack treats them as
alternatives rather than the default opening move. For any corpus larger than
the window, locating first and reading only the located ranges is not an
optimization — it is the only shape that terminates. The `read_files` range
form (`{ path, startLine, endLine }`) is the right primitive and is
under-instructed today.

## What shipped (2026-08-29)

All three layers, because the shape recurs at each of them:

- **The craftbook that caused it** — `pull-request-review` **1.9.0** rephrases
  its fanout step from "read all 25 records, then write observations" to a
  per-group loop that appends after every ~5 records. Peak evidence drops from
  25 to 5; a stopped turn loses one group instead of everything.
- **Authoring guidance** — gilde's `docs/craftbook-evaluation-framework.md`
  gained a *Step sizing* section stating the peak-evidence rule and the
  diagnostic question ("if the daemon dies halfway, how much work is lost?"),
  so the next read-heavy book does not repeat the shape.
- **The framework prompt** — `buildInstructions` now carries one sentence
  teaching the incremental shape generally, because craftbooks are not the only
  place a model meets more material than it can hold. It is gated on a
  persistence tool actually being on the roster: telling a session to "write it
  down" when it cannot write is the ADR 0001 failure in a new costume.

The prompt line is deliberately the thinnest of the three. A step that *names*
the incremental shape is far more reliable than a standing instruction hoping
the model infers it — the prompt exists for the ad-hoc work no craftbook covers.

## Design rules this incident establishes

- **A budget expressed in absolute units is a bug waiting for a bigger
  workload.** Scale to the resource that actually varies (the window), floor it
  so nothing regresses, ceiling it so nothing runs away.
- **Honesty markers are necessary but not sufficient.** Telling a model what it
  is missing is only actionable if recovering is possible. When it is not, the
  instruction must change from "re-read what's missing" to "proceed
  incrementally and persist".
- **Every step should be restart-cheap.** The question to ask of any procedure:
  *if the daemon dies halfway, how much work is lost?* If the answer is "all of
  it", the step is holding state it should have written down.
- **Measure peak evidence, not average.** The batch that loops is the largest
  one, and it is the one nobody tests.

## Open questions

- Where does the `perItem` step shape live — craftbook manifest, or a runtime
  step kind? It affects whether existing books get it for free.
- Should read-and-compact run on the same model (consistent judgment, serial
  cost) or a smaller one (cheap, risks missing what the caller cared about)?
- Can the replay layer prefer *conclusions* over *payloads* automatically —
  e.g. always keeping task notes and artifact writes over raw tool output when
  the budget binds? That would make incremental work self-reinforcing.
