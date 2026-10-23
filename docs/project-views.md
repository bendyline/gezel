# Project views

A project's **Views** tab shows what the content index knows about the
project's files, one view at a time, with a shared file inspector beside it.
The Village was the first view; the tab used to be the Village alone.

The visual rules live in [ux.md](ux.md) ("A tab can name its current choice and
carry a menu", "Every view shares one inspector", and the Village section).
This page is the engineering contract.

## The tab

- **Key.** The tab's value and its `tabVisibility` key are still `map`. Both
  are frozen: project.json and gilde project types write
  `tabVisibility.map` (checkers and chess set it to `false`), and the e2e
  suites address `project-tab-map`.
- **Label.** The tab reads "<View> view" for the current view, with that
  view's icon. It carries a menu only when more than one view fits the project.
- **Visibility.** `tabVisibility.map` wins when set. Otherwise the tab shows
  when any view fits (`projectViewsTabDefault`). The index capability still
  gates it (`supportsProjectSection`).
- **Choice.** The current view is `project.selectedView`, saved through
  `PUT /api/projects/:id`. Like `outputPaneVisible` it is view state:
  `Store.updateProject` logs no history event for it and leaves `updatedAt`
  alone, because the scheduler reads `updatedAt` as project activity.
- **Deep links.** `openProjectViewActions({ projectId, view?, path? })` in
  [nav-actions.ts](../packages/ui/src/components/nav-actions.ts) queues the
  request in the section mailbox (`pending-project-section.ts`) for a project
  being opened, and fires `gezel:open-project-view` for one already on screen.

## Which views a project gets

The rules live once in core,
[project-views.ts](../packages/core/src/project-views.ts), so every host agrees:

| Function | Answers |
|---|---|
| `projectViewApplies(p, view)` | Does this view suit the project at all? The Village suits code-ish and unclassified projects (or any project with an explicit `tabVisibility.map: true`); the Guide suits the same projects except picture folders; the Diagram suits everything but picture folders; the others suit everything. |
| `availableProjectViews(p, offered)` | The views this build offers (`OFFERED_PROJECT_VIEWS`, from the UI registry) that apply, in menu order. |
| `defaultProjectView(p)` | Where a project opens before the person chooses, by folder kind: code → Village; pictures, documents, mixed → Gallery. |
| `resolveProjectView(p, available)` | The stored choice when available, else the default, else the first available. Never writes, so an id from a newer build survives on disk. |

`selectedView` is stored as a string matching `PROJECT_VIEW_ID_PATTERN`, not an
enum, for that reason. A malformed value is dropped on read (`.catch`) rather
than hiding the project.

## Adding a view

1. Add its id to `KNOWN_PROJECT_VIEWS` and, if it does not suit every project,
   a case to `projectViewApplies` (with a test in `project-views.test.ts`).
2. Add a folder under
   [packages/ui/src/views/project-views/](../packages/ui/src/views/project-views/)
   whose `index.tsx` default-exports a component taking `ProjectViewProps`.
3. Add an entry to `PROJECT_VIEWS` in
   [registry.ts](../packages/ui/src/views/project-views/registry.ts): label,
   one-line hint, icon (a `SectionIcon` glyph) and a dynamic `load`. Views are
   lazy chunks; hovering a menu item preloads one.
4. Report selection through `onSelectPath(path, { line? })` and read
   `selectedPath` back; never keep a selection of your own, or switching views
   loses it.
5. Give the inspector anything only your view knows through
   `setInspectorExtras({ forPath, known, chips, connections, onFindingsChanged,
   revision })`. `forPath` must name the selected file; extras for any other
   path are ignored, so a stale frame never labels the wrong file.

## The inspector

[FileInspector](../packages/ui/src/components/file-inspector/FileInspector.tsx),
hosted by [ViewInspectorHost](../packages/ui/src/views/project-views/ViewInspectorHost.tsx)
inside [InspectorLayout](../packages/ui/src/components/file-inspector/InspectorLayout.tsx).
For the selected path it loads the file, its security findings, its
Boekwachter review (tracked `BW-n` issues and the legacy issue list), the
per-symbol code context, and the summary (the code context's, else
`GET /index/file-summary`). Every load degrades to nothing on failure.

- Tracked issue rows are shared with the Workspace's index pane
  ([tracked-issues.tsx](../packages/ui/src/components/file-inspector/tracked-issues.tsx)).
  A change from either surface fires `gezel:boekwachter-issues-changed`, and
  every open pane for that project refetches.
- Fix asks the host (`onFixIssue`), which opens the same Fix dialog the
  Workspace uses.
- In the VS Code host the Village hands a selection to the editor
  (`window.__GEZEL__.openWorkspaceFile`) and no inspector opens.

`FileMapView` remains as a thin wrapper (Village plus inspector) so the
Village can be shown without the rest of the tab, and so its tests exercise
the composition the tab uses.

## Data routes

All three are reads; none writes anything.

- **`GET /api/projects/:id/index/graph`** (`getFileGraph`), with query
  `kind=code|docs|all`, `scope=core|tests|all`, `max`, `focus`, `hops`. It
  returns:
  - nodes, each with fan-in and fan-out, centrality, findings, churn and a
    summary lead;
  - edges merged per pair, with names taken and type-only, dynamic and
    re-export flags;
  - external packages, folders (with purpose where the index has one), and
    package roots;
  - per-language coverage and a shape `signature`.

  A cap keeps the most central files, and always keeps the focus and its
  neighborhood. Built by
  [file-graph.ts](../packages/service/src/index-store/file-graph.ts) from the
  stored graph (`file_edges`, [ADR 0024](decisions/0024-resolved-file-edges.md)).
  Signals come from the same `computeFileSignals` the Village uses, so the
  two never disagree about which file is load-bearing.
- **`GET /api/projects/:id/index/file-insight?path=`** (`getFileInsight`)
  returns, for any kind of file:
  - its facts and summary;
  - its folder's purpose;
  - photo facts (never a location);
  - a document's title and frontmatter;
  - git activity;
  - imports, importers, links and backlinks;
  - byte-identical copies.

  The inspector reads it; findings and the review keep their own routes,
  because they carry action state.
- **`GET /api/projects/:id/index/codebase-map`** (`getCodebaseMap`) returns
  the overnight codebase map:
  - an architecture note;
  - every summarized folder, with its depth, purpose and key files;
  - the most-imported files (`loadBearing`), each with at least two importers.

  `indexed` stays false until the area pass has written folder summaries.
  `ContentIndex.codebaseMap` builds it from the same rows as
  `reports/codebase-map.md`. The **Guide** view
  ([guide/](../packages/ui/src/views/project-views/guide/)) reads it; see "The
  Guide is the Village read aloud" in [ux.md](ux.md).

## The Diagram

The Diagram ([diagram/](../packages/ui/src/views/project-views/diagram/)) reads
`GET /index/graph` and draws it in four steps, each with one owner:

| Step | Owner | Does |
|---|---|---|
| Folders | `buildDiagramTree`, `defaultDiagramExpansion` ([core filegraph/tree.ts](../packages/core/src/filegraph/tree.ts)) | Display folders (pass-through chains folded, package roots named), and which open by default within a box budget |
| Shaping | `shapeDiagram` ([core filegraph/shape.ts](../packages/core/src/filegraph/shape.ts)) | Closed folders stand for their files; file edges are summed per pair of boxes, mutual pairs merged, runtime cycles marked, hubs stubbed, shortcuts dropped; Focus keeps one file's neighborhood. Pure and deterministic |
| Presentation | `drawingFor` ([diagram-model.ts](../packages/ui/src/views/project-views/diagram/diagram-model.ts)) | Box sizes from squisq's `graphNodeSize`, labels, badges, tones, and the layout graph |
| Layout and drawing | `useGraphLayout` + `DiagramViewer` (`@bendyline/squisq-react/graph`), the worker in [layout-engine.ts](../packages/ui/src/views/project-views/diagram/layout-engine.ts) | `squisq-graph`'s layered layout off the main thread, cached by graph signature; pan, zoom, selection, hover |

A layout is drawn only with the presentation it was computed for, so a box
never shows another box's label while a new layout is on its way. Folder ids
are `folder:<path>`; `visibleIdForPath` maps a selected file to the box
that shows it. Which folders the person opened is remembered in
localStorage (`gezel.diagram.open.<project>.<kind>`), a convenience only.

## Reports

The Reports view ([reports/](../packages/ui/src/views/project-views/reports/))
reads two routes in
[project-reports.ts](../packages/service/src/http/routes/project-reports.ts):

- **`GET /api/projects/:id/reports`** (`listProjectReports`) lists every
  report-shaped markdown file in the artifacts drawer, newest first (at most
  200), with its title, kind and suggested-action count, plus `writable`: the
  reports this folder suits (`writableReports`, by the same rules each writer
  applies). "Report-shaped" and the kind come from one owner,
  [reports/report-paths.ts](../packages/service/src/reports/report-paths.ts),
  which the night review uses too. The night review's dated copies of earlier
  mornings are left out.
- **`POST /api/projects/:id/reports/generate { kind }`**
  (`generateProjectReport`) runs the codebase, documents or photos writer
  with `force`, replacing the day's report, or rewrites the codebase map.
  `wrote: false` with a path means already up to date; a null path means
  nothing to say.

[ReportDocument](../packages/ui/src/components/ReportDocument.tsx) renders a
report for both the view and Home's night review, and turns `gezel-nav:`
links, relative links, and paths in inline code into calls to `onOpenPath`.

## The Gallery

The Gallery ([gallery/](../packages/ui/src/views/project-views/gallery/)) reads
two routes in
[project-index-views.ts](../packages/service/src/http/routes/project-index-views.ts),
both built by [gallery.ts](../packages/service/src/index-store/gallery.ts) with
no model:

- **`GET /api/projects/:id/index/gallery`** (`getGallery`), with query
  `group=type|folder|event`, `filter=all|photos|documents|data|media|code`,
  `q`, `shelves` (default 12) and `perShelf` (default 24). It returns the
  shelves, the groupings this folder supports (`event` only when it has an
  outing), file counts per family for the filter keys, and `shelfCount`.
- **`GET /api/projects/:id/index/gallery/shelf`** (`getGalleryShelf`), with the
  same `group`, `filter` and `q` plus `shelf`, `offset` and `limit`: the next
  page of one shelf. Shelf ids are stable for a given request (`type:photo`,
  `folder:packages/core`, `event:<first taken_at>`, `copies`, `lookalikes`).

What a file is comes from core's `ruleFileType`
([file-type.ts](../packages/core/src/file-type.ts)): a label, its plural, and a
family, from the path and the index's own classification. The groupings:

| Group | Shelves | Default for |
|---|---|---|
| `type` | One per type, largest first | documents, mixed, unknown |
| `folder` | One per folder group (`folderGroups`, [folder-groups.ts](../packages/service/src/index-store/folder-groups.ts): top-level folders, splitting one that holds most files), described by the folder's summary | code |
| `event` | Exact copies and look-alikes first, then each outing newest first (`photoEvents`, shared with the photo tools), screenshots, other pictures, then other files by type | pictures |

Words in `q` must all appear in a file's path, title, type or summary.
Lockfiles, binaries and minified bundles are left out, and so is anything
the workspace's Git ignore rules hide. The grouping chosen is remembered in
localStorage (`gezel.gallery.group.<project>`), a convenience only.

## The Timeline

The Timeline ([timeline/](../packages/ui/src/views/project-views/timeline/))
reads two routes, built by
[timeline.ts](../packages/service/src/index-store/timeline.ts):

- **`GET /api/projects/:id/index/timeline`** (`getTimeline`), with
  `bucket=week|month|year` (default by span: weeks up to four months, months
  up to four years). It returns every bucket from the first activity to the
  last, empty ones included, each with commits, files and a count per lane,
  newest 260 at most.
- **`GET /api/projects/:id/index/timeline/bucket?start=&end=&source=`**
  (`getTimelineBucket`) returns one stretch: its commits newest first, and the
  files changed most.

A folder with git history is told by its commits (`source: 'git'`), each file
change landing on that file's area (the same `folderGroups`), at most seven
lanes. Any other folder places each file at its own date (`source: 'files'`):
a photo when it was taken, anything else when it was last modified, by family.
Buckets are in the daemon's local time, weeks starting on Monday.

The history is stored by the git-stats ingest
([git-stats.ts](../packages/service/src/index-store/git-stats.ts)) in
`git_commits` and `git_commit_files` (schema v16), from the same capped
`git log` that feeds churn: each commit's hash, time and subject, and the
indexed files it touched. No author is stored. An index that predates the
tables re-ingests on its next tick (`git_stats:history`).

## Planned views

Nested folder rollups and a categories tier (discovered file types and topic
shelves for the Gallery) are planned and not built yet.
