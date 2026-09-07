# DocBlocks toolset — real documents and media from Markdown

Gezel ships the [DocBlocks](https://github.com/bendyline/docblocks) MCP server as a
**bundled catalog toolset** (`docblocks`), so gezels can turn markdown into real
Office documents and rendered media — editable `.pptx` and `.docx`, `.pdf`, XLSX,
CSV, HTML, EPUB, DBK, MP4, animated GIF, and (from 2.4.0) single-image dashboard
PNGs — instead of hand-assembling HTML, raw OOXML, or base64.

Three pieces make it native rather than "just another MCP server":

## 1. The bundled toolset

[data/toolsets/do/docblocks/ in bendyline/gilde](https://github.com/bendyline/gilde/tree/main/data/toolsets/do/docblocks)
pins `@bendyline/docblocks-cli` by exact version + tarball SHA-256 and spawns it
as a stdio MCP server via the normal `npm-package` install pipeline
(`node <install>/dist/bin.js mcp`). The version manifest lists all **19 canonical
tools** — that list is load-bearing: craftbook `autoAllow` derives its
pre-authorized tool set from `tools[].name`
(see [docs/craftbook-toolsets.md](craftbook-toolsets.md)), so keep it in sync with
the server when bumping versions (`docblocks mcp` publishes exactly 19 tools, no
aliases; verify with a `tools/list` against the new tarball).

The current authored release is **`@bendyline/docblocks-cli@2.6.1`**, pinned to
tarball SHA-256
`fe150dfc7e966edfdae9fe4b35f5279f7efb94c827306dd35ba2b7faafd8dbd0`.
(The gezel install serves whatever the pinned `@bendyline/gilde` release
carries — check `docblocks-catalog-contract.test.ts` for the version the
current pin actually ships.) Compared with the old 2.0.0 inventory,
`validate_document` is gone and `get_authoring_context` is present. Plain
Markdown needs no validation preflight; conversion reports and previews carry
the useful diagnostics.

**2.4.0 adds squisq dashboards as a conversion target** — no new tool names
(the 19-tool inventory is unchanged, so craftbook `autoAllow` derivations are
unaffected): `convert_document` accepts a `{ format: 'png', resolution?,
width?/height?, layout?, style?, title? }` target that renders the markdown's
top-level blocks as one PNG mosaic (resolution presets `hd`, `fhd` (default),
`4k`, `square`, `square-2k`, `portrait`, `portrait-4k`, `standard`; styles
`basic | card | panel | accent`), plus a `create-dashboard` MCP prompt.
Gezel's own ambient dashboard (see [ADR 0007](decisions/0007-ambient-display-applier.md))
renders through `@bendyline/squisq-cli` directly and does not depend on this
toolset — the `png` target is the agentic, on-demand surface.

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
- Read existing workspace DOCX/PPTX/PDF/XLSX sources with `read_doc_as_markdown`,
  not the text-only `read_file`. Use DocBlocks `inspect_document` for structure,
  tables, theme, and format diagnostics; reopen saved outputs using file sources
  because artifact URIs belong to the MCP session that created them.
- `preview_document` returns bounded visual items (max 20 per call). Check
  `previewBasis`: Office/PDF previews reconstruct imported content and do not
  establish native pagination, fonts, or clipping; MP4/GIF previews currently
  extract only the first frame. Review notes must say what was actually checked.
  The bundled 2.6.1 release delivers inline MCP images with a shared 4 MiB
  encoded budget.
- Default fidelity is `editable-native` for DOCX/PPTX, `rendered-fidelity` for
  MP4/GIF, and `semantic` for most other formats. MP4/GIF (and
  `rendered-fidelity`/`hybrid` PPTX/PDF) need Chromium; MP4/GIF also need
  FFmpeg. Surface a missing media runtime as a blocker instead of substituting
  HTML.
- Discover vocabulary live (`list_themes`, `list_templates`,
  `list_transform_styles`, `list_formats`) instead of hard-coding IDs in
  prompts.

## Real integration evals

The `craftbooks` suite retains its hermetic simulators. Those scorecards are useful
for orchestration, but fake conversion results and Markdown-only checks cannot
prove the DocBlocks integration. The separate `docblocks` suite runs all four
production workflows, installs the real toolset, and requires successful convert,
preview, and save calls plus valid saved binary containers. It observes the
craftbook's own repair routing; the eval does not tell an active researcher to
write the final document early.

```sh
pnpm eval:all --suite docblocks --count 1 --provider mlx --model <installed-model>

# Test a built local CLI without changing product configuration or release pins.
GEZEL_EVAL_DOCBLOCKS_DIR=/absolute/path/to/docblocks/packages/cli \
  pnpm eval:all --suite docblocks --count 1 --provider mlx --model <installed-model>

# Deterministic real-MCP probe: PPTX/DOCX/PDF/XLSX/CSV/MP4/GIF, previews, restart.
GEZEL_EVAL_DOCBLOCKS_DIR=/absolute/path/to/docblocks/packages/cli \
  node scripts/run-with-dependency-lease.mjs --direct-node evals/src/bin/docblocks-smoke.ts
```

Build the CLI before running. Keep that build fixed for the duration of a matrix;
an isolated package copy is useful during iteration. Local overrides record the
actual package version and entry SHA-256 alongside the catalog identity in
`docblocks-eval-provenance.json`. Chromium is required for visual previews and
FFmpeg for media; run in an environment that can launch them. The smoke probe
retains evidence, real outputs, and returned preview PNGs for inspection.
Set `SQUISQ_FFMPEG` to an absolute FFmpeg executable path if it is not discoverable
on `PATH`; the smoke probe forwards this override to the MCP server.

The override is installed in the shared toolset roster, and scenario setup checks
its resolved path. A system-scoped override can otherwise be shadowed by a
shared published install and silently test the wrong CLI.

Craftbook review success should advance to publishing or finishing by default;
only a named defect should route back to writing. DocBlocks publishing roles
must be reasoning roles: the `video-generator` role dispatches `generate_video`
directly and cannot follow a multi-tool DocBlocks procedure. Render GIF and MP4
in separate calls with explicit dimensions and frame rates so each receives its
own operation budget.

The current `consumes` contract synthesizes `read_file`/`read_artifact` text-read
instructions. Keep native binaries in format-aware procedure instructions and
output gates until required-input metadata can name a native reader. Markdown
artifacts remain declared inputs. `read_artifact` and `read_files` supply requested
text slices and pagination fields in both text and structured MCP results;
batched reads also preserve item-level errors.

Run DocBlocks' own `npm run eval:mcp -- run --suite full` as complementary
PowerPoint/Word content coverage. Its content/grounding scores and native package
checks are distinct from Gezel's multi-role completion gates. Neither substitutes
for opening the saved files in Word or PowerPoint when assessing native fidelity.
