# 0006 — The shared document library is a project

Status: Accepted (2026-08)

## Context

The shared document library (`~/.gezel/documents/`, relocatable via
`config.externalFolders.documents`) is the install's cross-project knowledge:
mission statements, guidelines, style guides, policies, reference material.
It is also the only content root that lived entirely outside the project
machinery, and it showed.

Project workspaces get the full ADR 0005 stack: a static tier (classification,
chunking, mtime+hash-gated office-document conversion into `artifacts/shadow/`,
`doc:convert` outcome memos), an idle-gated AI tier (vision descriptions, STT
transcripts, per-file summaries with provenance, embeddings), hybrid ranked
retrieval, an `fs.watch` watcher on the MRU projects, and a status surface.

The library got a hand-rolled mirror in `GlobalIndexManager`: FTS only, no
vectors, no persistent shadow, no watcher. Three concrete defects followed
from having a second, thinner pipeline rather than reusing the first:

1. **Conversions were recomputed and thrown away.** `indexConvertibleDocument`
   converted a DOCX through the sandbox *before* it could hash-gate, and the
   6-hour reconcile enqueued every path, so every office document in the
   library was re-parsed every 6 hours forever and the markdown discarded.
   A blocked document was retried on the same schedule and indexed as zero
   chunks — invisible in search, with nothing recording why.
2. **Results were unranked.** `IndexStore.searchDocs` had no `ORDER BY`, so
   FTS5 returned rowid order and "top 5" meant "the 5 oldest-indexed matches".
3. **External edits took up to 6 hours to appear** — precisely the case the
   relocatable-folder feature invites, since a synced folder receives writes
   from other devices.

Each was individually fixable in place. Doing so would have meant reimplementing
sidecar caching, mtime gating, outcome memos, media shadows, embeddings, and
idle scheduling next to working implementations of all six.

## Decision

**The library becomes a project.** A canonical `shared` project is ensured at
boot, and its `workingDir` is the resolved documents root — no files move. Every
per-project service reaches the library by construction.

The Documents area, the `/api/documents/*` routes, and the `*_document` MCP
tools remain the interface and keep their wire contracts; they become a facade
over this project. `DocumentsStore` keeps its own write path, so document writes
stay agent-writable and keep emitting `document.*` history events rather than
`workspace.write`.

### Identity is a marker, not an id

A user project named "Shared" slugifies onto the same id, and adopting it would
silently repoint their workspace at the documents library. The library is
therefore identified by a `gezel.sharedLibrary` property stamped on the project
we created (`isSharedLibraryProject`). When the id is occupied, the library
claims a free id and records it in `config.sharedProjectId`. If the *configured*
id is later occupied by a foreign project, the library claims a fresh id again
rather than returning that project — the facade must never expose someone's
workspace as the library.

### It is a library, not a jobsite

The project exists to carry services, not to be supervised:

- No voorman. `voormanAutoAssignedAt` is pre-stamped so the first index pass
  does not recruit a lead for a document shelf.
- No meester check-ins. The status-generator sweep skips it; a report saying
  "the library did not change" every idle period is pure noise. Deliberate
  task work filed there still runs — only the ambient check-in skips.
- No progress nudges (`nudgeConfig.enabled: false`, which `createProject`
  already applies to any project opened onto an existing folder).
- Hidden from the sidebar's Projects group, like `default`. The Documents area
  is its door; listing it as a project too would offer two doors into one room.
- Undeletable, unarchivable, and not git-linkable. Its `workingDir` is derived
  from the documents root on every boot, so it is not directly editable either:
  the library moves through Settings → Folders, which already owns that flow.

### The Boekwachter is the library's gezel

No new role. The install-wide Boekwachter — already the "reads and summarizes
files" figure, and already the roster opt-in that authorizes the AI tier — is
recruited onto the library once, when the project is created. `ensureDefaultBoekwachter`
now honors an explicit `recruitProjectIds` even when the seat is already filled,
because an upgrading install would otherwise never opt the new project in. The
undefined case still means "no recruitment" outside a first ensure, so a role
the user removed is never quietly re-added.

### Upgrades are deliberately unceremonious

There is no index migration. The ensure creates the project; the normal project
pipeline indexes the library on its first scan. The old global `documents`
collection is dropped and its writer deleted in the same change, so no
"documents used to be separate" compatibility layer outlives the switchover.

## Consequences

- The convert-and-discard defect disappears with the code path that had it;
  the library inherits ADR 0005's sidecar caching and outcome memos instead.
- Derived state must stay out of the library folder, which is user-owned and
  possibly cloud-synced: the project index is forced to its home-side private
  location rather than `<workspace>/.gezel/`, and shadow sidecars land under
  `~/.gezel/projects/<shared>/artifacts/shadow/`.
- The content walker must skip outside-in internals (`*_files/`, `_squisq`,
  `.original/`, `.versions/`), which the old documents indexer filtered and
  `discoverWorkspaceFiles` does not. Without it a document is indexed twice —
  once as the binary, once as its editable twin.
- Every future "for each project" feature has to decide what the library means
  to it. The `HIDDEN_PROJECT_IDS` precedent shows this is a normal, small cost;
  `isSharedLibraryProject` is the single predicate to branch on.
- Workspace semantics that suit code are noise on prose. The library's
  enrichment is restricted to summaries, embeddings, and media shadows — no
  code-tuned file reviews.

## Alternatives considered

**Extend `GlobalIndexManager` in place** — add sidecar reuse, an embed drain, a
watcher, and a media tier to the documents collection. Rejected: it rebuilds
six mechanisms that already exist and work per-project, and every future
indexing improvement would have to be written twice.

**Promote the library to a full `ContentIndex` scope with its own database** —
rejected: `ContentIndex` is a project façade (city map, git stats, finding
lifecycle, artifacts corpus); an adapter would stub most of it and force a
data migration for no behavioral gain over pointing a real project at the root.
