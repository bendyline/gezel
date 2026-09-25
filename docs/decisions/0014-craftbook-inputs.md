# 0014 — Craftbook inputs: declared source files, read in place or uploaded

Status: Accepted (2026-09)

## Context

A large part of the catalog works *on* something the user already has: Ebook
Compile ("compile a collection of notes, articles, or chapter drafts"),
folder-to-audio, ocr-extract, image-batch-edit, meeting-minutes, faq-from-docs,
and roughly seventy more whose descriptions say "a folder of …" or "these
documents". None of them could say *which* files. Params were untyped JSON
Schema strings, so a book either assumed a path, asked the model to guess from
a free-text description, or — Ebook Compile's case — pointed at a folder that
could not exist: a bulk rewrite of `notes/` → `{{workPath}}/` turned "survey
the source notes/articles" into "survey the source `tasks/<num>/articles`",
an always-empty folder inside the new task's own drawer.

Two further gaps made a fix more than a new param:

- Files the user has *outside* the project had no way in. There was no
  host-path import, no workspace-to-artifacts copy, and no folder picker in a
  plain browser.
- A `.docx` in the artifacts drawer could not be read at all:
  `read_doc_as_markdown` and the office-document reroute on `read_file` only
  knew the workspace.

## Decision

A craftbook param may carry an `input` annotation (`{ kind: 'file' | 'folder',
accept?, maxFiles?, maxBytes? }`). At launch the user supplies it one of two
ways, and the runtime resolves it in `TaskManager.create` before
interpolation, so `{{param}}` becomes the resolved path everywhere the book
uses it. The full contract is [docs/craftbook-inputs.md](../craftbook-inputs.md).

**A workspace pick is read in place; a pick from the user's computer is
copied** into `artifacts/tasks/<num>/inputs/<param>/`.

Reading in place avoids duplicating a project's own files and keeps one source
of truth. The alternative — always copying, so every book sees one drawer —
was rejected because the runtime can carry the drawer difference itself:
every step's prompt names the drawer and its read tools (roster-gated), and
those tools are kept through every narrowing short of the book's own step
policy. Books stay drawer-neutral and never branch on where their input lives.

**Outside files arrive as bytes the user's own client uploads, never as a
host path the daemon opens.** The browser reads the picked folder
(`<input webkitdirectory>`, a drop zone) and streams each file into a staging
area the task adopts at launch with one same-volume rename. Rejected: letting
the desktop app hand the daemon an absolute path to copy. That is faster for
very large folders, but it adds a second host-path trust surface beside
`preview-folder`, fails outright in remote mode and under a system-service
daemon that cannot read the user's home, and needs a separate code path for
the plain-browser UI. The upload path is one path everywhere.

## Consequences

- The manifest (`tasks/<num>/inputs/<param>.json`) is always in the artifacts
  drawer, even for a workspace input, and its `files` array is shaped to be a
  fanout source (`spawn.overFile … itemsPath: "files"`).
- An uploaded input folder is write-denied to gezels (the user may still edit
  it). A run that edits its own source can make any gate pass.
- Uploads are refused for recurring (`cron`) hosts: they would be the same
  bytes every run. A scheduled launch passes a workspace input as the plain
  path string its spawned runs already accept; resolving inputs per scheduled
  run is future work.
- Limits are enforced twice, with the same numbers: in the browser before a
  byte is sent, and on the daemon while streaming. A source over its limits is
  refused, never truncated — a run that silently worked on half the files
  reports success on the wrong set.
- `read_doc_as_markdown` gained `artifact: true`, and `read_artifact` reroutes
  office documents the way `read_file` does, converting into the adjacent
  `<stem>_files/` twin the References preview already used for artifacts.
