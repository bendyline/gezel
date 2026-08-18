# The shared document library

The library is gezel's shared knowledge: the things that should be true for
every project and every gezel. Mission statements, guidelines, policies, house
style, reference material. One folder, readable by the whole crew.

It lives at `~/.gezel/documents/` by default and can be moved anywhere the user
likes — including a cloud-synced folder — from Settings → Folders.

This document is the contract: who owns what, what gezel writes where, and
which failure modes are handled versus known. The architecture decision behind
it is [ADR 0006](decisions/0006-shared-library-project.md).

## The library is a project

The library's workspace is a canonical `shared` project. That is not a
metaphor: `shared.workingDir` **is** the documents root, so everything the
per-project stack does — content indexing, office-document conversion,
embeddings, hybrid search, the filesystem watcher, idle-time enrichment — runs
over the library without a second pipeline existing.

The Documents area, the `/api/documents/*` routes, and the `*_document` MCP
tools are a facade over that project. They keep their own shapes; underneath,
the library is indexed like any workspace.

**The load-bearing invariant** is that the Documents API and the shared
project's workspace are one directory. If those ever diverge, the indexer
studies one folder while the API serves another, and every surface built on
top splits silently. It is asserted directly in `shared-project.test.ts`.

The project is deliberately unlike a jobsite:

- No voorman, and no meester check-ins. A library has no progress to chase.
- The **Boekwachter** is its resident gezel, recruited once when the project is
  created. Its presence on the roster is what opts the library into the AI
  tier (summaries, embeddings, media shadows).
- Reviews are off. The review tier judges files against code rubrics; pointed
  at a policy document it produces confident nonsense.
- Hidden from the sidebar's Projects group, undeletable, unarchivable, and not
  git-linkable. Its location is managed in Settings → Folders, so the project's
  `workingDir` is derived on every boot rather than edited directly.

Identity is a marker property (`gezel.sharedLibrary`), not the id. A user
project named "Shared" slugifies onto the same id, and adopting it would
silently repoint their workspace at the library — so the library claims a free
id instead and records it in `config.sharedProjectId`. Branch on
`isSharedLibraryProject(project)`, never on the id.

## Ownership: the folder is the user's

Everything in the library folder belongs to the user. Gezel adds nothing of its
own there.

Derived state lives home-side, under `~/.gezel/`:

| What | Where |
|---|---|
| Content index (sqlite) | `~/.gezel/projects/<shared>/…` — forced home-side, never `<library>/.gezel/` |
| Converted office documents | `~/.gezel/projects/<shared>/artifacts/shadow/…` |
| Summaries, embeddings | the same index |

This matters most when the library is a synced folder: mutable SQLite must not
ride a sync client, and a `.gezel/` directory has no business appearing in a
folder the user browses in Finder. A regression test asserts the folder holds
only documents after a full index pass.

The one exception is user-facing by design: **outside-in editing**. Opening a
`.docx` in the editor creates a companion `report.docx_files/` folder holding
an editable markdown twin, its media, and version history. Those travel with
the document because they are the user's editable copy — not a cache.

## What gets indexed

Everything the user files, minus what is not a document:

- **Skipped:** outside-in companion twins (`*_files/`, `_squisq`), `.versions/`,
  and cloud-sync droppings (`~$doc.docx`, `*.tmp`, `*.partial`, `.DS_Store`,
  `desktop.ini`). A twin is a derived view of a document already in the
  listing; indexing both invites a model to open the stale one.
- **Converted:** `.docx`, `.pdf`, `.pptx`, `.xlsx` become markdown in the
  shadow tree and are searchable by content. `read_document` returns that
  markdown too, so a search hit inside a binary can actually be opened.
- **Refused politely:** other binaries return an explicit "this is a binary
  file" rather than mojibake.

## How gezels reach it

Four paths, in the order a gezel actually uses them:

1. **The standing listing.** Every non-executor prompt carries a recursive
   listing of the library (capped; described rows on larger models). Executors
   get a one-line pointer instead — they still need to know it exists.
2. **`search_documents`.** Content search with real ranking, backed by the
   shared project's hybrid index. This is the steer in the prompt: search
   first, then `read_document` the match.
3. **Auto-recall.** On a session's first message, the library is searched with
   the same query embedding as memory and workspace code. Hits render as
   `[library]` rows in the recall block. Not scoped to the session's project —
   a policy filed once is the answer wherever it is asked.
4. **Per-turn recall.** The turn-1 snapshot is frozen for the session, so a
   topic that arrives on turn eight would otherwise get nothing. A user-channel
   prelude offers strongly-matching documents for the current message, once per
   document per session. Silent — and free — when nothing matches.

## Freshness

| Change | Visible in search after |
|---|---|
| Written through the app or a gezel | ~3s (debounced re-index) |
| Dropped into the folder from outside | ~2s (the library is a pinned watcher target) |
| Landed while the app was closed | the next poll — the library is treated as recent, not cold |

The library never opens as a project tab, so it can never earn a watcher slot
by recency. It is pinned instead, because it is the one workspace that
routinely changes while nobody is looking.

## Audit

`document.created`, `document.updated`, `document.renamed`, `document.deleted`,
and `document.folder.created` land in history, filterable in the History view.

Edits are **coalesced**: the editor autosaves, so one sitting produces one
`document.updated` event carrying how many saves it took and how many lines
moved, rather than dozens of rows. A gezel's edits and a person's are tracked
separately even on the same document — merging them would credit one with the
other's changes. Gezel writes carry `gezelId`; app writes carry none, which
reads as the user.

## Cloud-sync: handled and known

**Handled:** sync droppings and lock files are filtered from indexing; the
index and all derived state stay off the synced volume; externally-landed files
are picked up by the watcher within seconds; moving the library re-points the
project and reindexes.

**Known limitations:**

- *Placeholder files* (OneDrive Files On-Demand, iCloud "optimize storage").
  Reading a dehydrated file can block on a download. Recommend "always keep on
  this device" for the library folder.
- *Conflict copies* (`report (1).docx`, `… conflicted copy …`) are indexed like
  any other file — they are real content — and are not auto-resolved.
- *Case-only renames* on case-insensitive volumes may briefly double-list.
- A file that lands while the daemon is down waits for the next poll, not the
  watcher.

## Per-project `documents/`

`<project>/documents/` is **not** a second library. It holds exactly two files
— `about.md` and `missionObjectives.md` — which are injected into prompts for
sessions scoped to that project. Nothing lists it, no tool reaches it, and it
is not indexed.

Knowledge specific to one project belongs in the shared library under a folder
named after that project. That keeps one library, one pipeline, and one place
to look.
