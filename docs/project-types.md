# Custom project types

A **project type** outfits a project for a particular kind of work: it bundles a gezel
role template, craftbooks, sandboxed scripts and script-backed tools, suggested toolsets,
seed data, scheduled work, and an Output page (dashboard) into one installable,
shareable unit. "Learn Spanish" is a project *practicing* the Language Trainer project
type; the type is the reusable kit, the project is the user's instance of it.

**Architectural thesis: a project type is a composition manifest plus an instantiation
engine — not a plugin platform.** Every capability it composes already exists as a
proven primitive (catalog items, craftbooks, SDK scripts, the preview host, cron tasks).
Three new primitives are introduced (script-backed tools, a project toolset scope,
pinned Output pages) and one package format (`.gezapp`). No new code-execution surface
is added beyond what already exists.

Vocabulary: **project type** names the composition and instantiation primitive. **AI
App** names the complete customer-facing experience and its `.gezapp` package. A
**connected app** remains the separate external-process surface (`/v1/apps`,
`@bendyline/gezel-app-sdk`).

This document is the spec. It records the manifest shape, instantiation semantics, the
copy-vs-reference rule, the security posture for sharing, and the `.gezapp` package
format. Implementation lands in phases (see the end of this doc).

## Relationship to what exists today

- The **taxonomy** ([packages/core/src/project-types/taxonomy.ts](../packages/core/src/project-types/taxonomy.ts))
  stays as the *detection layer*. A custom type may `extends` a taxonomy id to inherit
  its detection profile, `craftbookTags`, and gezel-role affinity.
- `project.json` today carries `projectTypeId` (user override) and `detectedProjectType`
  (auto-detected). This grows into full provenance: `projectType: {id, version, source,
  params, icon}`. `resolveProjectTypeId` keeps working for existing consumers.
- The **email pipeline** ([packages/service/src/mail/](../packages/service/src/mail/))
  stays native service code. It gets *wrapped* by a bundled type manifest so the New
  Project gallery presents one mental model — it is not retrofitted into the manifest
  system. Same for the github/folder creation kinds.

## The manifest

New catalog kind `project-type`, using the standard gilde item layout — identical to
`gezel-templates/` and `craftbook-templates/`:

```
data/project-types/{shard}/{id}/
├── manifest.json              identity: schemaVersion, id, name, description, tags,
│                              category?, icon?, maintainer, logo?, yankedVersions,
│                              minSupportedVersion?, kind: 'project-type'
└── versions/{semver}/
    ├── manifest.json          composition payload (below)
    ├── about.md, mission.md   param-templated project about/mission
    ├── pages/                 Output page tree (dashboard)
    ├── scripts/               SDK scripts
    └── craftbooks/            embedded craftbook documents
```

The identity `category` places the type in the New Project gallery's category
rail (`ProjectTypeCategorySchema` in core: `general | code | communication |
creative | writing | growth | game | data | home | money | events | other`). It
lives on the identity — taxonomy is stable across versions — and is optional:
undeclared types fall back to a small keyword heuristic in the UI, then to
`other`. A category only appears in the rail once at least one type claims it,
so shipping a type with a new category lights that rail entry up with no UI
changes.

When the identity `description` names a Dutch gezel role, gloss it in quotes on
first mention — `A calm Penningmeester ("treasurer") keeps the ledger` — so the
gallery card explains itself to someone who has never met the role. The Dutch
name carries the character; the gloss carries the meaning. Gezel-template
descriptions don't repeat their own card's name, so they need no gloss — they
lead with plain English instead.

### Maker's marks

Every project type has a small monochrome **maker's mark**. It is the type's
durable iconographic identity and is deliberately separate from `logo`: a logo
may be richer catalog artwork, while a mark must remain legible at 16–24px,
follow `currentColor`, and sit naturally in Gezel's paper/wood palette. Marks
come from the finite `ProjectIconIdSchema` vocabulary in
`packages/core/src/project-icons.ts`; examples include `code` (curly braces),
`quill`, `palette`, `server`, `book`, `meal`, and `plane`.

An identity manifest may declare one directly:

```jsonc
{
  "kind": "project-type",
  "id": "api-workshop",
  "category": "code",
  "icon": "server"
}
```

If it does not, Gezel deterministically infers a mark from the type id, tags,
taxonomy base, and category. On adoption the resolved mark is stamped into the
project-type provenance, so project lists do not need a catalog lookup. Project
instances follow one inheritance rule:

`project.icon` override → applied type mark → explicit/detected taxonomy mark →
connected-folder affordance → general `sheet`.

The optional project override is a maker's-mark id today. Future generated
instance artwork can layer over this fallback without changing type manifests
or making old projects lose their recognizable mark.

Version manifest (composition payload):

```jsonc
{
  "extends": "content-writing",            // optional taxonomy base: detection + craftbookTags
  "meesterManaged": false,                  // optional: false exempts progress check-ins
  "indexingEnabled": false,                 // optional: false skips workspace/code indexing
  "tabVisibility": {                        // optional UI defaults; omitted keys preserve project/default
    "overview": false,
    "tasks": false,
    "approvals": false,
    "workspace": false,
    "artifacts": false,
    "map": false
  },
  "params": { /* JSON-schema; same shape as craftbook paramSchema — e.g. "Which language?" */ },
  "nameTemplate": "{{language}} Language Trainer", // optional inline, user-overridable suggestion
  "aboutTemplate": "about.md",
  "missionTemplate": "mission.md",
  "gezels": [{ "templateId": "language-trainer", "voorman": true }],  // gilde ref or embedded
  "toolsets": [{ "id": "...", "need": "required" | "suggested", "autoAllow": ["tool_a"] }],
  "craftbooks": ["daily-lesson", "weekly-review"],   // embedded; installed project-local
  "scripts": { "progress-store.ts": "…" },           // SDK scripts; installed with provenance markers
  "tools": [                                          // script-backed tools (new primitive)
    { "name": "advance_level", "description": "…", "script": "progress-store", "inputs": { },
      "bind": { "action": "advance" },                 // static args merged over the caller's input
      "reaction": { "gezel": "…", "prompt": "…" } },   // page-invoke only: summon a gezel turn
  ],
  "pages": { "entry": "dashboard/index.html",         // pinned Output page (new primitive)
             "reads": [ { "source": "workspace", "path": "…" } ],
             "tools": ["user_move"] },                 // page-ONLY invokable subset of tools[]
  "schedules": [{ "cron": "0 18 * * *", "craftbook": "daily-lesson", "consent": "ask" }],
  //  … or window-driven night work instead of cron: a `runMode: "night-shift"`
  //  schedule needs no cron — the host runs inside the user's Night Shift
  //  window, at most once per night, and surfaces in the same suggested-work
  //  toggles as role-suggested craftbooks.
  "workspaceSeed": ["progress.json"]                  // initial data files, param-templated
}
```

Sources compose the same way as other kinds: **local → bundled → community**, with the
local source at `~/.gezel/project-types/` mirroring the local craftbook-templates
layout. Toolset entries are catalog *references* (id + optional sha-pinned source) —
a type never embeds toolset code.

`nameTemplate` is an inline project-name suggestion rendered from the same params as
the content templates. The New Project dialog keeps it current while the user changes
those params, but stops replacing the name as soon as the user edits it. Types without
one fall back to a readable combination of their first scalar params and type name.

`meesterManaged` is an optional project default for ambient Meester progress check-ins.
When explicitly set, adoption maps it to the project's `nudgeConfig.enabled` setting;
`false` is appropriate for long-running ambient projects that should not receive periodic
status checks simply because they remain active. When omitted, adoption preserves the
project's existing setting and its normal inheritance from the global default.

`indexingEnabled` is an optional project default for the workspace index. `false` skips
structural discovery, code/document intelligence, search enrichment, maps, summaries,
and reviews for that project. It is intended for lightweight stateful experiences such
as checkers, chess, Go, language practice, or a chat room, where the workspace is a few
small data files rather than a body of work that benefits from code intelligence.
Omission preserves the project's existing choice and defaults to enabled. This switch
does not affect chat/session history, memories, or the shared document index, and the
user can override it later in Project Settings.

`tabVisibility` is an optional set of defaults for the supporting project tabs. Omitted
keys preserve the existing project choice or historical UI default (including Map's
project-type-aware default). Adoption merges declared keys over any existing project
choices; the user can change them later in Project Settings. Chat and Settings are
permanent entry points, while Output remains capability-driven by the presence of a
previewable page.

## Crew affinity

There are two complementary sources of crew intent:

- A catalog project type's `gezels[]` is its concrete default crew. Those gezels are
  created or attached when the user explicitly adopts the type.
- A taxonomy project's `gezelRoles` describes broader affinity. Its `default` tier is
  the core crew normally expected for that kind of work; `suggested` is the extended
  specialist bench. Each entry references a gezel-template id and carries a short,
  project-specific reason.

The Add a Gezel dialog combines both role tiers with the global workshop: when a
matching gezel already exists it recommends that person, otherwise it recommends
creating the corresponding role. Auto-detection never adds a gezel by itself. That
would turn a deterministic classifier into a surprising mutation; detected affinity
remains advice until the user chooses it.

## Instantiation

`applyProjectType(project, typeId, params)` runs once, at explicit adoption (project
creation from the gallery, or applying a type to an existing project):

1. Stamp provenance on `project.json`: `projectType: {id, version, source, params}`.
2. Render `aboutTemplate` / `missionTemplate` with params into the project's about and
   mission documents.
3. Create or attach the gezel via the existing template-install path
   (`POST /gezel-template/:id/install`), set as voorman when declared.
4. Install scripts and craftbooks as **copies with provenance markers** — the same
   pattern craftbook script install uses ([packages/service/src/scripts/install.ts](../packages/service/src/scripts/install.ts)).
5. Seed workspace data files (param-templated).
6. Apply an explicitly declared `meesterManaged` value to the project's Meester
   progress-check setting, preserving its other nudge cadence overrides.
7. Apply an explicitly declared `indexingEnabled` value to the project's workspace
   indexing switch.
8. Apply explicitly declared `tabVisibility` defaults over the project's existing tab
   choices.
9. Register toolsets and schedules **through the existing consent gates — never
   silently**. Schedules are created disabled or consent-prompted per their `consent`
   field.

### Copy vs reference — one rule

- Content that becomes **user-editable state** is **copied** with provenance markers:
  scripts, craftbooks, about/mission, seed data. The user's project evolves freely;
  drift is detectable.
- Content that stays **type-owned** is **referenced** from the installed type version:
  pages, tool declarations, detection profile. Fixes ship by installing a new version.
- Upgrades reuse the gezel-template refresh pattern (provenance `id` + `version`):
  reinstall unmodified copies, flag modified ones for the user to reconcile.

## New primitives

### Script-backed tools ("script-tools")

A named tool on the session tool surface whose handler runs a declared SDK script via
`ScriptRunner` ([packages/service/src/scripts/runner.ts](../packages/service/src/scripts/runner.ts)).
Inputs are validated against the declared schema; capability policy applies exactly as
for any SDK script run. This replaces "ship your own MCP server" for the common case:
sandboxed, capability-declared, reviewable TypeScript, zero npm install. Craftbooks can
adopt the same mechanism independently of project types.

### Project toolset scope

A fourth toolset scope `{kind: 'project', projectId}` alongside gezel/shared/system
([packages/core/src/schemas/toolsets.ts](../packages/core/src/schemas/toolsets.ts)).
Sessions are already (gezel, project) pairs; the chat manager's scope gather adds the
project scope to the merge. A type's required toolsets install here so they don't
pollute every gezel. Craftbook toolset needs benefit from the same scope.

### Pinned Output pages

A third preview source serves the installed type version's `pages/` tree read-only,
with the same path-safety guards as the existing sources
([packages/service/src/http/routes/preview.ts](../packages/service/src/http/routes/preview.ts)).
The first-party UI mints a short-lived, project/path-bound capability before loading
any preview; raw project paths are not public routes. The manifest pin overrides
`ProjectOutputPane`'s auto-ranker. A type page that needs dashboard data declares its
read-only cross-source paths in `pages.reads`; the service folds only those trusted
manifest scopes into the capability. The preview surface stays read-only; all writes
go through scripts/tools.

### Pages follow the app's theme through `prefers-color-scheme`

A page renders in the preview iframe, which is a **null-origin sandboxed
document**: gezel's CSS variables never reach it, a `color-scheme` on the frame
element does not cross the sandbox boundary (measured), and the `window.gezel`
theme message only reaches pages that opted into the page API. What does cross
is the browser's own colour-scheme preference, so the desktop shell pushes the
user's Light/Dark/System choice into `nativeTheme.themeSource`
([main.ts](../packages/app/src/main.ts), fed from `applyThemePref` in
[theme.ts](../packages/ui/src/theme.ts)).

That makes the ordinary media query the contract, and every page must honour
it — a page that ships only light colours becomes a glaring white slab down the
side of a dark workshop:

```css
:root { color-scheme: light dark; --bg: #faf7f2; --card: #fff; --ink: #2b2620; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1a17; --card: #262320; --ink: #efe9e0; }
}
```

Two rules keep it working: declare `color-scheme: light dark` so form controls
and scrollbars follow too, and drive every colour through the variables rather
than hardcoding `#fff` in a component rule — a literal in a card background
survives the media query and stays light. Pages on the v1 API may additionally
read the pushed theme for finer control, but the media query stays the floor.
Note where the push does not reach: opened in a real browser ("Open in
browser"), or served to the web UI, there is no Electron process to move the
preference, so the page follows the operating system rather than the gezel
setting. That is the honest ceiling of this mechanism, and the reason pages are
asked to honour the ordinary media query rather than a gezel-specific hook.

### The Output Pane API (`window.gezel`) — v1

New pages should be authored against the injected, versioned page API
documented in [docs/output-pane-api.md](output-pane-api.md): the daemon
splices a `window.gezel` shim into every served type-page HTML response
with a server-authoritative bootstrap (identity, adoption params, declared
tool names). Pages get `gezel.tools.invoke` (the same declared-script-tool
funnel as below, plus server-side validation of the tool's declared
`inputs` schema), `gezel.data.read/list/watch` (relayed through the
first-party `page-read` route — scopes re-derived per request from
`pages.reads`, no more capability-expiry juggling), `gezel.data.url` for
media, live theme, and mode detection (embedded / browser / demo). Mark
such pages with `pages.api: 1` in the manifest. The v0 wire protocol below
remains supported forever for shipped page versions.

### Page-invoke bridge and reactions (v0 wire protocol)

Interactive pages write through **declared script-tools**, never raw endpoints. The
manifest lists a page-ONLY subset of `tools[]` in `pages.tools`; those names are
excluded from the session's model tool surface (a checkers gezel must never see
`user_move` — a tool needed on both surfaces declares two names sharing one
script + bind). The sandboxed page's sole channel is `postMessage` to its
first-party parent:

- Page → parent: `{ __gezelPageInvoke: true, id, tool, input }`; parent → page:
  `{ __gezelPageResult: true, id, ok, output, error?, reaction? }`. Pages also send
  `{ __gezelPageRefresh: true }` when their capability expires (the parent re-mints
  and reloads). The ~20-line `gezelPage` helper (see the checkers/flashcards board
  pages) wraps correlation ids and a 45 s timeout; when there is no parent ("Open
  in browser"), `invoke` rejects and pages render a read-only notice.
- The parent ([HtmlPreviewFrame](../packages/ui/src/components/HtmlPreviewFrame.tsx))
  fast-fails names outside the manifest subset, then calls
  `POST /api/projects/:id/page-invoke` — first-party-only (root/ui), which
  re-derives the allowlist from the trusted manifest, merges the tool's `bind`
  over the page's input, and runs the declared script through the standard
  sandboxed pipeline with the `page` trigger kind (user-click-shaped like
  `manual`; the distinct kind is for audit and future policy). Rate-limited, 30 s
  script cap. Script runs — here and on `/scripts/run` — return **200 with
  `status: 'error'`** on script failure: a completed run report is not a server
  error, and 5xx bodies are deliberately opaqued server-wide.
- **Reactions** summon a gezel turn from a page action: a tool may declare
  `reaction: { gezel: <templateId>, prompt: <template> }`. Reactions fire ONLY on
  the page-invoke route — a model-called tool never reacts, and session tokens
  cannot reach the route, so a gezel can never summon itself. The target resolves
  from the project roster by `templateId` (voorman fallback), the prompt renders
  with `{{tool}}`, flattened `{{output.*}}` fields from the run, and the type's
  params, and lands as a system-authored `[<Type name> page]: …` seed in the
  target's live project session — background lane, coalescable (rapid events
  merge into one turn), engagement-gated, `page.reaction.sent` in history.

Platform note: sandboxed scripts deny network egress by design, and untrusted
scripts require an enforceable OS boundary for that deny (macOS Seatbelt; a
Linux systemd unit, which cannot carry the fd-3 RPC channel and so never
applies to script runs). Where no boundary exists — Windows, and Linux script
runs — the sandbox fails closed **except for provenance-trusted scripts**: a
project script whose bytes exactly equal the provenance header plus the
catalog-shipped project-type script body (verified per run against the
version the header names, `ScriptRunner.isProvenanceTrusted`), or the stdlib.
Those are first-party shipped bytes — the app's own trust tier — and run
under the remaining layers (permission-model fs scoping, no child processes,
JS network-API neutralizer). One edited byte drops a script back to the
fail-closed path. Net effect: bundled interactive types (Checkers, the
dashboards' page tools) work on every platform; user-edited and model-authored
scripts still execute only where the OS fence exists.

## Detection never triggers side effects

The deterministic detector may *offer* a custom type it recognizes (same as taxonomy
types today). Toolset installs, gezel creation, schedules, and seeding happen **only on
explicit adoption**. A detector match must never install or execute anything.

## Security posture for sharing

Importing a shared type is arbitrary-code-adjacent. The defenses reuse what exists:

- **Import review gate.** The first import call is a non-mutating preview that reports
  the publisher, entry project type, embedded items, external dependencies,
  compatibility, conflicts, and missing dependencies. Installation requires a second,
  explicitly confirmed call.
- **No embedded executables.** Toolsets install only by catalog reference with sha-256
  pinning — no embedded npm/MCP code in a bundle. Sandboxed SDK scripts are the only
  code a bundle may carry, and their declared capabilities are shown at review.
- **Nothing executes at import time.** Import = validate + copy into local sources.
  Execution happens only after adoption, inside the existing sandbox and consent gates.
- **Schedules are opt-in.** Created disabled or consent-prompted; never silently armed.
- Caveat to keep in mind when reviewing script capabilities: the sandbox is weakest on
  Windows/Linux (no OS-level wrapper; `node --permission` plus the JS net neutralizer).

## The `.gezapp` package

A `.gezapp` file is a **renamed zip with a root `manifest.json`**. It represents one
AI App rather than an arbitrary collection: exactly one entry project type at an exact
version, plus its referenced role and standalone craftbook templates.

```
my-app.gezapp  (zip, renamed)
├── manifest.json          app identity, publisher, entry, minimum Gezel version,
│                          signature status, embedded item hashes, exact dependencies
└── items/                 selected versions in the catalog on-disk layout
    ├── project-types/{id}/manifest.json + versions/{v}/…
    ├── gezel-templates/{id}/manifest.json + versions/{v}/…
    └── craftbook-templates/{id}/manifest.json + versions/{v}/…
```

Items reuse the catalog layout, but only the selected version travels. Import is:
bound and inspect the ZIP → validate schemas, paths, hashes, identities, reference
closure, compatibility, dependencies, and conflicts → preview → confirmed atomic mount
under `~/.gezel/ai-apps/{appId}/{version}/`. A receipt and active-app registry keep the
items attached to the package that supplied them. Catalog reads mount active AI Apps as
one dynamic source.

Toolsets, connectors, models, executables, and arbitrary npm code are not embedded.
The manifest locks referenced external dependencies to exact versions and a confirmed
install fails while a required dependency is unavailable. Import does not execute app
content. Version 1 packages explicitly declare `signature.status: "unsigned"`; their
hashes provide integrity, not publisher authenticity.

The companion feature is the **exporter**: "package this project as a custom project
type" — a Meester-assisted lift of a project's accumulated craftbooks, scripts, pages,
and gezel into a multi-item bundle. Users grow a project organically, then share it.

### Source folders (the authoring format)

The authoring form of a `.gezapp` is a **source folder**: a minimal `gezapp.json`
(`format: "gezel-ai-app-source"`, `schemaVersion: 1`, optional `entry` pin and
`publisher`) beside the same `items/` tree the archive carries. Everything heavy on the
packed manifest — the item list, per-item sha-256, the dependency lock,
`minGezelVersion`, `createdAt`, `signature` — is derived from the tree at pack time and
is a validation error when hand-written. Because layout equals archive layout, an
unzipped export is already a valid source folder (its stale packed `manifest.json` is
tolerated with a warning).

Scripts may be authored **inline** (the version manifest's `scripts` map — the form
models handle best) or as **sidecar files** at `versions/<v>/scripts/<name>.ts` (better
for people and typecheckers). `packGezappFromSource` folds sidecars into the map and
drops the files, so the shipped format is unchanged; the same name in both forms is an
error. Sidecar meta names must equal their filename stem, enforced with the craftbook
scripts-map rule.

Tooling lives on `@bendyline/gezel-service/gezapp`
([gezapp-source.ts](../packages/service/src/project-type/gezapp-source.ts)) and needs no
daemon: `validateGezappSource` (collect-all findings with stable rule ids; assembles the
in-memory package and runs the same `verifyGezapp` an install runs, then layers
authoring-only checks — referenced files, craftbook graphs via `craftbookFromDoc`,
script diagnostics, page syntax/theme, offline dependency availability),
`packGezappFromSource`, and `renderGezappAuthoringSchemaFiles` (every catalog schema
plus both gezapp manifests, rendered live from core Zod). The CLI surface is
`gezel app new | validate | pack | schemas`; worked samples live in
[examples/apps](../examples/apps/README.md) and are kept working by
`examples-apps.test.ts`.

## Deliberate exclusions

- **`plugin-sdk` stays dormant.** Script-tools supersede its stdin/stdout tool model;
  do not wire a loader for it.
- **The mail pipeline is not retrofitted** into the manifest system; it is wrapped by a
  bundled type manifest for gallery unity only.
- **No per-type CLI binaries.** Craftbook `command` tokens cover the CLI-shaped need.
- **No embedded MCP/npm code in bundles** (v1). Catalog refs with sha pins only.

## Rollout phases

1. **Schema + catalog/gilde plumbing** ✅ — `ProjectTypeManifest` in core schemas, catalog
   kind wired through `BundledSource` + a home-scoped `LocalCatalogSource`, bundled `email`
   manifest wrapping the native mail flow. The generic catalog routes serve list/detail.
2. **Instantiation engine + creation UX** ✅ — `applyProjectType`
   ([apply.ts](../packages/service/src/project-type/apply.ts)), `projectType` provenance on
   `project.json`, catalog-driven New Project gallery with a squisq `JsonEditor` params form,
   `list_project_types` / `apply_project_type` / `start_project_from_type` MCP tools.
3. **Project toolset scope** ✅ — `{kind:'project',projectId}` scope; the engine registers a
   type's `http-mcp` toolsets on adoption. Named script-tool aliases ✅ — the chat manager
   resolves the applied type's `tools[]` at session build and passes them to gezel-mcp via
   `GEZEL_SCRIPT_TOOLS`; each registers as a real named tool (with optional static `bind`
   args) dispatching through the `run_script` pipeline
   ([script-tools.ts](../packages/service/src/project-type/script-tools.ts) service-side,
   [script-tools.ts](../packages/mcp/src/script-tools.ts) server-side).
4. **Output surface** ✅ — `type` preview source (`/preview/type/:projectId/*`) + Output-pane
   pinning of a type's dashboard.
5. **Exemplars** ✅ — Language Trainer (workspace-oriented) and Design Scheme
   (artifacts-oriented, via `artifactsSeed`), both as shipped bundled entries with tests. The
   Language Trainer flow is verified end-to-end in the Electron app.
6. **Sharing** ✅ — `.gezapp` package
   ([gezapp.ts](../packages/service/src/project-type/gezapp.ts)): exact-version packing,
   per-item SHA-256 verification, dependency locking, reference-closure and conflict
   validation, a review-then-confirm atomic installer with receipts, and
   `export_ai_app` / `import_ai_app` MCP tools + HTTP endpoints. Those two tools live in the
   opt-in `ai-apps` builtin toolset group, which no role carries by default — packaging is a
   distribution chore the user drives from Settings or `gezel app`, not something a
   coordinator should be paying tool-schema prefill for on every turn.
7. **Craftbook install + schedules** ✅ — adoption copy-installs `craftbooks[]` into the
   project (embedded `craftbooks/<id>.json` docs first, catalog `craftbook-template` ids as
   fallback) with a provenance sidecar so re-apply skips unchanged copies and never clobbers
   a user-modified one ([craftbooks.ts](../packages/service/src/project-type/craftbooks.ts));
   `schedules[]` materialize as cron host tasks on the existing scheduler with `Task.origin`
   idempotency and the consent rule enforced — `auto` arms, `ask` creates paused plus a
   `schedule-approval` question card, `disabled` stays paused. Adoption-time SDK-store
   helpers for type scripts live in `@bendyline/gezel-sdk/stores` (logStore/rosterStore).
8. **Interactive pages** ✅ — the page↔host postMessage bridge (`pages.tools` +
   `POST /:id/page-invoke` + the HtmlPreviewFrame relay) and tool `reaction`s that
   summon a gezel turn from a page action. See "Page-invoke bridge and reactions"
   above. Exemplars: Checkers (`game` rail — the board IS the dashboard) and
   Flashcards (`growth` — review page + coaching reaction).
9. **Later** (not yet built) — upgrade/drift UI, community submissions, a UI
   download/upload affordance for `.gezapp` files (the flow is fully available to the
   Meester via MCP today), and a Windows denyNet boundary so scripts (and therefore
   interactive pages) run there.

### Exemplars (the forcing functions)

- **Language Trainer**: trainer gezel (converse in the target language, gently correct,
  track progress) + `progress.json` seed + `progress-store.ts` script + script-tools
  `record_session` / `advance_level` + a dashboard page reading progress via preview
  fetch + a `language` param.
- **Design Scheme**: palette/prototype script-tools writing into `artifacts/`, a gallery
  page over artifacts, a Designer-gilde gezel. Validates the artifacts-oriented output
  path.
- **Job Hunt**: the full-rails exemplar. The first two-gezel crew (Loopbaancoach voorman +
  Oefen-interviewer), an `application-store` script built on `@bendyline/gezel-sdk/stores`,
  four named script-tools with `bind` args, five copy-installed career craftbooks, a
  consent-gated Friday `weekly-pipeline-review` schedule, and a pipeline-board dashboard
  reading both seeded stores. Covered by
  [job-hunt.test.ts](../packages/service/src/project-type/job-hunt.test.ts), the Electron
  gallery e2e, and the `job-hunt-track` eval scenario.
- **Checkers**: the interactive-page exemplar (first `game`-rail entry). The Output pane
  IS the game: the page invokes `user_move`/`new_game` over the bridge, the `game-store`
  script is the single rules engine (selectable required/optional captures, multi-jumps,
  kings; it precomputes
  `legalMoves` into game.json for the page's highlights and rejects illegal `make_move`
  calls with the full legal list — the model's retry signal), and the reaction on
  `user_move` summons the Damspeler's turn with the fresh board. Rules are a
  sentinel-delimited pure-JS block unit-tested from the shipped manifest bytes. The
  Damspeler defaults to an opponent who does not volunteer hints; an opt-in Instructor
  style adds light teaching observations.
- **Flashcards**: the reactions-generalize proof (review page + Leitner `deck-store`;
  the `finish_session` reaction has the Studiemaat respond to the session's misses —
  coaching, not turn-taking).
