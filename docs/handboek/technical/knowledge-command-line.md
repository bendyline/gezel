---
id: knowledge-command-line
title: Working with knowledge catalogs
order: 9
summary: Build, validate, search, install, remove, and export .gezk catalogs with the gezel command line.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# Working with knowledge catalogs

The `gezel knowledge` commands let you turn Markdown into a portable `.gezk` catalog, inspect and search an existing archive, and manage the reference catalogs installed in your Gezel home. For the storage and retrieval design, see [How knowledge works in Gezel](how-knowledge-works.md). The open format, including its versioned specifications and independent reader, lives in [bendyline/gezk](https://github.com/bendyline/gezk).

## Set up the command line

Install the CLI with Node.js 24 or newer:

```bash
npm install -g @bendyline/gezel-cli
gezel knowledge --help
```

Building a catalog and adding `--semantic` to file search need the optional embedding runtime. The desktop app includes it. For a global npm CLI installation, add it in the same installation context:

```bash
npm install -g @huggingface/transformers@^3.8.1
```

For a project-local CLI installation, install both packages in that project and run commands with `npx gezel`. Plain keyword search, inspection, validation, and location discovery do not need the embedding model. Building and semantic search can download the profile's pinned model on first use; later runs can work offline from its cache. By default, the CLI cache is `<GEZEL_HOME>/engines/hf-cache`, or `~/.gezel/engines/hf-cache`; `GEZEL_HF_CACHE_DIR` overrides it.

There are two command groups:

| Commands | Connection |
| --- | --- |
| `init`, `build`, `inspect`, `validate`, `search`, `nearby`, `export-parquet` | Work on files without the Gezel daemon |
| `available`, `install`, `list`, `find`, `remove` | Connect to your user daemon and can start it when absent |

File commands operate on a named source folder, archive, or extracted catalog. Installed-catalog commands use the daemon's registry. The [general CLI reference](cli-reference.md) explains home selection, local discovery, and explicit external connections.

## Build your first catalog

This example creates a catalog called `team-guide`:

```bash
gezel knowledge init ./team-guide
```

The new folder contains `catalog.json` and a sample Markdown document under `content/`. Replace the sample with your reference material, and edit the catalog identity, publisher, language, and license before distributing it.

```text
team-guide/
  catalog.json
  content/
    Getting Started/
      welcome.md
    Policies/
      expenses.md
      writing-style.md
```

A complete configuration might be:

```json
{
  "id": "team-guide",
  "version": "1.0.0",
  "name": "Team Guide",
  "description": "Our working practices and policies.",
  "language": "en",
  "publisher": { "id": "example-team", "name": "Example Team" },
  "license": { "name": "All rights reserved", "attributionRequired": false },
  "profile": "bge-small-en-v1.5@1",
  "createdAt": "2026-10-05T00:00:00.000Z"
}
```

`createdAt` is optional; pin it when you want repeat builds from identical inputs to retain the same declared timestamp. The license describes your content, so replace the example with the terms that apply to your documents.

Build, check, and search the archive:

```bash
gezel knowledge build ./team-guide
gezel knowledge inspect ./team-guide/team-guide-1.0.0.gezk
gezel knowledge validate ./team-guide/team-guide-1.0.0.gezk --deep
gezel knowledge search ./team-guide/team-guide-1.0.0.gezk "expenses"
gezel knowledge search ./team-guide/team-guide-1.0.0.gezk "How do I claim travel costs?" --semantic
```

The default output is `<dir>/<id>-<version>.gezk`. The build reports document, chunk, shard, and archive-size counts. Search prints document and passage references as `knowledge://` URIs.

Once the checks pass, install it for your crew:

```bash
gezel knowledge install ./team-guide/team-guide-1.0.0.gezk
gezel knowledge list
gezel knowledge find "How do I claim travel costs?"
```

Install enables the catalog for search. A project's catalog policy can still select a narrower set or switch reference catalogs off. Use the Knowledge settings and project settings to control that selection.

## Catalog an existing documentation tree

You can initialize a folder that already contains Markdown:

```bash
gezel knowledge init ./existing-docs
gezel knowledge build ./existing-docs --out ./existing-docs.gezk
```

`init` creates `catalog.json` without inserting a sample `content/` folder when it detects an existing Markdown tree. It refuses to overwrite an existing `catalog.json`.

For a text-only catalog, run `gezel knowledge build ./existing-docs --skip-images`. Images are bundled for display; they are not embedded by the text embedding model. `--skip-images` keeps image alt text without resolving or reading the image files, avoiding the catalog's 256 MiB total asset limit. For a larger illustrated collection, split it into multiple catalogs.

The build warns and skips images with mismatched or unrecognized file data, images over the per-file size limit, and unsafe SVGs. References to a skipped image become their alt text (or link label), preserving the surrounding document. Valid images are still included, and source files are unchanged.

The build locates content in this order: the explicit `content` setting; a `content/` subfolder; an applicable MkDocs `docs_dir`; otherwise the catalog folder itself. It detects common table-of-contents formats, or uses folders as topics. Supported outlines include GitBook `SUMMARY.md`, MkDocs `nav`, Jupyter Book `_toc.yml`, DocFX `toc.yml`, and Hugo `_index.md` conventions.

You can make the selection explicit in `catalog.json`:

```json
{
  "content": "docs",
  "ignore": ["draft.md"],
  "toc": { "format": "gitbook", "path": "SUMMARY.md" }
}
```

These are additional fields in the complete configuration, not a replacement for its required identity fields. `content` is relative to the catalog folder; `ignore` names Markdown files relative to the content root. An explicit TOC `path` is resolved from the content root. Without a TOC file, use `"toc": { "format": "folders" }` to request folder-based organization.

Choose an embedding profile appropriate to the documents: `bge-small-en-v1.5@1` for the default English build, or `multilingual-e5-small@2` for multilingual retrieval. The earlier `multilingual-e5-small@1` remains supported for existing catalogs. A profile is a complete vector-space contract; changing it requires rebuilding the catalog.

## File command reference

| Command | Arguments and options | Result |
| --- | --- | --- |
| `gezel knowledge init <dir>` | A new folder or an existing Markdown tree | Create the catalog configuration and, for a new tree, sample content |
| `gezel knowledge build <dir>` | `--out <file>`, `--sign-key <pemfile>`, `--skip-images` | Compile Markdown, assets, and indexes into a `.gezk` archive |
| `gezel knowledge inspect <path>` | Archive or extracted catalog directory | Show manifest identity, license, counts, profiles, signature metadata, and sizes |
| `gezel knowledge validate <path>` | `--deep` | Verify declared files, hashes, schema, and counts; deep mode adds database/vector checks |
| `gezel knowledge search <path> <query>` | `--semantic`, `--limit <n>`, optional radius options | Search that file or extracted catalog; default limit 10, clamped to 1–50 |
| `gezel knowledge nearby <path>` | Required radius options; `--limit <n>`, `--json` | List subject articles near a point; default page size 50, maximum 500 |
| `gezel knowledge export-parquet <path>` | `--out <dir>`, `--duckdb <binary>` | Export catalog tables and stored embeddings using DuckDB |

`inspect` reads the manifest; it is not a full validation or signature-trust check. `validate --deep` checks SQLite `quick_check`, chunk/vector row alignment, self-neighbor search, and the catalog's declared keyword smoke queries. These structural checks do not require downloading an embedding model or prove publisher identity.

File `search` always includes keyword search. `--semantic` additionally loads the catalog profile's model and prepends semantic passage hits before deduplication; it does not use the daemon's complete installed-catalog rank-fusion pipeline. If explicitly requested semantic embedding cannot run, the command reports an error. Compare it with a plain keyword search when diagnosing model availability.

## Search by location

Catalogs with subject coordinates can be searched within a radius:

```bash
gezel knowledge nearby ./places.gezk --latitude 52.3676 --longitude 4.9041 --radius-meters 5000 --json
gezel knowledge search ./places.gezk "museum" --latitude 52.3676 --longitude 4.9041 --radius-meters 5000 --limit 10
```

Pass all three options together: `--latitude`, `--longitude`, and `--radius-meters`. You can also add `--semantic` to the radius-filtered search. `nearby` returns subject articles ordered by distance; a document's associated places do not make it a subject match. Location support depends on metadata shipped by the producer, and a catalog without that metadata does not acquire coordinates through search.

## Installed catalog command reference

| Command | Arguments and options | Result |
| --- | --- | --- |
| `gezel knowledge available` | None | List Gilde offerings, versions, sizes, install state, and available updates |
| `gezel knowledge install <source>` | Catalog id, local file, or HTTP(S) URL | Install and enable the catalog, following progress until completion |
| `gezel knowledge list` | None | Show installed versions, enabled/mounted state, quarantine reasons, and update flags |
| `gezel knowledge find <query>` | `--limit <n>`; default 10 | Search installed catalogs through the daemon |
| `gezel knowledge remove <catalogId>` | Installed catalog id | Remove your registry reference and its private catalog files |

For a Gilde catalog, copy its id from `available`:

```text
gezel knowledge available
gezel knowledge install <catalog-id>
gezel knowledge install <catalog-id> --version <version>
gezel knowledge install <catalog-id> --private
```

`--version` and `--private` apply only to catalog-id installs. Public catalog bytes may be shared once per machine through the engine broker; `--private` keeps that download in your own Gezel home. Local files and arbitrary URL imports are private already.

For a URL, you can supply the expected archive SHA-256:

```text
gezel knowledge install https://example.org/team-guide-1.0.0.gezk --sha256 <64-hexadecimal-character-digest>
```

The digest is the archive's hash, not a manifest file hash. Obtain it through a source you trust. The `--sha256` option is valid only for URL installs.

To update a catalog, install its catalog id again or install the replacement archive. There is currently no separate `knowledge update` command. `available` and `list` report newer catalog versions known to Gilde. The current CLI has no `knowledge enable` or `knowledge disable` subcommands; use Knowledge settings or the HTTP patch endpoint below.

`find` searches your installed catalogs directly. It does not select the project for the current directory or apply that project's catalog policy. For the session-scoped search used by a gezel, use its `search` tool.

Removing a private catalog deletes the daemon's installed copy, not the original `.gezk` archive you supplied. Removing a shared catalog removes your reference; public shared bytes have a separate reclamation lifecycle. The bundled Handboek is managed by Gezel and cannot be removed through this command; disable it in Knowledge settings if needed.

## Sign and export a catalog

If you have an Ed25519 private key in PKCS#8 PEM form, sign at build time:

```bash
gezel knowledge build ./team-guide --out ./team-guide-signed.gezk --sign-key ./publisher-key.pem
```

The signature covers the canonical manifest, whose file list contains the payload digests. Keep the signing key separate from content you distribute. `inspect` reports signature presence and key id; origin verification requires a reader to verify it against a trusted public key. The format package exposes `verifyManifestSignature` for that purpose.

For analysis in a columnar data tool, export a companion:

```bash
gezel knowledge export-parquet ./team-guide-signed.gezk --out ./team-guide-parquet
```

The command needs the DuckDB CLI installed by Gezel, a discoverable DuckDB executable, or an explicit `--duckdb <binary>` / `GEZEL_DUCKDB_BIN`. It exports topics, documents and chunks by shard, and document locations when present, with the stored int8 and binary embeddings and profile metadata. It also writes `parquet-manifest.json`. It does not regenerate float32 embeddings or change the `.gezk` archive.

## Manipulate knowledge through tools and APIs

Gezels use `search` to retrieve admitted project and reference material, `read_document` to open `knowledge://` citations, and `knowledge_nearby` for subject-location discovery. `save_memory`, `search_memory`, and `list_memories` manage the mutable memory sources. These tool names are distinct from CLI subcommands; there is no `gezel knowledge save-memory` command.

For your editable shared library, `list_documents`, `read_document`, `write_document`, and `delete_document` operate on the library's original files, subject to the tool and security policy. Installed catalog documents remain read-only; change their source and build a new archive to publish a revision.

Applications can use `@bendyline/gezel-client` against the authenticated user daemon. The main product endpoints are:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/knowledge/catalogs`, `GET /api/knowledge/available`, `GET /api/knowledge/updates` | Installed state, available catalogs, and known updates |
| `POST /api/knowledge/install` | Start an install job and return its id |
| `GET /api/knowledge/jobs/:jobId/events` | Subscribe to install progress as server-sent events |
| `DELETE /api/knowledge/jobs/:jobId` | Explicitly cancel an install |
| `PATCH /api/knowledge/catalogs/:catalogId` | Set enabled state with, for example, `{ "enabled": false }` |
| `DELETE /api/knowledge/catalogs/:catalogId` | Remove an installed reference and private bytes |
| `POST /api/knowledge/search`, `POST /api/knowledge/nearby` | Search or discover installed catalog documents |
| `GET /api/knowledge/catalogs/:catalogId/topics` | Browse the shipped topic tree |
| `GET /api/knowledge/catalogs/:catalogId/documents` | Page document metadata |
| `GET /api/knowledge/catalogs/:catalogId/document?id=<documentId>` | Read a complete document |
| `GET /api/knowledge/catalogs/:catalogId/passage?id=<documentId>&chunk=<uid>` | Read a cited passage |
| `POST /api/memory/save`, `POST /api/memory/search` | Save and retrieve mutable memories |

URL-encode document ids in query parameters; they can contain slashes and Unicode. Install and catalog-management routes require the first-party management boundary, rather than a model session token. A progress subscriber can disconnect without cancelling an install; use the explicit cancel endpoint when that is the intended action.

For an independent compiler or reader, use [`@bendyline/gezel-knowledge`](https://github.com/bendyline/gezel/tree/main/packages/knowledge). For the schemas, citation grammar, quantization, and signature helpers, use [`@bendyline/gezk`](https://github.com/bendyline/gezel/tree/main/packages/gezk). The [specification repository](https://github.com/bendyline/gezk), [Python reader](https://github.com/bendyline/gezk/tree/main/reference/python), and [conformance kit](https://github.com/bendyline/gezk/tree/main/conformance) support implementations outside Gezel.
