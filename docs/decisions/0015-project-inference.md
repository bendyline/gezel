# 0015 — Document path → project folder inference

Status: Accepted (2026-09)

## Context

The Office and LibreOffice integrations open a document and need a gezel
project for it. VS Code, the CLI, and the app SDK already mapped a *folder* to
a project, each with its own copy of the same client-side algorithm (exact
`workingDir` match, adopt a same-name project with no folder, else create).
None of the copies knew which folders are too broad to own: opening `~` in VS
Code created a project for the whole home folder.

A document is a harder question than a folder. `~/Documents/budget.xlsx`
should land in a project for the Documents folder (a first-run experience will
also offer those projects). `engineeringdocs/alpha/report.docx`, where
`engineeringdocs` also holds `bravo/`, should land in `engineeringdocs`, not
`alpha`. `~/report.docx` must not create a project for the home folder at all.

## Decision

One implementation, split in two:

- **Rules** live in `packages/core/src/project-inference/`, pure and
  platform-explicit (every function takes the platform, home, env, and temp
  dir; the filesystem comes through an injected probe). Well-known folders per
  platform, including OneDrive Known Folder Move, iCloud Drive, and
  `~/Library/CloudStorage/*`; forbidden roots as named predicates; and the
  climb.
- **Orchestration** lives in `packages/service/src/projects/infer-project.ts`
  behind `POST /api/projects/infer-for-path` and
  `GET /api/projects/well-known-folders`. The daemon supplies its own view of
  the machine; a client never supplies a home directory. The client helper
  `ensureProjectForFolder` (`@bendyline/gezel-client/node`) is what VS Code,
  the CLI, and the app SDK now call, with the old algorithm kept only as a
  fallback for daemons without the route.

Precedence:

1. **Existing (N1).** The deepest existing project whose `workingDir` contains
   the path wins. A path inside a project never creates anything. For
   `kind: 'folder'` only an exact match counts, because opening a folder is an
   explicit choice of root.
2. **Well-known roots.** Inside Documents, Desktop, a cloud root, etc., a
   strong marker (`.git`, `.gezel`, `.hg`, `.svn`) between the root and the
   document wins; otherwise the sibling-shape scorer may choose a folder like
   `engineeringdocs`; otherwise the well-known folder itself becomes the
   project. A well-known project may contain existing projects (N2): it is
   broad and read-only, and the deepest match keeps nested projects winning
   for their own files.
3. **Climb.** Elsewhere, score the document's folder and up to six ancestors:
   strong markers are a hard boundary and win outright; the sibling shape
   (+2), weak markers (+1), container names like `work` or `2024` (−2), and
   distance (−1 per level beyond the parent) decide the rest, threshold 2,
   ties to the deeper folder. The climb never enters a folder that already
   contains another project, and stops at any forbidden folder.
4. **Parent**, then **Default.** The document's own folder, unless it is
   forbidden, in which case the answer is the Default project.

Forbidden roots are never created: filesystem and share roots, mount points,
the home folder and its container, gezel's own homes, temp directories,
system directories, `AppData` / `~/Library` (except cloud roots), dot-folders
in the home, and the macOS cloud-provider parents. An existing project at such
a location still matches, with a warning.

A folder the caller names itself (VS Code, the CLI, an app SDK binding) is a
choice, not a guess, so only the broad folders are refused: the temp dir
itself, a system dir or its direct children, AppData / `~/Library` and their
direct children, `~/.config`, `~/.cache`, a home dot-dir itself. A project in
`/tmp/scratch` or `~/.config/nvim` is allowed that way, while a document
found in a temp folder, such as a mail attachment, never becomes a project.
Gezel's own homes stay forbidden in both modes, because they hold
credentials.

**Read-only by default needs no new field.** A created project has an
external `workingDir` and no `managedWorkspaceWritePolicy`, which
`projectManagedWorkspaceWritable` already resolves to "gezels may not write";
the roster withholds workspace write tools and the Store refuses the rest.
Inference must never set that policy. Provenance is stamped as project
properties (`gezel.inferredOrigin`, `gezel.inferredSource`,
`gezel.wellKnownKind`) and a `project.inferred` history event.

## Consequences

- Document edits from Office and LibreOffice go through their in-app tools,
  not the filesystem, so a read-only project costs those integrations nothing.
- Opening a forbidden folder from VS Code or the CLI now fails with 403
  `forbidden_root` instead of creating a project for it.
- A folder caller may bind a folder that does not exist yet, as the app SDK
  always allowed; a file where a folder was asked for is a 400. Rules and
  matching run on the realpath, but a folder project stores the caller's own
  spelling, so an app reads back the `workingDir` it asked for.
- Orphan adoption by name is kept for folder callers only. Document inference
  never binds a user's own project called "Documents" to their Documents
  folder.
- Creation is serialized per folder, so two documents opened together share
  one project.
- `climbInsideWellKnown` is a policy knob (`full` by default). `markers-only`
  keeps every document under Documents in the one Documents project unless a
  strong marker says otherwise.
