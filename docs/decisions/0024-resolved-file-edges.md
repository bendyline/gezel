# 0024 — Resolved file edges are an index artifact

Status: Accepted (2026-10). Amends [0005](0005-indexing-3.0.md) (the static
pass gains a resolution step) and the Village stability contract in
[ux.md](../ux.md).

## Context

The index has stored raw import rows since v6 (`imports`: an importer and the
specifier it wrote), but never what they point at. `imports.dst_path` was
declared and always written NULL. Every reader resolved the rows itself, on
every call: the Village build, the file context behind the code viewer, and
taint tracing. All of them used one resolver that understood only specifiers
starting with `.`, so in practice only relative JS/TS imports. That missed:

- workspace packages (`@scope/pkg`), so a monorepo's packages never connected
  (the Village's "inter-package boulevards carry only frontage");
- tsconfig `paths` and `baseUrl`;
- Python, Go, Rust and C dependencies, including Python's own relative imports;
- documents linking to files.

The project Views tab needs that graph to draw a dependency diagram, fill the
inspector's connections, and later feed reports. Resolving it per request at
repo scale (≈8k edges here) is wasteful, and a graph that changes with each
reader's resolver is not one a person can trust.

## Decisions

### The graph is a table, rebuilt wholesale

`file_edges(src_path, dst_path, raw_specifier, kind, resolver, bindings, flags)`
(schema v15). It is a separate table, not `imports.dst_path`, for two reasons:
one specifier can name several files (a Go package, Python's
`from . import a, b`), and `putImports` deletes a file's rows on every
re-extract. `kind` is `import` (code), `include` (C/C++) or `link` (a document).
`resolver` names the rule that found the edge.

Resolution runs at the end of every static pass (`refreshFileEdges`, in the
static worker). It is skipped when nothing it reads changed: a fingerprint
covers every file's path and hash (so a moved or edited manifest counts) plus
every import row (so an extractor upgrade counts), and is stamped with
`EDGE_RESOLVER_VERSION`. Otherwise the whole table is recomputed in memory and
swapped in one transaction. Tens of milliseconds at this repo's size, and
correct where an incremental update is not: a new file can satisfy a specifier
nothing resolved before.

### Resolvers, by the importer's language

| Resolver | Rule |
|---|---|
| `relative` | The Village's original probe, unchanged |
| `ts-paths` | The nearest tsconfig/jsconfig (following relative `extends`): `paths` by longest prefix, then `baseUrl` |
| `workspace` | A package.json `name`; `exports` (source/types/import conditions first) or `main`, mapped from `dist/` back to `src/` |
| `py-rel` / `py-abs` | Leading dots climb folders; absolute imports from the root, `src/`, and pyproject/setup folders; imported names that are submodules become their own edges |
| `go-mod` | The go.mod `module` prefix names a package folder; edges to its non-test files |
| `rust` | `mod x;`, `crate::`/`self::`/`super::`, workspace crate names |
| `c-include` | Beside the includer, under include folders, else a unique path suffix; `<x>` only under include folders |
| `md-link` | Relative and root-absolute links and images; a folder link opens its README or index |
| `requirejs` | An AMD module id (`require("utils/StringUtils")`, `text!htmlContent/a.html`) against the RequireJS setup of the page that governs the importer: the page's `data-main` and local scripts give `require.config` `baseUrl` (relative to the page; else the data-main folder, else the page's) and `paths`. Added in resolver version 2: Brackets went from 33 resolved imports of 1,972 to 1,699 |
| `requirejs-local` | When the page's base finds nothing, a folder between the importer and that base: a nested loader context, such as Brackets loading each extension with its own folder as the base |

The extractor gained what the resolvers need (`EXTRACTOR_VERSION` 5):
re-export, type-only and dynamic flags; Rust `mod` declarations; system
includes keep their brackets. Markdown links have their own small redo
(`link_extractor_version`) because re-reading markdown under the code redo
would rebuild its chunks.

### Villages keep the graph they were founded on

More edges change fan-in and centrality, and so storeys, landmarks, downtown
and roads. ux.md's contract is that a building changes only when its role
changes, and a resolver upgrade is not the file's doing. So
`VillageDomainState.edgePolicy` records which graph a village follows. It is
absent (1, relative imports only, computed exactly as before) for every
village that existed before this change. A new village is founded on 2, the
stored graph limited to imports and includes between files on the map. A
policy-1 village whose roads would grow by at least a tenth gets a quiet
"Update the village" key. Only the person's own app can press it
(`isFirstPartyCaller`), and the choice is written to the committed village
file. Placements never move: the journal and anchors are untouched, while
downtown and landmarks follow the new graph, which is what the person asked
for. Document links never reach a village.

### Readers move to the table, with a fallback

File context (inbound importers, outbound resolution), taint tracing, the new
`GET /:id/index/graph` and `GET /:id/index/file-insight`, and the shared
`computeFileSignals` read `file_edges`. Before an index has been resolved once
(`edges_resolver_version` unset) they fall back to the old relative-only
resolution, and the graph route says so (`resolved: false`). Per-language
coverage (files, files with imports, files with edges, edges) is stored beside
the graph, so a view can say which languages it can draw arrows for.

## Alternatives considered

- **Fill `imports.dst_path`.** One column cannot hold a multi-file
  resolution, and its rows are rewritten per file, while the graph depends on
  the whole file set.
- **Resolve per request, better.** Keeps three readers paying for the same
  work and lets them drift; the diagram would also have to resolve thousands
  of rows per open.
- **Move every village to the new graph at once.** It would reshape every
  committed village on the next build: a dirty working tree no one asked for,
  and towns people navigate by memory rearranged under them.

## Regression surface

- `edges/resolve.test.ts`: every resolver on fixtures, code-unit ordering,
  coverage counts, no self or orphan edges.
- `edges/refresh.test.ts`: resolution at the end of a real pass, the
  unchanged-pass skip, rebuild when a new file completes an edge, cleanup on
  delete.
- `filemap/edge-policy.test.ts`: new villages on 2, existing ones on 1 with
  the offer and no file change, the upgrade writing `edgePolicy` and keeping
  placements, policy remembered without a village file.
- `filemap.test.ts` extraction cases: flags, Rust `mod`, bracketed system
  includes; all earlier Village tests unchanged.
- `file-graph.test.ts`: the graph route's shape, scopes, caps and focus, and
  the file insight's connections.
