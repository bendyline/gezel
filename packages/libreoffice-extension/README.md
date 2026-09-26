# Gezel for LibreOffice

A LibreOffice extension (`gezel.oxt`) that adds a **Gezel** panel to Writer,
Calc, and Impress. The panel connects to the Gezel app on the same computer,
chats with the project's gezels about the open document, and offers them
document tools so they can read it and make the edits the user asks for.

It ships inside the Gezel service bundle (`dist/libreoffice/gezel.oxt`) and is
installed for the current user by the desktop app: Settings, Connected Apps,
**Use Gezel in LibreOffice**. That runs LibreOffice's own installer,
`unopkg add -f -s gezel.oxt` (per user; never `--shared`).

## Layout

| Path | What |
|---|---|
| `src/description.xml`, `src/META-INF/manifest.xml` | Extension identity (`com.bendyline.gezel`) and contents |
| `src/Addons.xcu` | **Tools > Gezel**, which opens the sidebar deck |
| `src/Sidebar.xcu`, `src/Factory.xcu` | The Gezel deck and panel, and the panel factory |
| `src/ProtocolHandler.xcu` | The `com.bendyline.gezel:` command protocol |
| `src/python/gezel_ext.py` | UNO component entry: protocol handler and panel factory |
| `src/python/pythonpath/gezel/` | The package; LibreOffice puts `pythonpath/` on `sys.path` |
| `scripts/build-oxt.mjs` | Deterministic `.oxt` build (the daemon detects updates by hash) |

Pure modules (`discovery`, `client`, `consent`, `relay`, `chat`, `project`,
`toolspec`) have stdlib-only unit tests. UNO modules (`dispatch`, `uno_docs`,
`panel`) need LibreOffice.

## How it connects

1. Reads `~/.gezel/runtime/port` and `runtime/cert.pem` (`GEZEL_HOME` is
   honored) and verifies TLS against that per-launch certificate.
2. Asks for a `product` grant as app `libreoffice`. The first time, the panel
   shows a connection code; the user approves it in Gezel. The token is kept
   at `~/.gezel/integrations/libreoffice/token` (0600).
3. Maps the document to a project through the daemon's folder inference
   (`POST /api/projects/infer-for-path`), chats through `/api/sessions`, and
   registers its document tools through the app-tool relay while the panel is
   open. Tool names match the Office pane: `doc_*` (Writer), `sheet_*` (Calc),
   `slide_*` (Impress), and `office_*` for all three.

## Build and test

```sh
pnpm --filter @bendyline/gezel-libreoffice-extension build     # dist/gezel.oxt
pnpm --filter @bendyline/gezel-libreoffice-extension test       # builder tests
pnpm --filter @bendyline/gezel-libreoffice-extension test:py    # Python unit tests
```

## Manual smoke test

The UNO layer can only be exercised inside LibreOffice. With Gezel running:

1. Close LibreOffice, then install the build:
   ```sh
   # macOS
   /Applications/LibreOffice.app/Contents/MacOS/unopkg add -f -s dist/gezel.oxt
   # Windows
   "C:\Program Files\LibreOffice\program\unopkg.exe" add -f -s dist\gezel.oxt
   # Linux
   unopkg add -f -s dist/gezel.oxt
   ```
2. Open a Writer document saved in a folder, then **Tools > Gezel**. The
   sidebar opens on the Gezel deck.
3. Click **Connect to Gezel**. A connection code appears; approve it in Gezel
   under Connected Apps. The panel shows the project and a gezel picker.
4. Select a paragraph and send "Summarize my selection". The transcript shows
   a `[doc_read_selection]` line, then the reply.
5. Ask for an insertion ("Add a heading 'Next steps' at the end"). The text
   appears in the document.
6. Clear **Allow edits** and ask again; the gezel no longer has a write tool.
7. Repeat a read in Calc (`sheet_read_range`) and a slide insert in Impress
   (`slide_insert`).
8. Remove: `unopkg remove com.bendyline.gezel` (LibreOffice closed).

Logs: `~/.gezel/logs/libreoffice-extension.log`.

On Linux distributions that split Python scripting out of LibreOffice, install
the Python script provider (for example `libreoffice-script-provider-python`)
first.
