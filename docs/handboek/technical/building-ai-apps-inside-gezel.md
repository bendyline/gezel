---
id: building-ai-apps-inside-gezel
title: Building AI Apps inside Gezel
order: 10
summary: Combine a project type, dashboard, crew, craftbooks, scripts, and data into one reusable Gezel experience.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Building AI Apps inside Gezel

An AI App is a reusable experience that runs *inside* Gezel: a tailored project, a purpose-built crew, repeatable craftbooks, scripts, data, and an optional interactive dashboard. A language trainer, research room, board game, or client-service workspace can all use the same underlying pieces while feeling like a distinct application.

The project type is the composition root and installer. Public AI Apps arrive through the [Gezel Gilde project-type collection](https://gezelgilde.com/toolsets/#project-types); private or experimental apps travel as `.gezapp` packages. Both start life as the same thing: a source folder you can build with the command line, by hand, or with an AI agent — this article is the guide to that folder.

An AI App is different from a connected app. A connected app runs in its own process and interface and reaches Gezel through `@bendyline/gezel-app-sdk`. See [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md) when that is what you are building.

## Build one in five minutes

The command line owns the whole loop — scaffold, edit, validate, pack, install, apply — and none of it needs the service running:

```bash
gezel app new my-app --with-page     # a complete, working source folder
cd my-app
# edit items/ — the role's about.md and the version manifest are the heart
gezel app validate .                 # every finding at once; --json for tooling
gezel app pack .                     # -> my-app-1.0.0.gezapp
gezel app add my-app-1.0.0.gezapp --yes
cd ~/the/folder/for/it && gezel app apply my-app
```

`apply` outfits the current folder as a project: it creates the crew from the embedded role templates, installs craftbooks and scripts, seeds the data files, and pins the Output page. From there, iterate — edit the source, `validate`, `pack`, `add` (an upgrade), and `apply --refresh`; `gezel app status` reports seed drift, and `gezel app serve` shares the finished page (and optional visitor chat) as a mini-site.

Three worked samples of graded size live in [examples/apps](https://github.com/bendyline/gezel/tree/main/examples/apps) — `example-journal` (the minimal shape), `example-habit-tracker` (state, tools, a live page), and `example-reading-circle` (a crew, craftbooks, schedules, dependencies). Copying the smallest one that fits beats starting empty.

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

Craftbooks also have two homes. A procedure private to this app lives embedded at `versions/<v>/craftbooks/<id>.json` — it ships inside the project type and appears in no catalog. A reusable procedure is its own `craftbook-templates/` item with a `craftbook.json` and a `test.json` eval sidecar — or simply a reference to an existing recipe in the [Gilde craftbook collection](https://gezelgilde.com/craftbooks/). The version manifest's `craftbooks` list references both by id, and an embedded document wins over a catalog item with the same id.

## The parts of an AI App

| Part | What it contributes |
| --- | --- |
| Project type | Identity, version, setup params, project templates, crew roster, and references to every other part |
| Gezel role templates | Each crew member's name, role, and `about.md` working character; one entry can be the voorman, or a solo type presents its one gezel under a custom `leadLabel`. Browse the [Gilde role collection](https://gezelgilde.com/roles/) before writing a new one |
| Craftbooks | Repeatable procedures installed into each project — embedded (type-private) or referenced catalog items |
| Scripts and tools | Capability-declared TypeScript run in Gezel's sandbox; a `tools` entry exposes a script as a schema-validated tool for a gezel or the page |
| Output page | A read-limited HTML/CSS/JS experience pinned into the project's Output tab |
| Data | Ordinary JSON, Markdown, and media files seeded into the workspace or artifacts |
| Schedules | Consent-gated scheduled or Night Shift craftbook runs |
| Toolsets | Catalog references for capabilities the project needs or suggests; toolset code is never embedded |

Nothing installs merely because Gezel detects a suitable project type: adoption is explicit, params render as a form and substitute into `nameTemplate`, the about/mission templates, and seed files, and toolsets and schedules remain subject to consent and security policy.

## Scripts, tools, and the Output page

Each script declares its capabilities, inputs, outputs, and whether it is an action or gate through `@bendyline/gezel-sdk`; the [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md) article covers that contract. Adoption copies the scripts into the project with provenance.

A `tools` entry gives a script a stable name, a JSON Schema `inputs` object validated before every run, and static `bind` values so several narrow tools can share one script without letting the caller replace the bound operation. A tool listed in `pages.tools` is page-only — kept off the model's roster — and can carry a `reaction` that summons a named gezel when the page invokes it, with the tool output interpolated into the reaction prompt.

The Output page runs in a sandbox and codes against the injected `window.gezel` API (typed definitions in `@bendyline/gezel-sdk/page`; set `pages.api` to `1`). Every readable file must appear in `pages.reads` and every callable tool in `pages.tools` — there is deliberately no raw page write API, so state changes flow through declared tools and stay auditable:

```js
const records = await gezel.data.read('records.json', { as: 'json' });
gezel.data.watch('records.json', render);
const { output } = await gezel.tools.invoke('add_record', { title: 'First review' });
```

Pages must work in both themes: declare `color-scheme: light dark`, drive colors through variables, and override them in an `@media (prefers-color-scheme: dark)` block — the validator warns when a page hardcodes light colors.

## Validate, pack, and share

`gezel app validate` collects every finding at once, in layers: folder shape and portable paths, every manifest and craftbook parsed with the same schemas the runtime uses, the exact verification an install runs (hashes, reference closure, dependency locks), referenced files and craftbook step graphs, script diagnostics from the real TypeScript compiler, page syntax and theme checks, and offline dependency availability. Errors mean install or adoption would break; warnings are advisory.

`gezel app pack` derives the manifest and produces the `.gezapp` — a renamed zip holding the root manifest and the `items/` tree, with a SHA-256 digest per embedded item. Exactly one entry project type travels, along with every role and craftbook template it references; toolsets, connectors, and models stay outside as an exact-version dependency lock — models remain separate catalog choices (browse the [Gilde model collection](https://gezelgilde.com/models/)) and are never bundled into an app. Version 1 packages are explicitly `unsigned` — hashes detect corruption, not authorship, so install only from sources you trust.

Installation is `gezel app add`: a first pass previews publisher, contents, compatibility, conflicts, and missing dependencies without writing anything; the confirmed pass installs atomically under `~/.gezel/ai-apps/`, records a receipt, and mounts the app as one catalog source. Import never executes package contents, and `gezel app list/show/enable/disable/remove/update` manage the installed lifecycle.

For public distribution, contribute the same `items/` content to the [Gilde repository](https://github.com/bendyline/gilde) — the catalog and a `.gezapp` share the layout, so a private app can graduate to the public collection without restructuring.

## For AI agents building apps

An AI agent building an app should work the same loop a person does, with the machine-readable ends of it:

- `gezel app schemas --out schemas` (or `--json`) — the JSON Schemas for every catalog content file plus the packed and source gezapp manifests, rendered live from the running build so they can never be stale.
- `gezel app validate <folder> --json` — the findings list with stable rule ids; fix and re-run until `ok` is true, then `pack`.
- [examples/apps](https://github.com/bendyline/gezel/tree/main/examples/apps) — three complete source folders of graded complexity, each kept working against the real service by the repository's test suite.
- `gezel app new` — a guaranteed-valid starting shape when no sample is at hand.

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
