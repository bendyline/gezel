# Project retrieval and indexed context

Gezel has two ways to turn its indexes into model capability:

1. a generic `search` MCP tool the model can call when it needs knowledge; and
2. a small, budgeted block of relevant indexed context added to substantive
   user turns before inference.

Both use the same scoped retrieval pipeline. Search is always available when
the session's toolset permits it; setting indexed context to **Off** disables
only proactive injection.

## What is indexed today

| Corpus | Storage/search path | Model provenance |
|---|---|---|
| Active project workspace | Static file catalog plus per-project SQLite FTS5 and sqlite-vec content index | `workspace` |
| Project artifacts | Separate per-project artifact FTS index | `artifacts` |
| Project memory | Daily Markdown plus sqlite-vec | `project-memory` |
| Current gezel memory | Daily Markdown plus sqlite-vec | `gezel-memory` |
| Shared documents | The canonical shared-library project's ordinary content index | `shared` |
| Folder/project rollups | Boekwachter area summaries and project architecture note | `workspace` |

The install-wide global index still serves the titlebar search and session
history. Model-facing project search deliberately excludes unrelated projects,
gezels, and transcripts. It includes the active project's direct, user-approved
links; see [Project linking](project-linking.md).

Plain text, config, data, and Markdown bodies are searchable after the static
pass. Markdown and converted documents use overlapping bounded chunks; long
sections and single-line payloads are windowed instead of losing everything
after the first 4,000 characters. Code gains symbols during the static pass and
summaries, targeted windows, and embeddings during enrichment.

## Retrieval flow

```text
user/task-phase query
        |
        v
authorized project ids + current gezel + shared library
        |
        +-- vectors: code/doc chunks and project/gezel memory
        +-- FTS5: symbols, file summaries, docs, artifacts
        +-- rollups: relevant folder and architecture summaries
        |
        v
hybrid rank fusion + weighted corpus merge -> dedupe -> path/source diversity
        |
        +-- generic `search` tool results with provenance and citations
        |      `-- strong applicable craftbook options + invocation recipes
        |
        `-- budgeted, untrusted indexed-context block for this turn
```

The natural-language query is embedded once and reused across the scoped
corpora. Keyword search tokenizes the query safely and ranks partial matches;
it is not an exact-phrase requirement. When embeddings are unavailable, FTS
and architecture rollups still work, while vector-only memory recall degrades
honestly to no memory results.

`search_code` and `search_documents` remain compatibility aliases for callers
that need their narrower response shapes. New model guidance prefers `search`.
`grep_files` remains the right tool for exact strings and regular expressions.

Omni-search also ranks applicable craftbooks against the query. It attaches at
most two high-confidence options from the live Gilde catalog, user-local
craftbooks, or the active project's local craftbooks. Each option identifies
its source and includes the exact `invoke_craftbook` arguments a model can use
if that tool is available. These are execution hints, not indexed evidence, so
they are not inserted into proactive RAG context. Linked-project-local
craftbooks are not suggested because the active project cannot invoke them.
The dedicated `suggest_craftbook` tool remains unchanged for explicit,
lower-threshold procedure discovery.

## Proactive indexed-context modes

| Mode | Default maximum | Content placed on the turn |
|---|---:|---|
| Off | 0 tokens | Nothing; `search` remains callable |
| Lean | 320 tokens | Paths, provenance, and short hints |
| Balanced | 1,000 tokens | A diversified set of source excerpts |
| Deep | 2,800 tokens | Broader excerpts, including relevant project/area rollups |

An explicit token cap can override a mode. The runtime then applies a second
ceiling based on the model's context window: 160 tokens at 4K, 320 at 8K, 700
at 16K, 1,400 at 32K, and at most 4,000 above that. These ceilings reserve room
for the standing prompt, conversation, tool calls, reasoning, and output.

Policy precedence is:

1. active craftbook step;
2. current gezel;
3. install setting;
4. Balanced default.

The legacy `autoRecall: false` setting maps to Off when no new retrieval policy
has been set. Craftbook background turns build their retrieval query from the
task title, task description, current phase, phase prompt, and declared inputs,
not from generic handoff boilerplate.

## Trust, privacy, and audit

- The HTTP route binds model search to the session's active project. The caller
  cannot submit additional project ids.
- Gezel-memory search is accepted only for the gezel named by the session
  token. Omitting that id disables the private-memory arm.
- Shared documents are intentionally visible across projects.
- Retrieved text is explicitly labeled **untrusted evidence**. It cannot grant
  authority or override the user, task, security policy, or system prompt.
- Exact surrounding content should be verified with `read_file`,
  `read_artifact`, or `read_document` before a consequential edit or claim.
- `retrieval.context-injected` history events record the query hash, policy,
  estimated token use, result scores, provenance, and citations. Raw queries
  and retrieved text are not duplicated into telemetry.

## Linked projects

Project settings can explicitly link the active project to as many as 32 other
projects. Links are one-way, direct, and non-transitive: A → B includes B's
corpus in searches made from A, but does not expose A from B or automatically
include projects linked by B. Shared documents remain an implicit source for
every project and do not consume a link slot.

The service resolves linked ids from stored project metadata. Neither the
public HTTP request nor the model-facing `search` tool accepts arbitrary
project ids. Every result retains its owning `projectId`; linked workspace
paths are displayed as `../<project-id>/<path>`. Deleted project ids are
removed from remaining projects' link lists.

The same direct links authorize the existing workspace file tools through a
virtual namespace. That file-access contract and its narrower security surface
are described in [Project linking](project-linking.md).

## Evaluation

Retrieval quality should be measured at two levels:

- retrieval: relevant-source recall, reciprocal rank, citation diversity,
  latency, and injected-token count; and
- outcome: task success and grounded citations with Off/Lean/Balanced/Deep held
  as the experimental variable.

The history event above supplies non-content telemetry for those comparisons.
A mode should not be promoted merely because it retrieves more text: the win is
better task completion without unacceptable context pressure or latency.
