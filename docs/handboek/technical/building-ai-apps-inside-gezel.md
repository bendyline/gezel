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

This is a useful product name for the composition, but it is not a separate catalog kind today. The project type is the composition root and installer. Public project types normally arrive through the [Gezel Gilde project-type collection](https://gezelgilde.com/toolsets/#project-types); private or experimental types can be shared in the current `.gzl` bundle format.

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
Gilde project type or local .gzl
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
7. Contribute the type to Gilde for normal distribution. After a type is already resolvable by a Gezel installation, use `.gzl` export for controlled private sharing.

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

For private sharing, Gezel already has `.gzl`. It is a renamed zip with a root `manifest.json`, an `items/` tree, and a SHA-256 digest for every item. Version 1 packages:

- One existing catalog project type, including every file in its item folder: version manifests, pages, seeds, assets, and embedded craftbooks.
- Every gezel role template referenced by that project type.

It does not embed toolsets, models, executables, or arbitrary npm code. It also does not include standalone craftbook-template items; a private craftbook travels only when it is embedded in the project type's version folder.

Ask a gezel with the project-management tools to export the type applied to the current project. Gezel writes the `.gzl` into project artifacts. On another installation, place that file in a project's artifacts and ask a gezel to import it. The first import call previews and verifies every item without writing anything; a second, confirmed call installs the items into the local catalog. Import never executes the contents.

The current exporter packages the catalog definition, not the organic state of the current project. Changes made after adoption—edited scripts, a newly written craftbook, accumulated data, or a redesigned dashboard—are not automatically turned back into a new project-type version.

## Should this become `.gezapp`?

`.gezapp` would be a clearer customer-facing name for the complete composition, but it is a proposal, not a format Gezel recognizes today. The least surprising path would be a documented application profile or future alias of the existing verified bundle rather than a second unrelated archive format.

A useful `.gezapp` profile would add the missing product contract around the current pieces:

- Exactly one entry project type and all referenced role templates.
- Embedded private craftbooks plus optional standalone craftbook-template items.
- A dependency lock for referenced toolsets, connectors, and minimum Gezel or SDK versions, while continuing to keep executable dependencies and models outside the archive.
- App-level identity, artwork, release notes, license, data-schema version, and migration declarations.
- The same preview, digest verification, consent gates, and no-execution-on-import behavior as `.gzl`.

Changing only the extension would not solve authoring or upgrades, so those contracts should be designed with the name.

## What still needs improvement

The runtime pieces are farther along than the authoring experience. These are the largest gaps visible from today's implementation:

| Gap | What is needed |
| --- | --- |
| App builder | A guided UI or CLI that scaffolds the type, role, page, craftbook, script, and seed files and validates them together |
| Project-to-app export | A deliberate diff and review flow that converts an organic project into a new project-type version instead of exporting only its original catalog item |
| Private bundle breadth | Support for standalone craftbook templates and an explicit, locked dependency graph without embedding toolset or model code |
| Import interface | File picking, bundle review, conflict handling, and export/download controls in the desktop app rather than a project-artifact and gezel-tool flow |
| Updates and drift | A three-way reconcile view for a new type version versus the installed provenance versus user-edited scripts, craftbooks, documents, and data |
| Schema evolution | App data-version declarations, migrations, backup, and rollback for custom JSON or other records |
| Dashboard surface | First-class page templates, development preview, diagnostics, and possibly more than one app-owned project page |
| Testing | A standard AI App test kit covering adoption, schema validation, scripts, page tools, craftbooks, permissions, local models, and upgrades |
| Portable script sandbox | A consistent OS-enforced path for user-edited scripts on every supported platform; today provenance-verified catalog scripts have a more portable execution path than modified or newly authored scripts |
| Catalog workflow | A supported local authoring source, publish command, signing story, and private registry path alongside public Gilde contributions |

Until those exist, treat the project type as the canonical source of an AI App. Use Gilde for public distribution, `.gzl` for controlled sharing of an already-authored type, and ordinary projects for prototypes whose composition is still changing.
