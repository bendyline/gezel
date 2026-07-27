---
id: where-files-live
title: Where files live
order: 2
summary: The gezel home folder, mapped.
---

# Where files live

Everything gezel knows lives in one folder — the **gezel home** — as plain files. On macOS and Linux that's `~/.gezel` in your home directory (a machine-wide service uses a system location instead; Settings shows the active path).

```
~/.gezel/
  config.json         providers, default model, the current Meester
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
      artifacts/      everything the crew produces
  documents/          the shared library
  history.jsonl       the audit log
  logs/               service logs (rolling)
```

## What you can safely do

- **Read anything.** It's your data; nothing breaks by looking.
- **Back up or sync the whole folder.** Copying the folder copies your entire workshop.
- **Edit with care.** Character files (`about.md`) and documents are meant to be edited — from the app or any text editor. For structured files (`config.json`, sessions), prefer the app so nothing gets malformed.

A few subfolders are machinery rather than your data — `runtime/`, `service/`, `bin/`, `index/`, `logs/` hold the service's own working state and rebuildable caches. Leave those to gezel; deleting them is at worst an inconvenience, never data loss.
