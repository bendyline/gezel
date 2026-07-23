# gstack skill import — assessment and plan

Status: assessment written against gstack @ HEAD (60 SKILL.md files: 1 router,
54 first-class skills, 4 OpenClaw ports, 1 generated browser-skill). Companion to
[craftbook-toolsets.md](craftbook-toolsets.md) and the importer in
[workspace/skill-scanner.ts](../packages/service/src/workspace/skill-scanner.ts).

**IMPLEMENTED** (plan `i-d-like-you-to-transient-crown.md`): the
deterministic skill→craftbook converter shipped end to end —
[core/src/skills/](../packages/core/src/skills/) (preamble strip, `## Phase N` → steps,
gate idioms, static shell→TS transpiler, persona detection), the static-only automatic
lane in [import-sync.ts](../packages/service/src/workspace/import-sync.ts) (script- or
persona-bearing conversions queue for approval; persona gezels mint at approval), the
manual surfaces (`POST /imports/convert`, the `import_skill` MCP tool, `gezel skills
list|import|convert`), hooks through the CraftbookDoc format, the hook `ask` →
permission-card wire-through, and the shipped catalog wave: all nine Wave 1+2 skills
(committed snapshot + overlays + regen-fidelity test in
[gstack-import.test.ts](../packages/catalog/src/gstack-import.test.ts)) plus the
hand-authored `careful-mode` and `freeze-scope` guardrail books
([guardrail-books.ts](../packages/catalog/src/guardrail-books.ts)).

**Presentation:** the shipped books present as ordinary gezel skills —
nothing in the recipe content is branded as gstack; each book credits the upstream
repository through its structured `basedOn` link. Each carries a plain, role-safe id/name
from the `WAVE` config in [gstack-import.ts](../packages/catalog/src/gstack-import.ts): `idea-office-hours`,
`root-cause-investigation`, `technical-documentation`, `executive-level-review` (not
"ceo-review" — avoids reading as a gezel role), `spec-authoring`,
`security-architecture-review` (was "cso"), `design-system-consultation`,
`browser-qa-audit`, `engineering-retrospective`. The converter drops gstack host plumbing
(the `omitProvenance` option strips the "Converted from…" line; a host-section +
fenced-plumbing + line-level scrub removes `~/.gstack/` paths, `gstack-*` CLIs, gbrain,
and brand footers) so procedure prose is gstack-free too — a test asserts zero
`gstack`/`gbrain` in the shipped bytes. Source credit lives only in dev-facing places:
the `scripts/gstack-skills/` snapshot, code comments, and git history. Persona drafts for
five skills await hand review under `packages/catalog/scripts/gstack-personas/` before
any ships as a gezel-template.

Still open from the recommendations: the documents-library lane for non-repo sources, the
sub-craftbook step, and a Settings toggle surfacing careful-mode.

## Where we actually are

The existing import path is narrower than "we imported some skills" suggests. The
workspace scanner discovers `SKILL.md` files in `.claude/.gstack/agents` skill dirs of a
*project workspace* and mints **project-local, single-terminal-step craftbooks** (body →
one step prompt; at most the first "simple" shell block LLM-translated to a sandboxed TS
`onExit` script, capability-capped to `workspace.read`+`llm`). Nothing from gstack has
ever landed in the **shipped catalog** — the 1,172 bundled craftbook-templates are
gezel's native gallery. There is no headings→steps mapping, no multi-file awareness
(`sections/`, `references/`, `scripts/`, `templates/` are all dropped), and no MCP/CLI
import surface.

Two gezel capabilities change the import calculus versus when the scanner was written:

- **The browser toolset.** gstack grades ~10 skills "engine-bound" because they drive its
  `$B` Chromium daemon. Gezel has its own browser surface (`@playwright/mcp` toolset,
  `run_playwright_script`, `browser_*` tools) — those skills are portable by *rewriting
  the engine calls to gezel's browser tools*, not blocked.
- **The global index.** The documents library is now semantically indexed
  (`search_docs`, global-index) — reference-pack skills finally have a native home that
  isn't a fake craftbook.

## Import candidates

Grading: EASY = prose procedure ports directly; MEDIUM = needs step-mapping plus checks
reproducible as declarative gates or sandboxed TS; engine notes inline. gstack's own
`openclaw/skills/*` ports (ceo-review, investigate, office-hours, retro) are prose-only,
preamble-free versions maintained upstream — use them as source where they exist.

### Wave 1 — prose-to-craftbook, catalog-worthy, EASY

| Skill | Why | Craftbook mapping |
|---|---|---|
| **office-hours** | The single best fit; serves non-technical users (idea diagnostic → design doc) | 6 forcing questions = steps with `ask_user_question` + STOP-per-question gates; terminal step writes the design doc (`deliverable: markdown-report`, contains/minBytes checks) |
| **investigate** | The gate exemplar: "no fixes without root cause" | Iron Law = activation gate between diagnose and fix steps; 4 phases map 1:1; scope-lock becomes a `requireChange` boundary note |
| **document-generate** | Non-technical writers; Diataxis docs from a codebase | Steps 0–9 map directly; per-quadrant deliverable gates; inline templates stay in step prompts |
| **plan-ceo-review** (then design/devex/eng) | Persona rubric reviews with modes | Passes = steps; 0–10 scorecard = a JSON artifact gated by `recordSchema`/`jsonPathEquals`; modes = `paramSchema`; the "Outside Voice" maps to `ask_specialist`/`consult_*` (native second opinion) |
| **spec** | Gated-phase discipline + a genuinely valuable TS gate | 5 strict phases = gated steps; the Phase 4.5 **fail-closed secret-redaction regex is a perfect sandboxed gate script**; gh-issue filing becomes an artifact/report step (or github toolset when installed) |

### Wave 2 — MEDIUM, needs mapping work or a toolset requirement

- **cso** — security audit; its grep sweeps map to `search_files`/`search_code` (more
  portable than it looks); daily-vs-comprehensive confidence gate = `paramSchema`.
- **design-consultation** — interview → DESIGN.md; font/color preview pages become
  workspace HTML deliverables rendered in gezel's preview pane (no `$D` binary needed).
- **qa-only / design-review / devex-review** — rewrite `$B` calls to gezel's browser
  tools; declare `toolsets: [{toolsetId: playwright…}]` via `CraftbookToolsetNeedSchema`.
- **retro** — git-analysis value; feasible as step prompts driving `run_git` plus a TS
  gate script for the arithmetic; developer-audience, lower priority.

### Guardrail pilot — careful / freeze / guard

Not procedures at all: PreToolUse interceptors (warn on `rm -rf`/`DROP TABLE`/force-push;
block edits outside a directory). **Gezel already has the landing surface**: craftbook
`hooks[]` is runtime-wired (the task snapshotter explicitly anticipates "community books
declaring a PreToolUse destructive-command guard" —
[tasks/manager.ts](../packages/service/src/tasks/manager.ts) ~106). The small shell logic
is trivially reproducible as sandboxed TS. This is both the closest 1:1 primitive match
and a user-facing safety feature ("careful mode") squarely in gezel's
simplify-AI-for-everyone soul.

### Reference packs — documents library, not craftbooks

`review/specialists/` (7 reviewer briefs), `qa/references/issue-taxonomy.md`,
`plan-devex-review/dx-hall-of-fame.md`, ETHOS-style docs → import into the documents
library with provenance frontmatter; they become globally searchable (`search_docs`) and
consultable mid-task. Forcing these into craftbooks would be shape-mismatch.

### Skip (engine/host-bound or redundant)

`browse`/`open-gstack-browser` (gezel has its own browser stack), `codex` (CLI wrapper),
`make-pdf`/`diagram` (value is a Chromium+TS pipeline — revisit as gezel-native features,
not imports), `ios-*` (device lab), `setup-gbrain`/`sync-gbrain`/`learn` (gezel memory is
native), `plan-tune`/`setup-deploy`/`gstack-upgrade` (host-specific), root router
(`suggest_craftbook` already is one), `scrape`/`skillify` (conceptual parity exists via
`export_task_craftbook` + inline scripts).

## Style → surface matrix (the systemic view)

| gstack shape | Example | Gezel surface | Status |
|---|---|---|---|
| Procedural workflow | investigate, office-hours | Craftbook steps + gates | native; importer lacks headings→steps |
| Always-on guardrail | careful, freeze | Craftbook `hooks[]` + TS script | wired; no importer, no UI toggle |
| Reference/knowledge pack | review/specialists | Documents library (indexed) | native as of the indexing initiative; importer doesn't route to it |
| Persona reviewer | plan-ceo-review, cso | Gezel template (about.md) + `defaultAssignee`/`suggestedRole` on the book | native; importer doesn't mint personas |
| Rubric/scorecard gate | design-review 0–10, health | JSON scorecard artifact + `recordSchema`/`jsonPathEquals` gate | native (V2 gates) |
| Modes/tiers | cso daily vs comprehensive, qa tiers | `paramSchema` | native |
| Second-opinion protocol | Outside Voice, benchmark-models | `ask_specialist`/`ask_gezel`/`consult_*` | native; convention only |
| Meta-orchestration | autoplan | Step prompts calling `invoke_craftbook`/`spawn_task_instances` + child tasks | plumbing exists; no structural sub-book step |
| Command wrapper | browse, codex | Toolset manifest (MCP server) + thin usage craftbook | native (toolsets) |
| Recurring monitor | canary | Triggers + scheduled tasks | partial (triggers exist; scheduling tied to autostart) |
| Progressive disclosure | sections/ + manifest | Step-scoped prompts + documents for heavy sections | convention |
| Config/preference manager | plan-tune, learn | Gezel config/memory | native, no import needed |

## Systemic recommendations

1. **Build the catalog-grade importer** (the big one). Today's scanner produces one-step
   project books. A real `import skill` path (MCP tool + CLI) should: map
   `## Phase N`/`## Step N` headings to steps; recognize the gate idioms (Iron Law → 
   activation gate, "STOP and wait" → ask_user_question gate, scorecards → recordSchema
   gate); route `references/`+`sections/` to the documents library with provenance;
   translate more than the first shell block; and emit a reviewable CraftbookDoc (JSON)
   rather than writing silently — reusing the pending-imports approval flow.
2. **Wire the guardrail pilot end-to-end**: import careful+freeze as a bundled
   "careful-mode" craftbook (hooks + sandboxed TS checks), and consider surfacing it as a
   Settings toggle rather than requiring users to know it's a craftbook.
3. **Persona-bundle imports**: when a skill is persona-shaped, the importer should mint a
   gezel-template (about.md diet rules apply) *plus* the craftbook that assigns steps to
   that role — the pair is the import unit, not the book alone.
4. **Documents-library import lane** with provenance + update detection (same hash-ledger
   idempotency the craftbook sync uses).
5. **Sub-craftbook step** (later): autoplan-class meta-books want a structural "run book
   X as a child task, gate on its completion" step kind; the plumbing
   (`spawn_task_instances`, `list_task_children`) exists — this is schema + runtime glue,
   not new machinery. Convention (step prompt says "invoke X") is the cheap interim.
6. **Don't add an engine-wrapper lane**: skills whose value is an external binary map to
   toolsets; keep that boundary.

## Suggested execution order

Wave 1 (5 books) hand-authored as catalog craftbook-templates using the V2 doc format —
they double as the fixture set that tells us what the importer must handle. Guardrail
pilot next (validates hooks + TS translation). Then the importer (rec 1) built against
those known-good targets, followed by Wave 2 through it.
