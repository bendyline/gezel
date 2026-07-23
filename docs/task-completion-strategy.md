# Task-completion strategy: craftbooks, roles, and the machinery around them

*Grounded in ~1,100 eval trials across three full baselines, the
912-trial failure-history analysis, two prompt A/Bs, and the first live
evidence that completion gates work end-to-end. Scope: small (2–9B), medium
(20–35B), and frontier-class models, across the full activity range — code,
documents, research, data, operations, communication — not just coding.*

---

## Part 0 — The design laws the evidence already proved

Everything below derives from five empirical laws. When a future proposal
conflicts with one of these, the proposal is probably wrong.

**Law 1 — Runtime enforcement beats prose instruction.**
"Done means proven" in the Developer prompt moved done-claim behavior
marginally; a completion gate that *rejects* `advance_task_step` moves it
mechanically. Across the failure history, every prose "must" that mattered
eventually had to become a check. Corollary: treat role-prompt text as a
*hint layer* and checks/gates as the *contract layer*; migrate hints to
contracts as soon as a failure class is observed twice.

**Law 2 — The deliverable is the protocol.**
Progression that rides on observable artifacts (`advanceWhen` on a real
file) works in plain chat sessions today; progression that rides on
meta-tool calls models must remember to make (advance_task_step,
set_task_status) never happened once in 112 baseline trials. Corollary:
every craftbook step in every domain must name an artifact. A step whose
output is "a conversation" is unverifiable, ungated, and unadvanceable.

**Law 3 — Feedback specificity is the small-model multiplier.**
The three highest-leverage interventions of the whole program were feedback
wording changes: naming the model's *own* fabricated paths (squisq 0/3→2/3),
relaying collection-error lines verbatim (failing-tests 0/3→1/3), and the
un-truncated stderr hint (bookstore's `require` wall). Generic warnings do
nothing; "your X is wrong because Y, do Z" works. Gates inherit this law:
a rejection verdict must name the specific unmet check and the artifact
location, verbatim.

**Law 4 — Spec omission is the default failure mode of unscaffolded models.**
Once hand-tuned prompts were removed, models reliably built the *subset
they implement* (3 of 6 API paths, 1 of 4 schemas, 5 of 8 report sections).
Small models do not hold inventories in working memory. Corollary: the
deliverable inventory must live in durable structure — mission objectives,
step checklists, gate checks — never only in the kickoff prose.

**Law 5 — Structure must be tier-priced.**
A 4B model needs a 3-step loop with one artifact per step and a ~20-tool
surface; a frontier model treats the same scaffolding as overhead and routes
around it. The solo-collapse machinery (multi-role book → one specialist)
is the existing proof that books can be *reshaped per context*. Structure
density must become a first-class, tier-keyed dial, not a fixed property
of the book.

---

## Part 1 — Craftbook evolution

### 1.1 From "procedure prose" to "gate graphs" (in progress — finish it)

The June completion-gate migration moved 200 books to gates-on-steps. The
pin-floor bug hid the payoff until today. Now that gates fire:

- **Every step gets an artifact + a gate, or it merges into one that has
  them.** Audit the 203 books for prose-only steps ("review your approach",
  "consider the audience") and either attach a checkable output or fold
  them into the adjacent step's prompt. Prose steps are where small models
  stall and where the scheduler has nothing to drive.
- **Gate verdicts are the new feedback channel — apply Law 3 to them.**
  Verdict text should quote the failing check's actual observation (bytes
  found, section missing, pattern unmatched at path X), not restate the
  rule. The eval sniff-feedback wording lessons port directly.
- **Keep `maxAttempts` pause-for-user, but make the pause productive**: the
  pause message should carry the full attempt history (what was tried, what
  the gate said each time) so the user — or a stronger model picking up the
  task — resumes with the diagnosis done.

### 1.2 Tier-shaping: one book, three renderings

Generalize solo-collapse into **tier-collapse**. A book declares its full
graph; the engine renders it per executor tier:

- **small**: collapse to ≤3 steps, one artifact each, gates verbatim, step
  prompts rewritten to single-action imperatives, tool surface narrowed to
  the step's needs (see 3.2). Recovery steps pre-authored (the
  "validated-affordance" lesson: tiny models succeed when the hard part
  moves into the tool/gate).
- **medium**: the book as authored.
- **frontier**: gates only. Steps become a checklist the model may satisfy
  in any order; the gate graph is the contract, the procedure is advisory.
  (Frontier models lose more to scaffolding overhead than they gain from
  procedure — let the gate be the only hard structure.)

Implementation note: this is a *rendering* concern (like solo-collapse),
not 3× book authoring. Books gain optional `tierHints` per step; the
collapse pass lives next to `buildSoloLoopSteps`.

### 1.3 The non-coding check vocabulary (the biggest gap)

The script stdlib (17 checks) is file/HTML-centric. Non-coding activities
fail ungated today because the vocabulary doesn't exist. Build, in order
of breadth:

| Check | Backs which activities | Notes |
|---|---|---|
| `checkOrderedSections` | reports, postmortems, plans, briefs | exists — generalize from eval |
| `checkDistinctMatches` | citations, examples, action items | exists — generalize counting |
| `checkCitationsResolve` | research, reviews, briefs | cited path/URL exists in workspace/corpus — the anti-fabrication gate (squisq lesson) |
| `checkValueGrounding` | research, analysis | named facts must appear in authorized sources; decoy values must not (decoy-research grader, productized) |
| `checkTableShape` | data work, comparisons, plans | header set, row floor, column types |
| `checkRecordSchema` | data entry, ETL, structured docs | JSON/CSV rows validate against a declared shape (data-wrangle grader, productized) |
| `checkWordBand` / `checkReadingLevel` | comms, marketing copy | floors AND ceilings — verbosity is a failure mode too |
| `checkNamedEntitiesConsistent` | long docs | the thing referenced in §1 is spelled/numbered the same in §5 |
| `checkJudge` (LLM-judge scope) | tone, faithfulness, completeness | see 1.4 — fail-OPEN, advisory-first |

The eval suite already contains reference implementations of the hard ones
(decoy grounding, record schema, citation resolution) with
reference-solution tests — port them into the stdlib with the same test
discipline, and the gates and graders stay one codebase (the shared
`@bendyline/gezel/checks` move was the right architecture; extend it).

### 1.4 Judge-gates: the escape hatch for unverifiable qualities

Some non-coding qualities (tone, persuasiveness, faithfulness-to-source)
have no mechanical check. Add a `judge` gate-script scope that runs a
one-shot Klerk evaluation with a rubric — but under strict rules learned
from the eval program: (a) **fail-open and advisory for the first
deployment** (a wrong judge that hard-blocks is an unwinnable gate — the
arcade tank-vocab lesson at product scale); (b) judge output must quote
evidence from the artifact verbatim (the growth-proposals validator already
does exactly this — reuse it); (c) promote a judge-gate to fail-closed only
after eval data shows its false-reject rate is near zero.

### 1.5 Book lifecycle: close the loop with reality

- **Gate telemetry is the new ranking signal.** A book whose gates reject
  4× and pause on most runs is mis-calibrated; a book whose gates never
  reject adds no information. Track per-book gate outcomes; surface books
  by *completion lift*, not just semantic match.
- **The pin must be reliability-engineered.** Today's bug class — silent
  empty shortlists from score-scale drift — gets a canary: a startup
  self-test that ranks three golden briefs and logs loudly if the top book
  changes or the shortlist is empty. (The preflight-gate pattern, applied
  to the suggestion engine.)
- **Craftbook editing tools (the 10 new ones) are a frontier-model
  feature.** Voorman-tier small models should see `suggest/invoke/read`
  only; authoring/editing tools surface at medium+ or to users. This is
  also tool-budget relief (3.2).

---

## Part 2 — Gezel role evolution

### 2.1 Roles are capability contracts, not personas

What a role *actually does* in the system today: selects a tool kit
(role-tool-filter), a tuning profile (suggestedTuningProfile), a template
about, and — since the gate work — implicitly a gate vocabulary. Make that
explicit. A role becomes a declared bundle:

```
role:
  toolsets: [...]            # exists
  tuningProfile: ...         # exists
  about: template            # exists
  gateAffinity: [...]        # NEW: checks this role is expected to clear
  defaultBooks: [...]        # NEW: books this role runs well
  capabilityFloor: ...       # NEW: min model tier for unsupervised steps
```

`gateAffinity` is what makes "Researcher" mean something mechanically: a
researcher's outputs default to citation + grounding gates the way a
developer's default to parse + test gates.

### 2.2 Harden the non-coding roles the way the coding roles were hardened

Developer/Builder abouts are 5–7KB of failure-driven contract; Researcher
(4.5KB), Copywriter (0.8KB), Planner (0.9KB), Boekwachter (1.3KB) never got
that treatment because the eval pressure was all code. The non-coding
scenario classes (Part 4) will generate the failure evidence; pre-seed the
obvious contracts now, ported from the proven dev-role patterns:

- **All roles**: "Done means proven" (artifact + gate, same turn);
  files-not-chat (a brief/report/plan is a *file*); read-the-spec-first
  (the failing-tests lesson generalizes: the source documents ARE the spec).
- **Researcher**: cite only opened sources; manifest-trust discipline
  (decoy lesson); contradictions get surfaced, not silently resolved.
- **Copywriter**: constraint inventory (length bands, banned phrases,
  required mentions) restated before drafting — the spec-omission law
  applied to copy.
- **Planner**: every plan item carries an owner + a checkable done-state —
  plans are gate-graphs in prose, and the Planner is the role that should
  *author* craftbook steps (give Planner the craftbook-editing tools at
  medium+ tier).

### 2.3 Routing: capability-based, evidence-checked

Two proven failure modes: role-noun lottery (Builder vs Designer deciding
image-tool access) and recruit-instead-of-relay churn. The fixes shipped as
prompt rules; graduate them to mechanism:

- Deliverable type → required toolset, validated at delegation time (a
  `.png` handoff to a kit without `generate_image` is rejected with the
  correction, not discovered four tool-calls later).
- **Per-step model routing** (the big one): craftbook steps declare a
  `capabilityFloor`; the engine assigns the cheapest installed model that
  clears it. "Frontier plans and repairs, small executes, gates verify" is
  the cost-structure endgame for local fleets — a 27B writes the plan and
  handles gate-rejection repairs, a 4B grinds the bounded steps, and the
  gate (not either model's self-assessment) decides what counts as done.
  The preflight-gate machinery already measures per-model capability
  evidence to drive this.

### 2.4 Growth, now that it can mean something

XP already weights step/task completion (10/25) — but until today, steps
never completed, so growth measured chat volume, not competence. With gates
live: (a) award XP only for **gate-approved** completions; (b) a gate
rejection later overcome is a *lesson candidate* with the verdict text as
evidence (the trait-proposal validator pattern); (c) `capabilityFloor`
routing (2.3) can consume growth level as a tie-breaker — a gezel that has
repeatedly cleared citation gates is a better pick for research steps than
a fresh recruit. Keep all of it user-ratified, as designed.

---

## Part 3 — The connective tissue

### 3.1 One completion contract everywhere

Three systems now express "what done means": eval sniffs, gate checks,
and `expectedDeliverable` hints. The shared-checks module unified the
first two; finish the job — `expectedDeliverable` should accept a check
list (not just a path), so an ad-hoc chat handoff carries the same
contract a craftbook step does. Then every handoff, scripted or not, is
gateable, and the auto-advancer's reach extends to non-task work.

### 3.2 Tool surface as a hard budget

138 tools in the bridge is hostile to 2–9B models (prompt mass, choice
paralysis, the role-noun lottery). Three moves:

- **Step-scoped surfaces**: the active step's deliverable type + gate
  checks determine the kit; everything else drops. A "write the report"
  step needs ~10 tools, not 138.
- **Tier budgets enforced at the bridge** (caps exist; make the priority
  list deliverable-aware rather than static per role).
- **Audit the new tool families** (code-intel ×10, craftbook-editing ×10,
  delegates ×~16) for tier gating — most are medium+ tools.

### 3.3 Reliability engineering for the invisible layers

The two costliest bugs of this program were *silent disablement*: the
pin-floor empty-shortlist and the embeddings pipeline failing without
downstream alarms. Pattern both into permanent guards: any subsystem whose
degradation silently changes model-facing behavior (suggestion engine,
embeddings, template resolution, profile resolution) gets (a) a loud
startup self-test and (b) a preflight check in the eval harness. The
preflight gate already covers profiles/budgets/capacity; add
suggest-returns-golden-brief and embeddings-state to it.

---

## Part 4 — Measure it: eval expansion beyond code

The current suite is ~75% code-shaped. The strategy above stands on
non-coding gates and roles — they need the same evidence pressure. Six
scenario classes, same grader discipline (behavioral gates, reference
solutions, satisfiable-from-prompt lint, failure-class accounting):

1. **research-verify** — multi-source corpus → cited brief; grounding +
   citation gates (decoy-research is the seed; add web-less corpus
   variants at 3 difficulty tiers).
2. **multi-doc-synthesis** — N inputs → one structured deliverable with
   reconciliation of conflicts surfaced explicitly (Researcher +
   Boekwachter roles).
3. **plan-and-estimate** — brief → plan whose items have owners,
   sequence-valid dependencies, and checkable done-states; gate =
   structural plan checks (Planner role's first real eval).
4. **ops-runbook** — execute a seeded runbook with verification commands
   and a deliberate mid-run anomaly; tests procedure-following +
   stop-on-anomaly (the craftbook system eating its own dogfood).
5. **constrained-comms** — draft customer/incident comms under hard
   constraints (length band, required disclosures, banned claims);
   word-band + contains/absent gates (Copywriter hardening evidence).
6. **forms-and-records** — data-entry/transformation precision into a
   declared record schema (data-wrangle generalizes off-code).

Plus the **macro A/B that's now finally meaningful**: craftbook-pinned vs
`GEZEL_DISABLE_CRAFTBOOK_HINT=1` across macro scenarios — the lever
measured nothing for three weeks because the pin was silently dead.

---

## Part 5 — Sequenced roadmap

**Now (days):**
1. Finish the gate-liveness verification + run the macro-scenario A/B vs
   the baseline (in flight).
2. Suggestion-engine canary + embeddings preflight check (3.3).
3. Gate-verdict wording pass (Law 3 applied to rejection messages).

**Next (1–2 weeks):**
4. Port decoy-grounding / citation-resolve / record-schema checks from
   eval graders into the script stdlib; add `expectedDeliverable` check
   lists (3.1).
5. Non-coding role hardening pass (2.2) + the first two non-coding
   scenario classes (research-verify, constrained-comms) to generate
   failure evidence.
6. Prose-step audit across the 203 books (1.1); tool-tier gating for the
   new tool families (3.2).

**Then (3–6 weeks):**
7. Tier-collapse rendering (1.2) — A/B small-tier collapsed books vs
   as-authored on the hard cells.
8. Judge-gates, advisory-first (1.4), on constrained-comms.
9. Per-step capability routing prototype (2.3) on a two-model fleet
   (27B plans/repairs + 4B executes), measured against single-model
   baselines — the cost-per-completed-task metric, not just pass rate.
10. Gate-coupled growth XP + lesson candidates (2.4).

**The metric that governs all of it:** gate-verified task completions per
model-tier per hour — not chat turns, not pass-rate alone. Structure
investments are justified exactly when they move that number for the
small/medium tiers without taxing the frontier tier.
