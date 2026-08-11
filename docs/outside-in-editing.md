# Outside-in document editing

Gezel's project file viewer recognizes HTML, DOCX, PDF, PPTX, and XLSX files as
outside-in documents. The rendered file stays visible in the Workspace or
Artifacts tree; selecting it mounts Markdown from a hidden sibling companion:

```text
Tucson.pptx
Tucson_files/
  tucson.md
  map.png
  .original/
    original.pptx
  .versions/
```

If the companion does not exist, Gezel imports the rendered file through
Squisq's format registry and creates it. Imported Markdown is read-only until
the user chooses **Allow editing via markdown** from the rendered file's context
menu. That action first writes a create-only backup to
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
DOCX, PDF, PPTX, XLSX, or HTML file into either half of the Documents screen is
an import, not an editing opt-in: Gezel first stores the rendered file
byte-for-byte, keeps that filename selected, and creates a read-only Markdown
companion when it opens the preview. **Enable outside-in editing** then writes
the byte-exact recovery copy and opts the companion into regenerating the
rendered file. Markdown and other supported text-document drops are stored
directly. A colliding filename receives a numbered suffix rather than replacing
the existing document.

The portable path/frontmatter contract is owned by Squisq's
`@bendyline/squisq-formats/outside-in` entry. Gezel's UI adapter is intentionally
implemented over the currently pinned registry primitives and mirrors that
contract, allowing the app and Squisq packages to be released independently.
