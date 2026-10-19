---
id: building-ai-apps-inside-gezel
title: Building AI Apps inside Gezel
order: 11
summary: Combine a project type, dashboard, crew, craftbooks, scripts, and data into one reusable Gezel experience.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Building AI Apps inside Gezel

File-oriented apps should reuse the [shared file card and file adder](gezel-page-apis.md#file-cards-and-adding-files).
Use explicit `pages.imports` destinations for uploads, alongside `pages.reads`
for browsing. The components work with plain HTML, inherit shared typography,
and include an in-memory standalone demo adapter. Test both demo and embedded
flows, including write denial, partial failures and resetting demo state.

An AI App is a reusable experience that runs *inside* Gezel: a tailored project, a purpose-built crew, repeatable craftbooks, scripts, data, and an optional interactive dashboard. A language trainer, research room, board game, or client-service workspace can all use the same underlying pieces while feeling like a distinct application.

"Gezel app" and "AI App" name that experience. The **project type** is its reusable composition and setup recipe; the **project** is one person's instance. You can build a useful app with only a page and a folder, then add a gezel or a craftbook when the work calls for one. You do not need every component in every app.

For the interface, read [Using the Gezel page APIs](gezel-page-apis.md) and the [app page style guide](gezel-app-page-style-guide.md). The complete [page API reference](https://github.com/bendyline/gezel/blob/main/docs/output-pane-api.md) and [project-type specification](https://github.com/bendyline/gezel/blob/main/docs/project-types.md) provide the precise runtime contracts. These three Handboek guides are the starting path for people and AI agents building an app.

The project type is the composition root and installer. Public AI Apps arrive through the [project-type collection](https://gezel.com/docs/project-types-index/); private or experimental apps travel as `.gezapp` packages. Both start life as the same thing: a source folder you can build with the command line, by hand, or with an AI agent — this article is the guide to that folder.

An AI App is different from a connected app. A connected app runs in its own process and interface and reaches Gezel through `@bendyline/gezel-app-sdk`. See [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md) when that is what you are building.

## Build one in five minutes

Scaffolding, schema export, validation, and packing work without a running service. Installation and adoption use the Gezel daemon. Start with a disposable project folder while developing an app that writes data:

```bash
gezel app new my-app --with-page     # a minimal source folder that validates
cd my-app
gezel app schemas --out schemas     # the exact schemas this CLI understands
# edit items/ — the role's about.md and the version manifest are the heart
gezel app validate .                 # every finding at once; --json for tooling
gezel app pack .                     # -> my-app-1.0.0.gezapp
gezel app add my-app-1.0.0.gezapp     # review and confirm the installation
cd ~/the/folder/for/it && gezel app apply my-app
```

`apply` outfits the current folder as a project: it creates the crew from the embedded role templates, installs craftbooks and scripts, seeds the data files, and pins the Output page. From there, iterate — edit the source, `validate`, `pack`, `add` (an upgrade), and `apply --refresh`; `gezel app status` reports seed drift, and `gezel app serve` shares the finished page (and optional visitor chat) as a mini-site.

The `--with-page` scaffold includes a working records page. Run `gezel app demo . --out ../my-app-demo` and open the generated `pages/dashboard/index.html` for a standalone demo with resettable, in-memory sample data. The exporter supplies the shared bootstrap, components and fonts; app source does not bundle them. Inside Gezel it reads the real `data.json`, inherits the shared body/UI/heading fonts, follows host theme changes, and displays failures without switching to sample data. It includes loading, empty, pending, and retry states and cleans up its subscriptions. The browser preview is read-only; embedded and shared-site actions remain subject to host permissions.

The scaffold exposes `add_record` to the keeper and `page_add_record` to the page, both backed by the same `records-store` script. This distinction matters: a name in `pages.tools` is excluded from the gezel's roster. Keep separate names when both audiences need an action. The sample uses button and keyboard handlers because the page sandbox does not allow native form submissions. Extend this starting point using the style/API guides, and test your new actions against a real host as well as the demo.

Three worked samples of graded size live in [examples/apps](https://github.com/bendyline/gezel/tree/main/examples/apps) — `example-journal` (the minimal shape), `example-habit-tracker` (state, tools, a live page), and `example-reading-circle` (a crew, craftbooks, schedules, dependencies). Copying the smallest one that fits beats starting empty.

For shared page APIs, inspect the [Media Library](https://github.com/bendyline/gilde/tree/main/data/project-types/me/media-library) and [Data Analysis](https://github.com/bendyline/gilde/tree/main/data/project-types/da/data-analysis) types: they show folder discovery, file-viewer navigation, inherited typography, and indexed summaries without private transports. Use the API reference as the contract; a sample's implementation choices are not additional requirements.

## Or start from a working project

The other on-ramp is to prototype the experience as an ordinary project first: settle the crew roles in conversation, work through each craftbook, run the scripts by hand, and decide which files are durable state versus generated artifacts.

When the composition feels right, ask a gezel with the project-management tools to export the type applied to that project. Gezel writes a `.gezapp` into the project artifacts — and a `.gezapp` is a renamed zip of exactly the source layout below, so unzip it, drop in a small `gezapp.json`, and keep iterating with `validate` and `pack`.

## The source folder

A source folder is a `gezapp.json` beside an `items/` tree. The tree is the same layout the packed archive and the installed app use (items sharded by the first two characters of their id, identity separate from versioned content), which is why exports round-trip:

```text
my-app/
  gezapp.json                        the source manifest — small on purpose
  items/
    project-types/my/my-app/
      manifest.json                  identity: id, name, description, maintainer
      versions/1.0.0/
        manifest.json                the composition root (everything below hangs off it)
        about.md                     param-templated project context
        mission.md
        records.json                 seed data (workspaceSeed)
        scripts/
          record-store.ts            sidecar script — folded inline at pack
        craftbooks/
          review-records.json        type-private craftbook document
        pages/
          dashboard/index.html       the Output page
    gezel-templates/my/my-app-lead/
      manifest.json                  role identity (kind, id, name, role)
      versions/1.0.0/
        manifest.json                points at about.md
        about.md                     the role's working character
    craftbook-templates/my/my-app-review/
      manifest.json
      versions/1.0.0/
        craftbook.json               the reusable craftbook document
        test.json                    its eval sidecar
```

`gezapp.json` stays small on purpose — `format: "gezel-ai-app-source"`, `schemaVersion: 1`, and optionally an `entry` pin and a `publisher`. The item list, per-item SHA-256 hashes, the external dependency lock, `minGezelVersion`, and timestamps are all derived from the tree by `gezel app pack`; writing them by hand is a validation error, not a convention.

Scripts have two equal authoring forms. The version manifest's `scripts` map holds inline TypeScript strings — the form models author most reliably — and `versions/<v>/scripts/<name>.ts` holds the same scripts as real files, which people and typecheckers prefer. Pack folds sidecars into the map and drops the files, so the shipped app is byte-identical either way; defining one name in both forms is a validation error.

Craftbooks also have two homes. A procedure private to this app lives embedded at `versions/<v>/craftbooks/<id>.json` — it ships inside the project type and appears in no catalog. A reusable procedure is its own `craftbook-templates/` item with a `craftbook.json` and a `test.json` eval sidecar — or simply a reference to an existing recipe in the [craftbook collection](https://gezel.com/docs/craftbooks-index/). The version manifest's `craftbooks` list references both by id, and an embedded document wins over a catalog item with the same id.

## The parts of an AI App

| Part | What it contributes |
| --- | --- |
| Project type | Identity, version, setup params, project templates, crew roster, and references to every other part |
| Gezel role templates | Each crew member's name, role, and `about.md` working character; one entry can be the voorman, or a solo type presents its one gezel under a custom `leadLabel`. Browse the [role collection](https://gezel.com/docs/role-catalog/) before writing a new one |
| Craftbooks | Repeatable procedures installed into each project — embedded (type-private) or referenced catalog items |
| Scripts and tools | Capability-declared TypeScript run in Gezel's sandbox; a `tools` entry exposes a script as a schema-validated tool for a gezel or the page |
| Output page | A read-limited HTML/CSS/JS experience pinned into the project's Output tab |
| Data | Ordinary JSON, Markdown, and media files seeded into the workspace or artifacts |
| Schedules | Consent-gated scheduled or Night Shift craftbook runs |
| Toolsets | Catalog references for capabilities the project needs or suggests; toolset code is never embedded |

Nothing installs merely because Gezel detects a suitable project type: adoption is explicit, params render as a form and substitute into `nameTemplate`, the about/mission templates, and seed files, and toolsets and schedules remain subject to consent and security policy.

## Design the contract before building the interface

Write a short brief with five decisions: what the person does, which files are authoritative, which actions change them, where judgment needs a gezel, and what successful completion looks like. Map each decision to an existing part of the platform:

| Requirement | Put it here |
| --- | --- |
| Show, search, filter, or chart existing content | A type-owned page using the shared page APIs |
| Store a record or calculate a deterministic result | A capability-declared SDK script, exposed through a tool when needed |
| Make a judgment, explain, research, or converse | A focused gezel role with the tools it actually needs |
| Carry out a repeatable multi-step job | A craftbook with clear inputs, step ownership, and completion gates |
| Set up the experience | The project type's params, about/mission, crew, scripts, seeds, and project defaults |

Describe the data contract explicitly: path, workspace or artifacts, schema, owner, who writes it, and how the page learns about changes. Keep the source definition separate from user data. A gallery's HTML belongs to the catalog type; photos belong to the selected workspace. A generated report belongs in artifacts. The page should not create a second source of truth in local storage.

For a folder app such as Media Library or Data Analysis, declare a page with read access and no `workspaceSeed`. On desktop, New Project can attach an existing folder to a seedless type without copying or moving its originals. Typed creation accepts `workingDir`; types with workspace starter files use an internal workspace instead. This does not imply that CLI `app apply` is read-only: applying a stateful type can seed files in the folder you choose.

Start a new type with the smallest version manifest that fits. For a read-only folder app, a composition can be this small; its identity manifest still lives one level above `versions/`:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "releasedAt": "2026-10-19T00:00:00Z",
  "aboutTemplate": "about.md",
  "missionTemplate": "mission.md",
  "pages": {
    "entry": "index.html",
    "api": 1,
    "reads": [{ "source": "workspace", "path": ".", "subtree": true }]
  }
}
```

Add `params` only for choices the person needs to make. `nameTemplate`, `aboutTemplate`, and `missionTemplate` describe the instance; they are not replacements for a role's character. `tabVisibility` can simplify supporting tabs, `mode` and `leadLabel` shape a solo experience, and `meesterManaged` controls progress check-ins. Set `indexingEnabled: false` only when the app does not need indexed search or tables. Omitting a default preserves the existing project choice; a declaration can change it during adoption.

## Add a crew and repeatable work

A custom role is a `gezel-templates` item with an identity manifest, a version manifest, and an `about.md`. Reference its template id in `gezels[]`, marking the lead with `voorman: true` when appropriate. Reuse a suitable existing role before adding a new one. A role template defines expertise, temperament, working style, and boundaries; it does not define one person's project brief. Keep tool listings out of its prose because Gezel injects the actual available tools at runtime.

A custom craftbook turns a job into a sequence that can be checked. Define its input parameters, a valid `entryStepId`, unique step ids, the role responsible for each step, concrete outputs, and success gates. Use a script for calculation or mechanical file manipulation and a gezel for judgment. Do not ask a model to reconstruct data already available to a script. Use `{{task.dir}}` for task-owned outputs instead of inventing global paths. See [Craftbooks](../conceptual/craftbooks-overview.md), [the script SDK](writing-scripts-with-gezel-sdk.md), and the complete [Reading Circle sample](https://github.com/bendyline/gezel/tree/main/examples/apps/example-reading-circle) for a crew with both embedded and reusable craftbooks.

Validate craftbook documents against schemas exported by the installed CLI rather than guessing step or gate fields. Reusable catalog craftbooks carry a `test.json` sidecar; that sidecar is not proof the workflow has run successfully. Exercise a representative task and its gates. Schedules reference the craftbook id and should make their consent behavior explicit; start with `consent: "ask"` for work the person has not yet enabled.

## Choose public catalog or private package authoring

The app composition is the same in both cases; the authoring and release loops differ.

| Target | Source | Check and use it |
| --- | --- | --- |
| Private, experimental, or portable app | `gezapp.json` + `items/` | `gezel app validate`, `pack`, then install and apply against a test project |
| Public Gilde app | `gilde/data/<kind>/<shard>/<id>/` | Gilde's schema/content checks, page-demo checks, and local index build; then test with Gezel using that content root |

In the Gezel repository, public catalog content belongs in the sibling Gilde checkout, not in Gezel's old `data/` tree or installed dependencies. `GEZEL_GILDE_DATA_DIR` can select the checkout's `data/` directory for a development service. The normal application still uses its pinned catalog unless configured otherwise. A catalog change must be released and consumed before it appears in an ordinary installation.

The private source packer folds script sidecars into the version manifest. That preprocessing is specific to the source-package path: when authoring Gilde directly, follow its released-payload conventions and validators. Never hand-edit a released version; add a new version. Exported hashes, dependency locks, and catalog-root indexes are generated, not authored.

## Scripts, tools, and the Output page

Each script declares its capabilities, inputs, outputs, and whether it is an action or gate through `@bendyline/gezel-sdk`; the [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md) article covers that contract. Adoption copies the scripts into the project with provenance.

A `tools` entry gives a script a stable name, a JSON Schema `inputs` object validated before every run, and static `bind` values so several narrow tools can share one script without letting the caller replace the bound operation. A tool listed in `pages.tools` is page-only — kept off the model's roster — and can carry a `reaction` that summons a named gezel when the page invokes it, with the tool output interpolated into the reaction prompt.

The Output page runs in a sandbox and codes against the injected `window.gezel` API (typed definitions in `@bendyline/gezel-sdk/page`; set `pages.api` to `1`). Every readable file must appear in `pages.reads` and every callable tool in `pages.tools` — there is deliberately no raw page write API, so state changes flow through declared tools and stay auditable:

```js
async function refresh() {
  render(await gezel.data.read('records.json', { as: 'json' }));
}
const stop = gezel.data.watch('records.json', () => { void refresh().catch(showError); });
await refresh();
const { output } = await gezel.tools.invoke('add_record', { title: 'First review' });
window.addEventListener('pagehide', stop, { once: true });
```

Here `render` and `showError` are your UI functions. A watch reports that a file changed; it does not pass the file contents to `render`.

Use `gezel.data.list()` to discover files, `data.url()` for media, and `data.open()` to navigate to their existing Gezel renditions. Use `gezel.tables.list/describe/query` for permission-scoped summaries and charts over indexed data. These capabilities are shared infrastructure; keep them out of app-specific transports. See the [page API guide](gezel-page-apis.md) for host differences and failure states.

Pages inherit Gezel's local body/UI and heading fonts. They still define their own layout, color variables, control styles, and responsive behavior. Follow the [page style guide](gezel-app-page-style-guide.md), including both themes and system fallbacks for standalone demos.

## Validate, pack, and share

`gezel app validate` collects every finding at once, in layers: folder shape and portable paths, every manifest and craftbook parsed with the same schemas the runtime uses, the exact verification an install runs (hashes, reference closure, dependency locks), referenced files and craftbook step graphs, script diagnostics from the real TypeScript compiler, page syntax and theme checks, and offline dependency availability. Errors mean install or adoption would break; warnings are advisory.

`gezel app pack` derives the manifest and produces the `.gezapp` — a renamed zip holding the root manifest and the `items/` tree, with a SHA-256 digest per embedded item. Exactly one entry project type travels, along with every role and craftbook template it references; toolsets, connectors, and models stay outside as an exact-version dependency lock — models remain separate catalog choices (browse [every model](https://gezel.com/docs/model-catalog/)) and are never bundled into an app. Version 1 packages are explicitly `unsigned` — hashes detect corruption, not authorship, so install only from sources you trust.

Installation is `gezel app add`: a first pass previews publisher, contents, compatibility, conflicts, and missing dependencies without writing anything; the confirmed pass installs atomically under `~/.gezel/ai-apps/`, records a receipt, and mounts the app as one catalog source. Import never executes package contents, and `gezel app list/show/enable/disable/remove/update` manage the installed lifecycle.

For public distribution, contribute the same `items/` content to the [Gilde repository](https://github.com/bendyline/gilde) — the catalog and a `.gezapp` share the layout, so a private app can graduate to the public collection without restructuring.

## For AI agents building apps

An AI agent building an app should work the same loop a person does, with the machine-readable ends of it:

- `gezel app schemas --out schemas` (or `--json`) — the JSON Schemas for every catalog content file plus the packed and source gezapp manifests, rendered live from the running build so they can never be stale.
- `gezel app validate <folder> --json` — the findings list with stable rule ids; fix and re-run until `ok` is true, then `pack`.
- [examples/apps](https://github.com/bendyline/gezel/tree/main/examples/apps) — three complete source folders of graded complexity, each kept working against the real service by the repository's test suite.
- `gezel app new` — a guaranteed-valid starting shape when no sample is at hand.

Use this brief when asking an LLM to build an app:

> Build a Gezel app for [person and task]. Read Building AI Apps inside Gezel, Using the Gezel page APIs, and the Gezel app page style guide first. Choose public Gilde content or a private `.gezapp` source folder. State the user flow, authoritative files and schemas, read/write permissions, crew responsibilities, and completion criteria. Reuse existing APIs, roles, and craftbooks. Implement only the components this app needs. Use shared fonts and `window.gezel`, deterministic scripts for actions, and gated craftbooks for repeatable work. Include labeled standalone samples where required, but never use samples after a live failure. Validate against the installed schemas, test the main flow in a real host, and report supported modes, remaining limitations, and the release/install step needed to use it.

Before handing over the app:

1. Validate the source or Gilde payload, including every referenced role, craftbook, script, page, and seed. Keep generated and authored files distinct.
2. Create or apply the app in an isolated test project. Verify the actual folder binding, permission denials, and every state-changing action. A folder explorer must leave originals unchanged.
3. Exercise the main craftbook with representative inputs and confirm its outputs and gates. Check disabled/consent-required schedules without silently arming them.
4. Test the page's live and standalone flows, light/dark themes, keyboard navigation, narrow layout, empty content, unavailable capabilities, and failed actions. Dispose watches and media players.
5. If upgrading, check user-modified content and seed drift. Document any unsupported migration or reconciliation rather than overwriting it as a convenience.
6. Report what shipped, what was tested, which host modes are supported, and whether the normal app consumes the new catalog version yet.

## What still needs improvement

The authoring loop above is real, but the surrounding lifecycle still has gaps:

| Gap | What is needed |
| --- | --- |
| Project-to-app export | Export packages the catalog definition; a diff-and-review flow that turns organic project changes (edited scripts, new craftbooks, a redesigned page) into a new version does not exist yet |
| Import interface | The desktop app still routes import through project artifacts and gezel tools; file picking, bundle review, and conflict handling belong in the UI the way the CLI already has them |
| Updates and drift | `gezel app status` reports per-seed drift and `apply` preserves user-modified seeds, but scripts still overwrite on upgrade and there is no three-way reconcile view |
| Schema evolution | App data-version declarations, migrations, backup, and rollback for custom records |
| Dashboard surface | First-class page templates, an in-app development preview, diagnostics, and possibly more than one app-owned project tab |
| Craftbook test harness | `test.json` sidecars are validated at authoring time, but the eval harness does not yet run an installed app's craftbook tests |
| Signing and registries | v1 signature status is `unsigned`; a signing story and a private registry path alongside public Gilde contributions |

Until those close, treat the source folder as the canonical form of an AI App: Gilde for public distribution, `.gezapp` for controlled sharing, and ordinary projects for prototypes whose composition is still changing.
