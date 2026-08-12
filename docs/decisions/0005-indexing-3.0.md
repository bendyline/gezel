# 0005 — Indexing 3.0: the shadow tree, provenance, and whole-file reviews

Status: Accepted (2026-08)

## Context

The per-project content index grew in layers: a deterministic structural pass
(tree-sitter symbols, chunks, doc conversion), then idle-gated AI tiers (file
summaries + embeddings, area rollups, and the boekwachter review pass). Three
structural problems had accumulated:

1. **Converted documents lived inside the workspace.** DOCX/PDF/PPTX/XLSX
   sidecars were written to `<workspace>/.gezel/files/`. A read-only external
   `workingDir` silently lost every conversion — the sqlite index had a
   home-local fallback, the sidecars did not — and the derived cache polluted
   the user's tree.
2. **AI-written rows recorded only `model`.** "Who reviewed this file, running
   where, under which app build, on what date" was unanswerable.
3. **Reviews were silently partial.** The review prompt truncated at 6,000
   characters, so mid-file issues in ordinary source files were structurally
   invisible, and files whose conversion was blocked sat in the review queue
   forever, stealing batch slots every sweep.

## Decisions

### The shadow tree is the single home for derived representations

All markdown "shadows" of workspace content live under the reserved
`artifacts/shadow/` subtree:

```
<workspace>/docs/architecture.docx
  → <project>/artifacts/shadow/docs/architecture.docx_files/architecture.md
```

- **Companion dirs are keyed by the FULL basename** (extension kept), not the
  stem: stem keying made `a.docx` and `a.pdf` collide on one `a_files/a.md`
  (the mtime gate then served one source's markdown for the other), and the
  full name gives orphan GC a lossless reverse map (`X_files` → source `X`).
  The user-visible adjacent convention for artifact/document previews
  (`brief_files/brief.md`, squisq outside-in) is unchanged.
- **Reserved:** writes through the artifact store are denied unconditionally
  (`shadow-readonly`); the converter writes via `writeFileAtomic` directly, so
  nothing legitimate enters through the Store. Reads by explicit path work;
  listings and fuzzy basename resolution skip the tree at the walk level so it
  never consumes the 500-entry listing budget or hijacks `read_artifact`
  lookups.
- **Regenerable:** deleting `artifacts/shadow/` is always safe. The static
  pass's gate is *hash unchanged AND sidecar present*, so missing sidecars
  self-heal; `doc:convert` metadata (`ok|blocked|failed`) stops blocked or
  unconvertible docs from re-paying sandbox conversions every pass. Orphan
  companion dirs are swept after every completed pass, and the legacy
  in-workspace `.gezel/files/` tree is best-effort deleted (skipped for
  machine-shared workspaces, where an older daemon would recreate it).
- **Two producer classes.** Office docs stay deterministic (sandboxed squisq)
  in the static pass. Images and audio are produced by the AI tier
  (`ai-shadow.ts`): vision describe+OCR and STT transcripts, written with a
  YAML frontmatter header (`source`, `source_hash`, `producer`, provenance).
  The `shadow_state` table is only the work gate — the frontmatter hash makes
  sidecars self-describing, so a rebuilt DB re-adopts them without re-paying
  model calls. Video has no producer and stays trivial.

### Provenance is stamped on every LLM-written index row

`summaries`, `symbol_summaries`, `area_summaries`, and `file_reviews` carry
`provider`, `gezel_id`, `gezel_name`, `app_version` (schema v10, additive, no
backfill — old rows keep NULLs and renderers degrade). The stamp is built once
in `buildEnrichDeps` from the SAME resolved target that builds the completions,
so it reflects reality (env overrides, Night Shift cloud override, Boekwachter
pin). Provenance is output-only — it must never become a routing input.
`formatReviewProvenance` renders the shared user-facing line:
`Reviewed by <model> (<provider>) · <gezel> · gezel <version> · <date>`.

Enrichment targeting is local-FIRST, not local-only: a cloud target is
reachable through exactly two explicit acts — the Night Shift override, or a
provider AND model both pinned on the Boekwachter's frontmatter
(`resolveEnrichTarget`). Writing both fields on the gezel is the opt-in; an
incomplete pin and every implicit path (config defaults, provider fallback)
stay local, so workspace content never drifts to a cloud model the user
didn't choose for this work. Cloud/CLI targets get longer one-shot deadlines
(120s/180s vs 30s/60s — CLI cold starts flake below 120s), and the `ambient`
flag is a no-op there: only local-engine queues hold ambient work, so a
background drive on a cloud Boekwachter starts immediately.

### Reviews take whole files; sizing lives in the completion layer

Per-caller truncation retired in favor of `chat/large-content.ts`: content that
fits the resolved target's budget goes in ONE call (cloud targets take whole
files); larger content is split into line-aligned overlapping windows whose
numbered lines carry absolute file line numbers, merged into one stored review
(issues deduped across overlaps, health = worst window, coverage recorded in
the notes — partial coverage is reported, never silent). The per-provider
budget is a conservative heuristic (`GEZEL_COMPLETION_BUDGET_CHARS` override);
threading real per-model `numCtx` through is the designated follow-up seam.
An absolute ~100MB ceiling refuses pathological blobs. Cost bound:
`GEZEL_REVIEW_MAX_WINDOWS` (default 4) windows per file.

### Review coverage and lifecycle

- `text` (`.txt`/`.rst`/`.log`) gained a builtin editorial rubric — "documents
  get grammar review" was silently false for them. `.log` noise escape hatch:
  `fileReviews.disabledKinds: ['text']`. `data`/`other` stay rubric-less on
  purpose (nothing editorial to judge).
- Unreviewable content (blocked conversions, empty files, vanished sources) is
  terminally skipped via `markReviewUnavailable` — the attempt budget burns in
  one write, the queue drains honestly, and a content or rubric change
  re-admits the file.
- Review issues remain **advisory** — hash-keyed rows wholly replaced on
  re-review, deliberately NOT wired into the durable finding lifecycle:
  free-prose issues from small models have no stable fingerprint, so any
  "resolved" state would dangle on every re-review. If demand appears, the
  security pattern (scanner rows + fingerprint-keyed lifecycle table) is the
  shape to copy.
- One low-volume audit event, `project.index.reviewed`, fires on the
  pending→0 drain transition per content wave — never per file (the ~150-kind
  flat history log and the digest input would drown).

### On-demand drives and the night-shift catch-up

"Study now" is a job, not a bounded pass: `POST /:id/index/enrich` with
`intensity` starts a server-side drive — awaited static refresh first
(`WorkspaceIndexManager.refreshAndWait`), then every AI tier (shadows →
summaries → areas → reviews) to drain — and returns immediately; progress
flows over `index_progress` events. Two intensities: `background` starts now
but stays polite (ambient one-shots the local engine holds behind live chat,
day batches); `full` occupies the engine (non-ambient, night batches, no
chat-yield — the user explicitly asked for the machine). Both honor the
indexing job's pause switch between batches; the background loop stands down
while a drive runs (one bulk consumer per engine). The legacy no-`intensity`
call keeps its loop-until-`drained` contract but now awaits the static
refresh before starting its AI budget clock.

Night-shift activation applies the same rule fleet-wide: `catchUpAll()`
sweeps every indexing-enabled project at full intensity, and the TaskRunner
holds night-shift handoffs (`heldFor: 'night-shift'`) until the sweep
finishes — batch work starts against a current index instead of racing the
indexer for the engine. The catch-up flag is raised synchronously so the
kick-then-wake activation sequence cannot race the first runner tick.
Interactive work is never held.

Drive state is server truth, not client state: `/index/status` carries
`aiDrive: 'background' | 'full'` (from `IndexEnrichmentManager.driveMode`)
while a drive runs, so every window shows "scan running" whichever client —
or the catch-up — started it, and the popover's button re-arms when the
field disappears rather than inferring completion from counts.
`enrichment.shadowsPending` rides along because the drive works the media
tier before summaries; without it a fresh full scan reads as stuck at
"0 of N files" for the entire describe phase.

One placement rule made this honest: a transient sqlite failure
(`SQLITE_BUSY`/`SQLITE_LOCKED` — the static worker holds long write
transactions) must never trigger the home-dir index fallback. The fallback
is for placement failures (read-only tree, permissions); minting an empty
home-side db during a busy moment makes status flicker to zeros and can
split readers from the writer. `isTransientIndexError` separates the two in
the driver, and `ContentIndex.openProject` reports "unavailable this call"
instead of falling back.

## Regression surface

- `content-docs.test.ts` / `content-docs-ooxml.test.ts` prove real conversions
  land under `artifacts/shadow/` with the full-basename layout.
- `content-indexer.test.ts` (shadow GC): orphan sweep, delete-source cleanup,
  no `.gezel/files/` writes, delete-tree self-heal.
- `store.test.ts`: shadow write denial (all paths), listing/fuzzy-resolve
  hiding, explicit-path reads.
- `embed-migration.test.ts`: v9→v10 keeps old rows, forces no re-review.
- `content-review.test.ts`: windowed whole-file review merge (absolute line
  anchors, worst-window health), unreviewable terminal skip, provenance
  round-trip.
- `ai-shadow.test.ts`: producer flow, sidecar re-adoption without model calls,
  retry caps, capability-absent skip.
- Retrieval guard: the index-bench evals (`evals/src/index-bench/`) remain the
  gate for chunk-sourcing changes — shadow-fed chunks must not regress
  recall@5/MRR (LEVERS.md discipline).
