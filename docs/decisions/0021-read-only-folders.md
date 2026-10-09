# 0021 — Added folders: read-only, indexed home-side, crewed by the person's act

Status: Accepted (2026-10). Supersedes the index placement in
[0005](0005-indexing-3.0.md).

## Context

Gezel's promise for a folder a person adds is that it reads the folder and
never changes it unless they ask and approve. An external `workingDir` is
read-only to gezels by default (`projectManagedWorkspaceWritable`), but the
runtime itself still wrote into it:

- The content index database (`index.db` plus `-wal`/`-shm`) lived at
  `<workspace>/.gezel/index/`, with a `.gitignore` beside it. It fell back
  home-side only when the folder could not be written, so a writable Pictures
  or Documents folder got a SQLite database inside it, and a cloud-synced
  folder got one that the sync client copied mid-write.
- The indexer deleted the legacy `.gezel/files/` conversion cache in place.
- The code-map village file was written to `<workspace>/.gezel/village.json`
  whenever the folder was writable, regardless of the project's write policy.
- Connector quarantine wrote refused content to `<workspace>/.gezel/quarantine/`.
- `git status` refreshes `.git/index` when it sees stat-only changes, so
  reading a repository's state rewrote a file inside it.

None of these is visible in a file listing to most people, and all of them
break the promise: `find <folder> -newer <marker>` after a night of indexing
was not empty.

## Decision

Derived state lives in gezel's own per-project folder. The workspace is only
read, except by a write the person initiated or a write policy they granted.

- **Index database:** `projectContentIndexDbFile` always answers
  `fallbackProjectIndexDir` (`<home>/projects/<id>/index/index.db`), for every
  project, writable or not. No `.gitignore` is written; there is nothing in the
  folder to ignore.
- **Legacy cleanup** of `.gezel/files/` runs only where gezel may write
  (`projectManagedWorkspaceWritable`); a read-only folder keeps whatever an
  earlier build left there.
- **Village file:** in the workspace only when the project's write policy
  allows it (an internal workspace, or `allow`); home-side otherwise.
- **Quarantine:** `Store.projectQuarantineDir` (`<home>/projects/<id>/quarantine/`).
  The old `projectLocalQuarantineDir` helper is deprecated and unused.
- **Git:** `runGit` sets `GIT_OPTIONAL_LOCKS=0`, as the restricted git runner
  already did. Writes still take their locks; only the optional index refresh
  is skipped. A caller may override it through `opts.env`.

### Migration moves, never rebuilds

An existing in-folder index holds summaries, reviews and embeddings: hours of
model output. `migrateWorkspaceIndexes` (`index-store/index-placement.ts`)
runs once per project at boot, before the workspace indexer or enrichment
opens any index:

1. Skip the shared library (already home-side) and machine-shared projects (a
   folder copy there may belong to another account's daemon).
2. Open the legacy file and switch it out of WAL. That needs an exclusive lock,
   and every open WAL connection holds a shared one, so it succeeds only when no
   other process has the index open. `BEGIN EXCLUSIVE` alone is not proof in WAL
   mode: it shuts out writers but not readers.
3. Sole owner: rename into place (copy then rename across volumes) and remove
   the legacy files, then `.gezel/index/` and `.gezel/` only if empty. A
   `.gezel/` folder can hold a person's own committed definitions, so removal is
   never recursive.
4. Not the sole owner: `VACUUM INTO` a home-side snapshot and leave the original;
   the next boot finds the home-side copy and removes the original once it can.
5. A home-side index already exists: keep it and drop the folder copy.

The new location is Device storage (`core/src/storage-tiers.ts`) and excluded
from backups (`core/src/backup-policy.ts`), like every other derived index.

## Crew arrives when the person adds a folder

A folder is only useful overnight if someone works on it, and work turns on
from crew composition: the Boekwachter describes, summarizes and reviews; a
Boekwachter plus a developer unlocks proposed fixes. Recruiting crew is
therefore the person's act, never a side effect.

- `recruitCrewForFolder` (`projects/recruit-crew.ts`) runs only when a request
  carries `recruitCrew: true`, which only onboarding and the add-folder sheet
  send. The projects routes drop the flag from any caller but the app's own
  credential (`isFirstPartyCaller`): `POST /api/projects` is also reachable by
  a model's project tools, and infer-for-path by Office, LibreOffice, VS Code,
  the CLI and the app SDK, none of which is the person adding a folder.
- The folder's kind (`gezel.folderKind`: pictures, documents, code, mixed)
  comes from the well-known folder first, then the detected coding type, then
  the file mix (`inferFolderKind`).
- Every kind gets the Boekwachter. A code folder is led by the Builder, which
  makes it a developer for the fix planner. Pictures, documents and mixed
  folders are led by the Boekwachter, so a Documents folder never has a
  developer drafting edits to Word files. An automatically seated lead is
  replaced; one the person chose is kept.
- It runs once per project (`gezel.crewRecruitedAt`), so a gezel the person
  later removes is never re-added. The shared library is skipped.
- The night-fix planner additionally requires a code folder: a recorded kind
  of `code`, or, with no kind recorded, a detected coding type or a linked
  GitHub repository. It still never recruits.

## Consequences

- An index no longer travels with a repository folder between machines. Each
  install indexes its own copy, which is what already happened for read-only
  folders and the shared library.
- A project whose folder moves keeps its index, because the index is keyed by
  project id, not by path.
- Writes into the workspace now come only from gezels under a write grant,
  diffpack applies (`userInitiated`), and the person themselves.

## Regression surface

- `index-store/read-only-promise.test.ts` indexes an external folder with a git
  repository, documents and an image through the static pass, enrichment, AI
  shadows, the map and `git status`, after a stat-only change that makes git
  want to rewrite its index, and asserts every entry's size, mtime and content
  hash is unchanged.
- `index-store/index-placement.test.ts` covers move, clean, snapshot-then-clean
  while another connection holds the file, a person's files under `.gezel/`,
  and the library skip.
- `connectors/writer.test.ts` asserts quarantined bodies land in the private
  folder and not in the workspace.
- `projects/recruit-crew.test.ts` covers each kind's lead, the person's own
  lead kept, run-once, and the library skip; `integration.test.ts` shows the
  flag ignored from a CLI token; `diffpack/night-fix-planner.test.ts` covers
  the code-folder gate.
