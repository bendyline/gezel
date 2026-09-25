# Craftbook inputs

An **input** is a craftbook param that names the files a run works on — the
notes Ebook Compile turns into a book, the folder of photos a cull sorts, the
transcript meeting minutes are drawn from. The book declares it; the person
launching the book picks it; the runtime resolves it before the first step,
tells every step where the files are, and keeps the tools that read them.

The decision and its alternatives are in
[ADR 0014](decisions/0014-craftbook-inputs.md).

## Declaring an input

An input is an ordinary string param with an `input` annotation:

```json
"paramSchema": {
  "type": "object",
  "required": ["source"],
  "properties": {
    "source": {
      "type": "string",
      "title": "Source content",
      "description": "The notes, articles, or chapter drafts to compile.",
      "input": { "kind": "folder", "accept": [".md", ".txt", ".docx", ".pdf"] }
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `kind` | `folder` — a set of files, delivered as one folder. `file` — exactly one file. |
| `accept` | Extensions with a leading dot. Absent → any file. Unaccepted files are skipped and listed, never an error unless nothing is left. |
| `maxFiles`, `maxBytes` | May tighten the runtime ceilings (1,000 files / 250 MiB by default; 5,000 / 2 GiB hard; 100 MiB per file), never raise them. |

The annotation is read in exactly one place, `craftbookInputParams`
([core/craftbook-inputs.ts](../packages/core/src/craftbook-inputs.ts)), so the
launcher, the service, the CLI, and the MCP server cannot disagree about what
a book asked for.

Mark the input `required` unless the book has a real path without it. An
optional input that is left empty interpolates to nothing, and an empty
branch is still text in the prompt (see the CLAUDE.md gotcha on dead
branches).

## Writing a book that uses one

- **Refer to the input by its param, and stay drawer-neutral.** "Read every
  file of the `source` input" — not "read the workspace folder `{{source}}`".
  A workspace pick is read where it is and an upload lives in the artifacts
  drawer, and every step's prompt already says which, with the exact tools
  (see below). `{{source}}` still interpolates to the resolved path when a
  gate or a `consumes` entry needs it.
- **The manifest is the file list.** `{{task.dir}}/inputs/<param>.json`, always
  in the artifacts drawer. `consumes: [{ file: "{{task.dir}}/inputs/source.json",
  artifact: true }]` makes it a required read.
- **Per-file fanout** uses the manifest directly:

  ```json
  "spawn": {
    "overFile": "{{task.dir}}/inputs/source.json",
    "overArtifact": true,
    "itemsPath": "files",
    "steps": [{ "id": "narrate", "name": "Narrate {{name}}", "prompt": "Read `{{path}}` …" }]
  }
  ```

  Each child gets the item's `path` (drawer-relative), `name`, and `bytes`, and
  inherits the host's input record.
- **Never tell a step to write into the input.** An uploaded input folder is
  write-denied to gezels; write results beside it in the task folder.

## Launching

| Surface | How an input is supplied |
| --- | --- |
| New Task dialog | A source picker per input, above the other params: **In this project** (a workspace folder or file, with a live "37 files · 2.1 MB" check) or **From your computer** (choose a folder or files, or drop them; uploaded with progress). Scheduled launches offer the project source only. |
| `CreateTaskRequest.inputs` | `{ [param]: { from: 'workspace', path } \| { from: 'artifacts', path } \| { from: 'upload', stagingId } }`. |
| Any string param path (MCP `invoke_craftbook`, CLI, terminal, evals) | The param's plain value: a workspace path, or `artifacts:<path>` for the artifacts drawer. No new plumbing needed. |

Uploads go through `POST /api/projects/:id/input-staging` (limits come back
from the book), `PUT …/input-staging/:stagingId/file?path=<rel>` per file (a
raw body, streamed to disk with every limit enforced as bytes arrive), and
`DELETE` to cancel. Session tokens cannot reach these routes: an upload is
labelled "from your computer" in every prompt that names it.
`POST /api/projects/:id/tasks/input-preview` dry-runs a source with the same
resolver the launch uses.

## What the runtime does

In `TaskManager.create`, once the task number is known and before
interpolation ([tasks/inputs/resolve.ts](../packages/service/src/tasks/inputs/resolve.ts)):

1. Each input's source is enumerated against the book's spec. Workspace
   folders use the git-aware walker (so `.gitignore` applies); artifacts and
   uploads use a plain walk that skips nothing but junk. Sync droppings and
   dotfiles are dropped silently; unaccepted and too-large files are skipped
   and listed; converted `<stem>_files/` twins are left out. A source over its
   limits, or with nothing left, fails the launch with a message the dialog
   shows as-is (`TaskInputError` → 422).
2. The resolved path is written into the launch params, so `{{param}}`
   interpolates like any other param. The workspace root resolves to `.`,
   never to an empty string.
3. Immediately before the task is written, uploads are adopted from staging
   (one rename) and manifests are written; if the task write fails, both are
   undone.
4. `Task.inputs[param]` records the drawer, path, origin, a display label,
   and the counts. Fanout children inherit it.

Every task-scoped prompt renders each input in its **Invocation parameters**
block — count, size, origin, drawer, location, the tools that open it
(roster-gated), and the manifest path. Those tools (`list_artifacts` /
`read_artifact`, or `list_dir` / `read_file`, plus `read_doc_as_markdown`
when the set holds office documents) count as mandated by every step of the
task, so they survive the step kit and every clamp. The book's own step
`toolPolicy` still has the last word.

Reading a file inside an input folder counts as opening the supplied source
for a `researchEvidence` gate.

## Storage

- `projects/<id>/input-staging/<stagingId>/{meta.json,files/}` — uploads not
  yet launched, owned by
  [InputStagingManager](../packages/service/src/tasks/inputs/staging.ts).
  Beside `artifacts/` so adoption is a same-volume rename. Swept after a day.
- `projects/<id>/artifacts/tasks/<num>/inputs/<param>/` — an adopted upload.
  Gezel-write-denied (`isTaskInputArtifactPath`); the user may still edit.
- `projects/<id>/artifacts/tasks/<num>/inputs/<param>.json` — the manifest.

## Not yet

- Scheduled (cron) runs receive a workspace input as its plain path string;
  the spawned run does not re-resolve it into an input record.
- The compact Commands-panel form shows an input as a text field for a
  project path; the full picker lives in the New Task dialog.
- The Meester cannot hand over files from the user's computer; it points the
  user at the launcher.
