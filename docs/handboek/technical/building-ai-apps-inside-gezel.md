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

The project type is the composition root and installer. Public AI Apps normally arrive through the [Gezel Gilde project-type collection](https://gezelgilde.com/toolsets/#project-types); private or experimental apps can be shared as `.gezapp` packages.

An AI App is different from a connected app. A connected app runs in its own process and interface and reaches Gezel through `@bendyline/gezel-app-sdk`. See [Building connected apps with gezel-app-sdk](building-connected-apps-with-gezel-app-sdk.md) when that is what you are building.

## The parts of an AI App

| Part | What it contributes today |
| --- | --- |
| Project type | The identity, version, setup parameters, project templates, crew roster, tab defaults, and references to every other part |
| Gezel role templates | The role name, description, `about.md` instructions, suggested tools, and optional tuning guidance for each crew member |
| Craftbooks | Repeatable procedures installed into each project; they may be private to the type or referenced from the [Gilde craftbook collection](https://gezelgilde.com/craftbooks/) |
| Scripts and tools | Capability-declared TypeScript run by Gezel's sandbox; a manifest can expose a script as a schema-validated tool for a gezel or dashboard |
| Output page | A read-limited HTML, CSS, and JavaScript experience pinned into the project's Output tab; one entry page can implement several views or routes |
| Data | JSON, Markdown, media, and other ordinary files seeded into the project workspace or artifacts and then read by scripts, gezels, and the page |
| Schedules | Consent-gated scheduled or Night Shift craftbook runs |
| Toolsets | Catalog references for capabilities the project needs or suggests; toolset code is not embedded in the project type |

The result is composition rather than a general plug-in runtime:

```text
Gilde project type or .gezapp package
                 ↓ explicit adoption
project + crew + craftbooks + scripts + data + Output page
                 ↓ ordinary use
chat, page actions, scheduled work, and editable project files
```

Nothing is installed merely because Gezel detects a suitable project type. Adoption is explicit, and toolsets and schedules remain subject to consent and security policy.

## Build one today

There is no AI App builder or `gezel app new` command yet. The supported public authoring path is source-first in the [Gilde repository](https://github.com/bendyline/gilde):

1. Prototype the experience as an ordinary project. Settle the crew roles, work through each craftbook, run the scripts by hand, and decide which files are durable state versus generated artifacts.
2. Give the composition a project-type id and version. Add separate role-template items for crew members whose instructions should be reusable or versioned.
3. Move default project context into `about.md` and `mission.md`, turn initial data into seed files, and place type-private craftbooks under the version's `craftbooks/` folder.
4. Put SDK script source in the version manifest's `scripts` map, expose only the narrow tools the gezels or page need, and declare every capability and input schema.
5. Build the Output page against `window.gezel`, declare its readable paths and callable tools, and test both light and dark themes.
6. From the Gilde checkout, run `npm run fix` and `npm run check`. When developing Gilde and Gezel side by side, run `pnpm link:gilde` from the Gezel checkout so the local daemon and tests see the edited catalog content.
7. Contribute the type to Gilde for normal distribution. After a type is resolvable by a Gezel installation, export a `.gezapp` for controlled private sharing.

This workflow is deliberately candid: the catalog files are the authoring surface today. The desktop app can use and share a finished type, but it cannot yet assemble those files from a prototype for you.

## The catalog layout

The source of a public AI App is a slice of the Gilde catalog. Items are sharded by the first two characters of their id and keep identity separate from versioned content:

```text
data/
  project-types/
    my/
      my-app/
        manifest.json
        versions/
          1.0.0/
            manifest.json
            about.md
            mission.md
            records.json
            craftbooks/
              review-records.json
            pages/
              dashboard/
                index.html
  gezel-templates/
    my/
      my-app-lead/
        manifest.json
        versions/
          1.0.0/
            manifest.json
            about.md
```

The root project-type manifest supplies stable identity:

```json
{
  "schemaVersion": 1,
  "kind": "project-type",
  "id": "my-app",
  "name": "My AI App",
  "description": "A focused workspace for reviewing records with a gezel.",
  "tags": ["review", "records"],
  "maintainer": { "name": "Your company" },
  "license": "MIT",
  "yankedVersions": []
}
```

The version manifest describes what adoption installs. This shortened example shows the main seams; script source is represented by a placeholder to keep it readable:

```json
{
  "schemaVersion": 1,
  "version": "1.0.0",
  "releasedAt": "2026-01-01T00:00:00Z",
  "params": {
    "type": "object",
    "properties": {
      "recordLabel": { "type": "string", "title": "What do you call a record?", "default": "case" }
    },
    "required": ["recordLabel"]
  },
  "nameTemplate": "{{recordLabel}} review",
  "aboutTemplate": "about.md",
  "missionTemplate": "mission.md",
  "gezels": [{ "templateId": "my-app-lead", "voorman": true }],
  "craftbooks": ["review-records"],
  "scripts": { "record-store": "<TypeScript source>" },
  "tools": [
    {
      "name": "add_record",
      "description": "Add one record to the app data.",
      "script": "record-store",
      "inputs": {
        "type": "object",
        "properties": { "title": { "type": "string" } },
        "required": ["title"]
      },
      "bind": { "action": "add" }
    }
  ],
  "pages": {
    "entry": "dashboard/index.html",
    "api": 1,
    "reads": [{ "source": "workspace", "path": "records.json" }],
    "tools": ["add_record"]
  },
  "workspaceSeed": ["records.json"]
}
```

Project parameters use a JSON Schema-like object. Gezel renders them as an adoption form and substitutes their values into the suggested project name, the project about and mission templates, and seeded files. A type can also set project shape and tab visibility, inherit a built-in project category with `extends`, seed artifacts instead of workspace files, suggest or require toolsets, and declare scheduled craftbooks.

## Roles and craftbooks

Each `gezels` entry references a versioned `gezel-template`; role instructions are not buried inside the project-type manifest. The template's `about.md` becomes the gezel's working character and method. One referenced role can be marked as the *voorman*—Dutch for foreman—or a solo type can present that gezel under a domain-specific label such as “Tutor” or “Opponent.” Browse the [Gilde role collection](https://gezelgilde.com/roles/) before creating a new role, because an existing one may already fit.

A project type lists craftbook ids. For a procedure used only by this type, place a Craftbook document at `versions/{version}/craftbooks/{id}.json`; an embedded document wins over a catalog item with the same id. For a reusable procedure, reference a `craftbook-template` from Gilde. On adoption Gezel copies the resolved craftbook into the project, where it becomes editable. Reapplying the type does not overwrite a copy the user has changed.

## Scripts, tools, data, and schemas

The released project-type manifest currently stores each script as TypeScript source in its `scripts` map. Adoption copies those scripts into the project with provenance. Each script declares its capabilities, inputs, outputs, and whether it is an action or gate through `@bendyline/gezel-sdk`; the [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md) article covers that contract.

A `tools` entry gives a script a stable tool name and description. Its `inputs` object is JSON Schema and is validated before the script runs. Static `bind` values let several narrow tools share one script without letting the caller replace the bound operation. The same tool can be exposed to a gezel or allowlisted for the Output page; page-only tools are kept off the model's tool roster.

There is no app-specific database or schema registry today. Custom app state is normally an ordinary JSON, Markdown, or media file whose shape is owned by your script and page code. Schemas currently appear at these boundaries:

- `params` describes the setup form.
- `tools[].inputs` validates a tool call.
- Script metadata describes direct script inputs and outputs.
- A craftbook can declare its own parameter schema.

If several components share a data shape, keep a TypeScript type and a small runtime validator in your authoring source, then make schema migration an explicit script operation. Gezel preserves the files, but it does not yet migrate arbitrary app data for you.

## Building the Output page

The Output page is served from the selected project-type version and runs in a null-origin sandbox. Set `pages.api` to `1` and use the injected `window.gezel` API. Typed definitions are available from `@bendyline/gezel-sdk/page`.

```js
const records = await gezel.data.read('records.json');
render(records);

const stopWatching = gezel.data.watch('records.json', async () => {
  render(await gezel.data.read('records.json'));
});

const { output } = await gezel.tools.invoke('add_record', { title: 'First review' });
```

Every readable file or subtree must appear in `pages.reads`, and every callable action must appear in `pages.tools`; the service checks both declarations on every request. There is deliberately no raw page write API. A page changes state through a declared script tool, which leaves an auditable run and can optionally summon a gezel to react. The page should also follow `gezel.ui.theme` and use `gezel.data.url()` for media.

One project type currently pins one Output entry page. That page may contain several screens or client-side routes, but Gezel does not yet let a type add several first-class project tabs.

## Packaging and delivery today

Public, broadly useful AI Apps should be contributed to Gilde. The released project type, its roles, craftbooks, and assets then travel in the exact-pinned `@bendyline/gilde` catalog used by Gezel. Models remain separate catalog choices—browse the [Gilde model collection](https://gezelgilde.com/models/)—and are not bundled into an AI App.

For private sharing, Gezel uses `.gezapp`. It is a renamed zip with a root `manifest.json`, an `items/` tree, and a SHA-256 digest for every embedded catalog item. Version 1 packages contain:

- Exactly one entry project type at an exact version, including its pages, seeds, assets, scripts, and private embedded craftbooks.
- Every gezel role template and standalone craftbook template referenced by that version.
- An exact dependency lock for referenced toolsets, connectors, and models. These dependencies remain external to the archive and must be available before installation.
- A minimum Gezel version, publisher details, an explicit signature status, and content hashes.

Only the selected version of each item is included. A `.gezapp` does not embed toolsets, models, connector executables, or arbitrary npm code.

Ask a gezel with the project-management tools to export the type applied to the current project. Gezel writes the `.gezapp` into project artifacts. On another installation, place that file in a project's artifacts and ask a gezel to import it. The first import call previews the publisher, contents, compatibility, hashes, conflicts, and missing dependencies without writing anything. A second, confirmed call installs the package atomically under `~/.gezel/ai-apps/`, records an installation receipt, and mounts it as one catalog source. Import never executes the contents.

The v1 signature status is `unsigned`. Hashes detect corruption and tampering after packaging, but they do not establish who published the app. Only install packages from a source you trust.

The current exporter packages the catalog definition, not the organic state of the current project. Changes made after adoption—edited scripts, a newly written craftbook, accumulated data, or a redesigned dashboard—are not automatically turned back into a new project-type version.

## The `.gezapp` contract

`.gezapp` is the customer-facing package for one AI App, not a generic bag of unrelated catalog content. Its entry project type defines the experience; referenced roles and craftbooks travel with it; external executable and model dependencies stay locked by identity and exact version. Gezel validates the archive's paths, size limits, schemas, reference closure, hashes, compatibility, dependencies, and conflicts before it mounts the package.

The mounted-unit design preserves the relationship between the installed items and the app that supplied them. That makes receipts, inspection, disabling, replacement, and uninstall possible without scattering copied files through several local catalog directories. The command line manages all of it: `gezel app add/update/list/show/enable/disable/remove` for the install-level lifecycle, `gezel app apply` and `gezel app status` to outfit a folder and watch its drift, and `gezel app serve` to share the app's pages (and optional visitor chat) as a mini-site.

## What still needs improvement

The runtime pieces are farther along than the authoring experience. These are the largest gaps visible from today's implementation:

| Gap | What is needed |
| --- | --- |
| App builder | A guided UI or CLI that scaffolds the type, role, page, craftbook, script, and seed files and validates them together |
| Project-to-app export | A deliberate diff and review flow that converts an organic project into a new project-type version instead of exporting only its original catalog item |
| Import interface | File picking, bundle review, conflict handling, and export/download controls in the desktop app; today the desktop flow goes through project artifacts and gezel tools, while the CLI (`gezel app add`) covers review-and-install from a file |
| Updates and drift | A three-way reconcile view for a new type version versus the installed provenance versus user-edited scripts, craftbooks, documents, and data; `gezel app status` reports per-seed drift and `gezel app apply` preserves user-modified seeds, but scripts still overwrite on upgrade |
| Schema evolution | App data-version declarations, migrations, backup, and rollback for custom JSON or other records |
| Dashboard surface | First-class page templates, development preview, diagnostics, and possibly more than one app-owned project page |
| Testing | A standard AI App test kit covering adoption, schema validation, scripts, page tools, craftbooks, permissions, local models, and upgrades |
| Portable script sandbox | A consistent OS-enforced path for user-edited scripts on every supported platform; today provenance-verified catalog scripts have a more portable execution path than modified or newly authored scripts |
| Catalog workflow | A supported local authoring source, publish command, signing story, and private registry path alongside public Gilde contributions |

Until those exist, treat the project type as the canonical source of an AI App. Use Gilde for public distribution, `.gezapp` for controlled sharing of an already-authored type, and ordinary projects for prototypes whose composition is still changing.
