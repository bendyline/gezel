# Outside-in document editing

Gezel's project file viewer recognizes HTML, DOCX, PDF, PPTX, and XLSX files as
outside-in documents. The rendered file stays visible in the Workspace or
Artifacts tree; selecting it mounts Markdown from a hidden sibling companion:

```text
Tucson.pptx
Tucson_files/
  tucson.md
  map.png
  .versions/
```

If the companion does not exist, Gezel imports the rendered file through
Squisq's format registry and creates it. Subsequent saves write the Markdown
source and regenerate the rendered file. The editor's media and version-history
providers are rooted at the companion folder, so the full editable document
travels together.

HTML uses a shared player runtime. Gezel finds the nearest ancestor `_squisq`
folder, falling back to the project root, and writes
`_squisq/squisq-player.js`. The generated page refers to that runtime and to
media inside its own companion directory.

Artifact documents are always editable. Workspace documents follow the normal
workspace authority rule: internal workspaces are user-writable, while an
external working directory must have project writes enabled before Gezel may
create or save a companion. The HTTP client uses separate text and raw-byte
write endpoints so rendered output is never UTF-8 round-tripped.

The portable path/frontmatter contract is owned by Squisq's
`@bendyline/squisq-formats/outside-in` entry. Gezel's UI adapter is intentionally
implemented over the currently pinned registry primitives and mirrors that
contract, allowing the app and Squisq packages to be released independently.
