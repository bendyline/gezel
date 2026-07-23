# DocBlocks toolset — real documents (DOCX / PPTX / PDF) from markdown

Gezel ships the [DocBlocks](https://github.com/bendyline/docblocks) MCP server as a
**bundled catalog toolset** (`docblocks`), so gezels can turn markdown into real
Office documents — an editable `.pptx`, a `.docx`, a `.pdf` (plus XLSX, CSV, HTML,
EPUB, DBK, MP4, GIF) — instead of hand-assembling HTML decks or raw OOXML.

Three pieces make it native rather than "just another MCP server":

## 1. The bundled toolset

[data/toolsets/do/docblocks/ in bendyline/gilde](https://github.com/bendyline/gilde/tree/main/data/toolsets/do/docblocks)
pins `@bendyline/docblocks-cli` by exact version + tarball SHA-256 and spawns it
as a stdio MCP server via the normal `npm-package` install pipeline
(`node <install>/dist/index.js mcp`). The version manifest lists all **19 canonical
tools** — that list is load-bearing: craftbook `autoAllow` derives its
pre-authorized tool set from `tools[].name`
(see [docs/craftbook-toolsets.md](craftbook-toolsets.md)), so keep it in sync with
the server when bumping versions (`docblocks mcp` publishes exactly 19 tools, no
aliases; verify with a `tools/list` against the new tarball).

To bump: add a new `versions/<ver>/manifest.json` with the new tarball's SHA-256
(`Get-FileHash` the `.tgz` from the npm registry) and re-run
`pnpm --filter @bendyline/gezel-catalog build-index`.

## 2. Project-scoped filesystem authority (ChatManager)

`docblocks mcp` starts with **zero filesystem authority** — roots must be granted
as CLI args at spawn. The toolset-spawn loop in
[packages/service/src/chat/manager.ts](../packages/service/src/chat/manager.ts)
(same pattern as the `@playwright/mcp` special-args branch) grants each session
its project scope:

- `--allow-read <workspaceDir> <artifactsDir>` — so file-kind document sources
  (`report.md` in the workspace, a previously saved `.docx` in artifacts) resolve
  via `list_roots`.
- `--allow-write <artifactsDir>` — **artifacts only, never the workspace.**
  Workspace writes stay behind the security-gated builtin tools
  (`allowFileEdits`); the artifacts drawer is the deliberately-ungated output
  surface, and anything DocBlocks saves there shows up in the project's
  Artifacts tab immediately.

DocBlocks physically validates every root at startup, so only directories that
exist are granted (the artifacts drawer is created on demand; an external
`workingDir` is the user's folder and is skipped when missing). Non-builtin
toolsets remain subject to the security ceiling — locked-down postures refuse to
spawn them at all. Coverage:
[manager-docblocks-toolset.test.ts](../packages/service/src/chat/manager-docblocks-toolset.test.ts).

## 3. The craftbooks

Two bundled craftbooks exercise the artifact-first workflow (inspect → convert →
preview → `save_artifact`) end to end, declaring the toolset with
`autoAllow: true` so unattended runs never stall on a permission prompt:

- **`powerpoint-deck`** — PowerPoint from Content: outline → slide-structured
  `deck.md` (one `##` per slide) → `convert_document` to PPTX
  (`slideBreak: h2`, theme, `autoTemplates`) → `preview_document` visual QA →
  `save_artifact` as `deck.pptx`. Gated on the saved artifact
  (`minBytes` with `artifact: true`).
- **`research-to-document`** — Research to Word Document: scope → source log →
  cited `report.md` → `validate_document` → convert to `.docx` (+ `.pdf` on
  request) → preview → save as `report.docx`.

Both differ from the older HTML-deck craftbooks (`content-deck`, `pitch-deck`,
`board-deck`): the deliverable is a real file the user opens in PowerPoint/Word,
not a page.

## Workflow notes for prompt authors

- Conversions are **artifact-first**: `convert_document` returns immutable
  session artifacts; nothing touches disk until `save_artifact`. Saving uses
  no-replace by default — replacing an existing file needs `ifExists: "replace"`
  plus the `expectedSha256` of the current file (available from the earlier
  save/convert result).
- `preview_document` returns page/slide images (max 20 per call) — use it for
  visual QA before saving, and check `previewBasis` before treating pixels as
  native-app rendering.
- Default fidelity is `editable-native` for DOCX/PPTX and `semantic` for most
  other formats. MP4/GIF (and `rendered-fidelity`/`hybrid` PPTX/PDF) need
  Chromium — not granted by default; prefer the native/editable targets.
- Discover vocabulary live (`list_themes`, `list_templates`,
  `list_transform_styles`, `list_formats`) instead of hard-coding IDs in
  prompts.
