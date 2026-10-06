---
id: memory-and-documents
title: Memory, documents, and the shared library
order: 4
summary: What your gezellen remember, and where shared knowledge lives.
---

# Memory, documents, and the shared library

## Gezel memory

Each gezel keeps a diary. As you work together they save notes — decisions you made, preferences you expressed, lessons learned — into daily memory files they can search later. Ask your copywriter for "that tagline direction we agreed on in March" and they can actually look it up.

Memories are per-gezel and per-project: your reviewer's notes about code style don't leak into your researcher's notes about sources.

## The document library

**Documents** are shared knowledge — the things every gezel should know. Your company boilerplate, your house style guide, the family holiday schedule. The library has two levels:

- **The shared library** — available to every gezel in every project.
- **Project documents** — the About and Mission Objectives of each project, plus anything else scoped to just that work.

Gezels can read and (where you allow it) write documents themselves, so the library grows as your crew works.

## Reference catalogs

You can also install **knowledge catalogs**: portable `.gezk` files containing reference documents and prepared search indexes. Your crew can search and cite them alongside project files and memories. The built-in Handboek uses this same format. Installing a catalog adds reference material; it does not train your chat model.

For the technical details, see [How knowledge works in Gezel](../technical/how-knowledge-works.md). To make or install one, see [Working with knowledge catalogs](../technical/knowledge-command-line.md).

## The history log

Gezel keeps an **audit log** of meaningful events: who created which gezel, when a project's mission changed, which tools ran. The History tab lets you filter and search it — and your gezellen can search it too, which means "did anyone change the mission this week?" is a question they can answer truthfully rather than guess at.

## Everything is a file

Memories are Markdown files, your library keeps its original documents, and the history log is a file. Reference catalogs carry their documents and indexes in portable `.gezk` archives built from SQLite and other open formats. If you want to inspect what Gezel knows, the [Where files live](../technical/where-files-live.md) and [How knowledge works](../technical/how-knowledge-works.md) articles map the source files and search databases.
