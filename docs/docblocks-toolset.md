# DocBlocks toolset — real documents and media from Markdown

Gezel ships the [DocBlocks](https://github.com/bendyline/docblocks) MCP server as a
**bundled catalog toolset** (`docblocks`), so gezels can turn markdown into real
Office documents and rendered media — editable `.pptx` and `.docx`, `.pdf`, XLSX,
CSV, HTML, EPUB, DBK, MP4, and animated GIF — instead of hand-assembling HTML,
raw OOXML, or base64.

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

The current bundled release is **`@bendyline/docblocks-cli@2.3.2`**, pinned to
tarball SHA-256
`642f3f054b2ac76487ab869a5cf3dd1c7bec55853b3093f4e09e4b98232229ca`.
Compared with the old 2.0.0 inventory, `validate_document` is gone and
`get_authoring_context` is present. Plain Markdown needs no validation preflight;
conversion reports and previews carry the useful diagnostics.

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

Four bundled craftbooks exercise the Markdown → convert → preview →
`save_artifact` workflow end to end, declaring the toolset with `autoAllow: true`
so unattended runs never stall on a permission prompt:

- **`powerpoint-deck`** — PowerPoint from Content: outline → slide-structured
  `deck.md` (one `#` per slide) → `convert_document` to editable PPTX
  (`slideBreak: h1`, theme, `autoTemplates`) → preview → save `deck.pptx`.
- **`research-to-document`** — Word Document from Content or Research: scope →
  supplied/researched source log → `report.md` → one conversion to `.docx`
  (+ `.pdf` on request) → preview → save. There is no obsolete
  `validate_document` call.
- **`report-pdf`** — Formatted PDF Report: outline → complete `report.md` →
  direct PDF conversion → page preview → save `report.pdf`. The legacy
  `report.html`/print-CSS phase and generic Developer are gone.
- **`narrated-slideshow`** (displayed as Animated Content Slideshow) — outline →
  `slideshow.md` (one `#` per scene) → one atomic MP4+GIF conversion → frame
  previews → save both rendered files. The legacy HTML player is gone.

All four gate on the real saved artifact (`minBytes` with `artifact: true`).
Their production roles are content/design specialists, not Developers hired solely
to make an intermediary page.

## Workflow notes for prompt authors

- Conversions are **artifact-first**: `convert_document` returns immutable
  session artifacts; nothing touches disk until `save_artifact`. Saving uses
  no-replace by default — replacing an existing file needs `ifExists: "replace"`
  plus the `expectedSha256` of the current file (available from the earlier
  save/convert result).
- Call `list_roots` first for durable output. Prefer a file source such as
  `{ "kind": "file", "rootId": "<workspace>", "path": "report.md" }` so
  DocBlocks reads the Markdown directly from its granted project root.
- Plain Markdown converts directly. Call `get_authoring_context` only when exact
  target, template, theme, transform, or annotation guidance would materially
  help; do not turn it into a mandatory preflight.
- `preview_document` returns page/slide images (max 20 per call) — use it for
  visual QA before saving, and check `previewBasis` before treating pixels as
  native-app rendering.
- Default fidelity is `editable-native` for DOCX/PPTX, `rendered-fidelity` for
  MP4/GIF, and `semantic` for most other formats. MP4/GIF (and
  `rendered-fidelity`/`hybrid` PPTX/PDF) need Chromium; MP4/GIF also need
  FFmpeg. Surface a missing media runtime as a blocker instead of substituting
  HTML.
- Discover vocabulary live (`list_themes`, `list_templates`,
  `list_transform_styles`, `list_formats`) instead of hard-coding IDs in
  prompts.
