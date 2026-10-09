---
id: where-files-live
title: Where files live
order: 2
summary: The gezel home folder, mapped.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# Where files live

Everything gezel knows lives in one folder — the **gezel home** — as plain files. On macOS and Linux that's `~/.gezel` in your home directory (a machine-wide service uses a system location instead; Settings shows the active path).

```
~/.gezel/
  config.json         provider choice, default model, the current Meester
                      (API keys go to your system keychain, not here)
  gezels/
    {gezel}/
      gezel.md        name, role, model choice
      about.md        the gezel's character
      poppetje.json   the carved-figure look
      sessions/       chat threads, one file each
      memories/       daily notes + lessons
  projects/
    {project}/
      project.json    name, working folder, crew settings
      documents/      About + Mission Objectives
      index/          the project's search index: summaries, descriptions,
                      reviews (rebuildable; kept here, not in your folder)
      artifacts/      everything the crew produces
        shadow/       machine-made markdown twins of workspace documents,
                      pictures, and recordings (rebuilt automatically —
                      safe to delete, not a place to put your own files)
  documents/          the shared library
  memories/           what your gezels have learned about you ("About you"),
                      shared by all of them
  ambient/            ambient dashboard images (dated PNGs + latest.png),
                      made to be shown as wallpaper or lock screen
  integrations/
    office/           Word/Excel/PowerPoint: the add-in manifests, and the
                      certificate the Office pane is served with (its private
                      keys stay here, readable only by you)
    libreoffice/      the LibreOffice extension's connection token
    vscode/, codex/…  the other Connected Apps setups
  history.jsonl       the audit log
  logs/               service logs (rolling)
```

## Folders you add

A folder you add to gezel — Pictures, Documents, a code repository — stays where it is. Gezel reads it in place and writes nothing into it: the search index, photo descriptions and summaries for that folder live under `projects/{project}/` in the gezel home. A file in your folder changes only when you apply a change you approved. Earlier versions kept the index in a hidden `.gezel` folder inside yours; gezel moves it out the first time it starts.

## What you can safely do

- **Read anything.** It's your data; nothing breaks by looking.
- **Back up or sync the whole folder.** Copying the folder copies your entire workshop.
- **Edit with care.** Character files (`about.md`) and documents are meant to be edited — from the app or any text editor. For structured files (`config.json`, thread files), prefer the app so nothing gets malformed.

A few subfolders are machinery rather than your data — `runtime/`, `service/`, `bin/`, `index/`, `logs/` hold the service's own working state and rebuildable caches. Leave those to gezel; deleting them is at worst an inconvenience, never data loss. The `ambient/` folder is regenerated too — point your wallpaper or lock-screen slideshow at it freely, but don't store your own images there.
