# Wave 1 supervision report — July 2026

Wave 1 of the project-type catalog ([strategy paper](project-type-catalog-strategy-2026-07.md))
is built and supervised: **11 new bundled project types** across five categories, joining
Flashcards (shipped in Phase 1a, filling the Study Buddy slot) to complete the first-ship
dozen. This report records what was verified, how, and the gaps left deliberately open.

## The dozen

| Type | Category | Gezel (role) | Stores | Craftbooks | Supervision |
|---|---|---|---|---|---|
| Household Budget | money | Penningmeester | ledger | subscription-audit, month-close | 10 checks, pass |
| Freelance Office | money | Kantoormeester | roster (invoices) | proposal-sow, weekly-review | 11 checks, pass |
| Life Binder | money | Archivaris | roster (documents) | annual-document-review | 10 checks, pass |
| Household Manual | home | Huismeester | roster (systems) | seasonal-maintenance-sweep | 9 checks, pass |
| Meal Planner & Pantry | home | Maaltijdplanner | doc (menu) + roster (pantry) | weekly-menu-plan | 11 checks, pass |
| Caregiving Binder | home | Zorgcoördinator | roster (meds) + log (care) | visit-prep | 12 checks, pass |
| Event Planner | events | Ceremoniemeester | roster (guests) + ledger (budget) | runbook | 11 checks, pass |
| Trip Planner | events | Reisleider | doc (trip) + roster (packing) + log (journal) | pre-departure-countdown | 13 checks, pass |
| Fundraiser HQ | events | Aanjager | ledger (donations) | social-thread, drive-wrap-up | 10 checks, pass |
| Fitness Coach | growth | Coach | log (training) | weekly-review | 11 checks, pass |
| Novel Writing Room | writing | Schrijfmaat | log (sessions) + roster (chapters) | copy-review, ebook-compile | 14 checks, pass |
| Study Buddy (= Flashcards) | growth | Studiemaat | doc (deck) | — | Phase 1a suite |

Every type follows the same composition: one Dutch-role gezel template (voorman), one
store script multiplexed by bound tool actions, JSON seeds rendered from creation params,
and a live dashboard page reading the seeded store files. Two types exercise the Phase-1a
page-invoke rail with page-only tools: Household Budget (`record_expense` quick-add) and
Trip Planner (`mark_packed` checkboxes).

## What supervision verified

Two layers, run per type by a driver (122 checks total, zero failures):

**Structural** — the gezel template resolves with its role; the template's `about.md`
enumerates no literal tool identifiers (character prose only, per the AGENTS.md
convention); every referenced craftbook id resolves to a committed catalog template; the
page entry exists; every `pages.reads` path is covered by `workspaceSeed`; every seed
renders fully from param defaults, including **numeric params landing as JSON numbers**
(`goalCents`, `weeklyTarget`, `weeklyWordGoal` are seeded via raw-string seeds with
unquoted placeholders — the assembler would otherwise quote them).

**Flow** — the sentinel-delimited rules block is extracted from the *committed manifest
script* (shipped bytes are supervised bytes) and driven together with the real
`@bendyline/gezel-sdk/stores` implementations over real temp files, replaying the
multi-step store lifecycle each gezel performs. Highlights:

- **Budget**: month-scoped rollups rank utilities over groceries; June spend excluded from July.
- **Freelance Office**: overdue detection (sent + past due date), paid-this-month rollup.
- **Life Binder**: 8-document canonical seed; staleness (>365d unreviewed) flags a 2024 review.
- **Household Manual**: interval-based care due (100d ago on a 90d interval) vs. not-due; attention flags.
- **Meal Planner**: grocery gap = low+out only; UTC day-name resolution; tonight's dinner line.
- **Caregiving Binder**: upcoming vs. past appointments; the visit-prep window carries only post-visit notes.
- **Event Planner**: party-size-weighted headcounts (7 invited / 4 coming / 2 awaiting); countdown; spend line.
- **Trip Planner**: itinerary rendering, packing counts, countdown-to-departure phrasing.
- **Fundraiser HQ**: raised-vs-goal percent, thank-you debt after a targeted `thanked` flip.
- **Fitness Coach**: a 3-day streak via real `logStore.stats`; Monday-anchored week counting; passenger keys (`goal`, `weeklyTarget`) survive appends and rewrites.
- **Novel Writing Room**: word totals, weekly pace vs. goal, chapter-board shape across stage transitions.

In addition, the committed test suite covers the wave end-to-end:
`packages/service/src/project-type/wave1.test.ts` (33 tests) applies every type against
the real catalog — voorman role, provenance-stamped script install, craftbook install,
fully-rendered seeds, numeric-seed types, and the page/model tool-surface split
(`record_expense` and `mark_packed` never reach the model).

## Gates at time of writing

- `pnpm build`, `pnpm test` (73 files / 1284 tests), `pnpm test:e2e` (31 specs): green.
- `pnpm typecheck`: green in every package except a **pre-existing** failure in
  `packages/ui` — `ChatComposer.tsx` passes `hostMode` to `squisq-editor-react@2.3.4`,
  whose installed typings don't declare it (introduced on main independently of this
  wave; Squisq is the external editor package).
- Full-suite note: `evals` `corpus.test.ts` shells out to `tar` with `C:\…` paths; under
  a Git-Bash-first PATH, GNU tar parses the drive letter as a remote host. Passes under
  PowerShell/bsdtar. Environment artifact, not a code issue.

## Platform limitation — closed by the provenance-trusted lane

At the time of the first supervision pass, live sandboxed script runs were unavailable on
Windows (and, for script runs, Linux): the deny-net policy fails closed where no OS
network boundary exists (exit 126). That limit has since been closed for **first-party
shipped scripts**: a project script whose bytes exactly match the catalog-shipped
project-type script (provenance header + body, verified per run) executes under the
remaining sandbox layers — permission-model fs scoping, no child processes, JS
network-API neutralizer — on every platform. Edited or model-authored scripts still fail
closed without the OS fence. See the platform note in
[project-types.md](project-types.md).

Consequently `wave1.test.ts` now also **executes every shipped store script end-to-end
in the sandbox** (apply → `ScriptRunner.run` with the type's `status` action → ok +
non-empty summary) on all platforms, upgrading this report's coverage claim from
"extracted rules + real stores" to live execution of the shipped bytes.

## Craftbook coverage — gaps closed

Every Wave-1 type now ships at least one craftbook for its standardized ritual. The wave
initially referenced existing catalog books only, which left five types bare; **seven new
ritual books** were then authored through the archetype pipeline
(`scripts/gallery-specs/14-wave1-rituals.json` → `generate-craftbooks`) and wired into
the type manifests:

- **month-close** (Household Budget) — reconcile the month's ledger, compare to last month, write the summary with one next-month action.
- **annual-document-review** (Life Binder) — verify each document's currency, reset staleness tracking, rank the gaps by consequence.
- **seasonal-maintenance-sweep** (Household Manual) — derive the due list from intervals, plan the walkthrough, log care so due-tracking resets.
- **weekly-menu-plan** (Meal Planner) — pantry-aware seven-dinner plan written onto the menu, plus one store-grouped grocery list.
- **visit-prep** (Caregiving Binder) — compile since-last-visit events and the med list into a one-page ranked-questions brief.
- **pre-departure-countdown** (Trip Planner) — audit documents/bookings/packing, grow the packing roster from the itinerary, day-by-day list to departure.
- **drive-wrap-up** (Fundraiser HQ) — recompute totals from the ledger, close the thank-you debt, write the community story + organizer handoff.

Each book follows the house archetype shape (scope-first with an acceptance-criteria
checklist, specialist role per phase, an evaluate pass that loops back on failure) and
its prompts reference the type's **workspace files** (`ledger.json`, `meds.json`, …) and
"the project's … capabilities" rather than literal tool names, so tool renames can't
strand them. The generator run is churn-safe: previously committed books were untouched
(regenerated drift restored from git), only the seven new ids landed.

## Stdlib decisions made during the wave

- **`ledgerStore` earned its place** in `@bendyline/gezel-sdk/stores` (integer-cents
  in/out entries, category + month rollups): four Wave-1 types use it (Budget, Freelance
  Office, Event Planner, Fundraiser HQ), with Shop Numbers and Tax Shoebox queued in
  later waves. Nothing else recurred ≥3 times — due-dates ride roster fields and log
  `data`, so the rule of three holds.
- **Passenger keys** are the sanctioned pattern for small per-store scalars
  (`goalCents`, `weeklyTarget`, `weeklyWordGoal`, `eventDate`): extra top-level keys in
  a store file survive store round-trips because stores serialize the loaded object.
  Supervision asserts this survival explicitly.
- **SQLite passthrough: deferred.** JSON stores stay inspectable
  (files-all-the-way-down), the sandbox has no module tree to load a driver into, and
  Wave-1 stores are hundreds-to-thousands of rows. Revisit trigger: a store file passing
  ~1–2 MB or needing aggregation a script can't precompute (Shop Numbers over years of
  POS data) — and then likely as a connector/index, not script-side SQL.
