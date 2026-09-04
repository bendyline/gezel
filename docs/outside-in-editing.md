# Outside-in document editing

Gezel's project file viewer recognizes HTML, DOCX, PDF, PPTX, XLSX, and CSV
files as outside-in documents. The rendered file stays visible in the
Workspace or Artifacts tree; selecting it mounts Markdown from a hidden sibling
companion:

```text
Tucson.pptx
Tucson_files/
  tucson.md
  map.png
  .original/
    original.pptx
  .versions/
```

CSV and XLSX imports use Squisq's data-sidecar thresholds. A CSV with more than
100 data rows or more than 256 KiB, or an XLSX region with more than 100 rows or
2,000 cells, stays byte-for-byte in the imported container under
`<doc-slug>_files/data/<source-file>`. Its Markdown companion contains a
`{[dataTable src=...]}` reference instead of thousands of inline table rows.
The editor resolves that reference through the companion's media and content
container and displays Squisq's virtualized data grid. Smaller datasets remain
inline Markdown tables. CSV companions are preview-only for now: the current
CSV exporter does not yet materialize a sidecar reference when regenerating the
visible source, so Gezel does not offer the Markdown-editing opt-in for them.

If the companion does not exist, Gezel imports the rendered file through
Squisq's format registry and creates it. For formats that support round-trip
export, imported Markdown is read-only until the user chooses **Allow editing
via markdown** from the rendered file's context menu. That action first writes
a create-only backup to
`<stem>_files/.original/original.<format>`, then adds
`squisq-updatefrommarkdown: true` to the companion frontmatter. Subsequent saves
are serialized automatically as the user edits: each acknowledged Markdown
write regenerates the rendered file. The editor's media
and version-history providers are rooted at the companion folder, so the full
editable document travels together.

HTML uses a shared player runtime. Gezel finds the nearest ancestor `_squisq`
folder, falling back to the project root, and writes
`_squisq/squisq-player.js`. The generated page refers to that runtime and to
media inside its own companion directory.

Artifact documents and writable workspace documents both require the explicit
Markdown-editing opt-in. Workspace documents also follow the normal workspace
authority rule: internal workspaces are user-writable, while an external
working directory must have project writes enabled before Gezel may create or
save a companion. Backups use an atomic create-only raw-byte write, so a later
opt-in cannot replace the restorable original. Rendered output is never UTF-8
round-tripped.

The shared **Documents** library uses the same companion layout. Dropping a
DOCX, PDF, PPTX, XLSX, CSV, or HTML file into either half of the Documents
screen is an import, not an editing opt-in: Gezel first stores the rendered file
byte-for-byte, keeps that filename selected, and creates a read-only Markdown
companion when it opens the preview. For round-trip formats, **Enable outside-in
editing** then writes the byte-exact recovery copy and opts the companion into
regenerating the rendered file. Markdown and other supported text-document
drops are stored directly. A colliding filename receives a numbered suffix
rather than replacing the existing document.

The chat **References** rail resolves these formats through the same companion
contract. Artifact and shared-library references reuse their adjacent
`<stem>_files/<stem>.md` companion; workspace references use the project's
home-side `artifacts/shadow/<full-basename>_files/<stem>.md` twin so previewing
an external or read-only workspace never writes into it. PPTX companions open
in slideshow mode, while DOCX, PDF, and XLSX companions use the linear document
view. If conversion is unavailable or blocked, the rail falls back to the
native machine-file actions.

The portable path/frontmatter contract is owned by Squisq's
`@bendyline/squisq-formats/outside-in` entry. Gezel's UI adapter is intentionally
implemented over the currently pinned registry primitives and mirrors that
contract, allowing the app and Squisq packages to be released independently.
