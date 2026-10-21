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
| `projectViewApplies(p, view)` | Does this view suit the project at all? The Village suits code-ish and unclassified projects (or any project with an explicit `tabVisibility.map: true`); the Diagram suits everything but picture folders; the others suit everything. |
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

Both are reads; neither writes anything.

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

## Planned views

The Diagram (file dependencies), Reports, Gallery and Timeline views are
planned, along with nested folder rollups, a categories tier and stored git
history. None of these is built yet. Until a view lands, its id is known to
core and offered by no build.
