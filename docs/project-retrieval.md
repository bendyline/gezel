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
hybrid rank fusion + weighted corpus merge -> dedupe
        |
        +-- relevance model (optional): re-judge the top of the fused order
        |
        v
path/source diversity
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

Proactive injection requires at least one substantive query term. Greetings,
pleasantries, acknowledgements, and other filler-only turns do not run indexed
retrieval at all. This gate is intentionally stricter than the explicit
`search` tool: a literal search for a common phrase should still execute when
the caller asks for it, but ambient retrieval must have a subject before it
spends prompt budget.

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
has been set. A craftbook step's retrieval query is the task's subject — the
book's main content param (`fromMessage`, else `topic`) plus the task
description — whenever the task has one. A book's step prose is identical on
every run, so as a query it matches the book's earlier runs rather than this
run's subject. Only a task without a subject falls back to the task title,
current phase, phase prompt, and declared inputs; generic handoff boilerplate
is never the query.

The follow-up hint under the injected rows names `search` and `read_document`
only when the turn wired them.

### Knowledge catalogs in per-turn injection

Installed catalogs, the bundled Handboek included, are held to a stricter
rule than project content, because an encyclopedia always has a plausible
neighbour and a title that shares a word with the request.

- **Vector floors.** A catalog's vector hit counts as evidence only above its
  cosine floor ([knowledge/vector-floors.ts](../packages/service/src/knowledge/vector-floors.ts)),
  keyed by catalog, then embedding profile. A hit under it neither ranks the
  document nor labels it `vector`. A profile nobody measured keeps its hits
  for ranking but labels them `fts`.
- **Unjudged hits need vector evidence.** Without a relevance-model judgment,
  a knowledge hit is injected only when it is `vector`. Keyword grounding,
  which serves project content, is not enough here ("Olive Oil Times" would
  ground "What is 17 times 23?"). Keyword-only catalog hits still reach the
  `search` tool.
- **Ceilings.** At most 2 chunks in Balanced (4 in Deep) within 25% (35%) of
  the turn budget, and `knowledge` is last in every diversification round.

Floors and the knowledge bar below are measured on real catalogs:
[KNOWLEDGE-CALIBRATION-2026-09-30.md](../evals/src/retrieval-bench/KNOWLEDGE-CALIBRATION-2026-09-30.md).

## Launch reference list

A craftbook started from the get-go — the composer's attached task or
`invoke_craftbook` — searches the reference corpora (installed knowledge
catalogs and the shared library) once for its subject, before the entry step
is dispatched ([tasks/references.ts](../packages/service/src/tasks/references.ts),
called from `TaskLauncher`). The subject is the book's main content param
(`fromMessage`, else `topic`); most books declare none, so it falls back to
the opening of the task description — the person's words, never the padding
a short request is given, cut at a sentence within 300 characters. Code books
(the `code-*` shelves) take no description fallback: their material is the
repository, and their descriptions find namesakes in the reference catalogs.
What it keeps is frozen on the task as `Task.references`, service-stamped at
create and inherited by fanout children:

- at most five entries, each a citation (`knowledge://` URI or library path),
  a title, and a snippet — never a document body;
- only entries whose title, path, or snippet names a subject term, so a
  vector-only neighbour cannot ride every step of the run; words from the
  book's own name are not subject terms. An entry a calibrated relevance
  model scored is kept or dropped on that score instead;
- skipped when the launch supplies its own source (`sourcePath`, `content`,
  or an input picker), for drafts, and for scheduled hosts;
- bounded to 1.5 s and never waiting on a cold embedder, so it cannot hold up
  the launch; a failed or empty search launches without a list.

Every step's task block renders it as **Reference material found at launch**
under the untrusted-evidence framing, naming `read_document` only when wired.
Per-turn retrieval skips any document already on the list. The launch's user
message carries the same list as its `retrieval` stamp, so the thread the
person started from shows what the task began with.

It is not written into the task's `about.md`: that file is the person's
request, rendered unlabeled in every step's prompt beside the authoritative
invocation parameters, where catalog text would read as instructions.

## Relevance model

Every relevance the search arms report is derived from rank: the top of any
arm that returned anything looks strong, so no floor can tell an answer from
noise, and a query with nothing relevant still injects its best-ranked rows.
The optional **relevance model** (Settings → Relevance check) is a small
cross-encoder: it reads the query and each passage together and scores the
pair on its own, which gives an absolute cut.

- **Where it runs.** `SearchService.searchProject` re-judges the top of the
  fused order ([search/relevance-stage.ts](../packages/service/src/search/relevance-stage.ts))
  for three surfaces: per-turn injection (`filter`, 250 ms), the launch
  reference list (`filter`, 700 ms added to its budget), and the model's
  `search` tool (`reorder`, 400 ms). Keyword hits are judged on their whole
  indexed chunk, read for the scored window only.
- **Never holds a turn.** A cold model answers `cold`, starts warming, and the
  results pass through untouched. Only a loaded model makes a turn over-fetch
  (3× its depth, at most 24) for the model to choose from. Off or cold behaves
  exactly as without it.
- **Judged candidates.** A candidate a *calibrated* model scored is kept or
  dropped on that score alone: the rank floor, keyword grounding, and the
  reference list's lexical rule do not apply to it. Everything else — past the
  window, or scored by an uncalibrated model — goes through those rules as
  before.
- **Calibration.** Scores map onto fixed relevance anchors (drop 0.1, keep
  0.3, strong 0.6) through the model's thresholds, which come from the
  retrieval bench, never from guesswork; between drop and strong the mapping
  runs in logit space, so a saturating sigmoid does not collapse onto keep.
  A model with no thresholds may reorder but never drop. On filter surfaces a
  knowledge passage must reach 0.5 (`KNOWLEDGE_FILTER_MIN_RELEVANCE`), not
  just keep. `search` drops only below *drop* and reports the
  rest as `hiddenBelowRelevanceFloor` ("No closely relevant results (N weak
  matches hidden)").
- **Models.** Pinned by sha256 at an exact revision in
  [relevance/registry.ts](../packages/service/src/relevance/registry.ts),
  stored under `~/.gezel/engines/relevance-models/<id>/`, downloaded when the
  check is on (first run turns it on for new installs; the boot step fetches
  a missing model) and only when the security policy allows app network, and loaded
  with `local_files_only`. Each model proves itself at load (a canned answer
  must outscore a canned non-answer); failing that, it is disabled. It runs in
  its own worker and never imports provider or chat code — a classifier cannot
  be talked into anything.
- **Eval levers.** `GEZEL_RELEVANCE_MODEL` (`off` | `on` | id),
  `GEZEL_RELEVANCE_SURFACES`, `GEZEL_RELEVANCE_THRESHOLDS`,
  `GEZEL_RELEVANCE_BUDGET_MS`, `GEZEL_RELEVANCE_ORDER`,
  `GEZEL_RELEVANCE_KNOWLEDGE_KEEP`, `GEZEL_KNOWLEDGE_VECTOR_FLOORS` (`off`, or
  `key=floor,…`), `GEZEL_RELEVANCE_MODELS_DIR`, and the kill switch
  `GEZEL_DISABLE_RELEVANCE_MODEL`. The retrieval preview takes a
  `relevanceModel` override per request.

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
  estimated token use, result scores (with the relevance model's score when
  it judged a hit), provenance, citations, and rejected counts per decision
  reason. With `GEZEL_RETRIEVAL_TRACE=1` or debug mode they also carry one
  row per candidate. Raw queries and retrieved text are not duplicated into
  telemetry.

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

Two harnesses, at two levels:

- **Retrieval quality** — `pnpm --filter @bendyline/gezel-evals run
  retrieval-bench`. No agent: a labeled corpus of fictional entity families
  with graded labels and deliberate decoys, every query run through
  `POST /api/projects/:id/retrieval/preview` — the surfaces' real decision
  code, with no side effects. Reports nDCG, MRR, strict recall, set
  precision, false-injection and distractor rates, tokens, and latency.
  `--relevance-model <id>` adds arms (off, uncalibrated, and each
  `--thresholds` triple) plus an offline threshold sweep. Labels and levers:
  [evals/src/retrieval-bench/](../evals/src/retrieval-bench/).
- **Outcome** — `pnpm --filter @bendyline/gezel-evals run ab-retrieval`. Paired
  A/B trials (control, annotated, references-only, turn-only) on scenarios
  whose deliverables are graded against known facts and decoys, with an arm
  proof that re-runs any trial whose arm did not actually take effect.

A mode or model should not be promoted merely because it retrieves more text:
the win is better task completion without unacceptable context pressure or
latency.
