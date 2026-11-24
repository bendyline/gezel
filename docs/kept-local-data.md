# Data kept on models on this computer

Some connections keep what they bring in on models that run on this computer
until the person allows cloud ones. Google's mail, calendar and files do:
Google's Workspace policy lets an app pass that data on only for a feature the
person is using, and only with their consent. The decision is
[ADR 0035](decisions/0035-kept-local-data.md).

## The rule

`connectionKeepsLocal(binding)` in core
[connector-cloud.ts](../packages/core/src/connector-cloud.ts) is the only
answer to "does this connection keep its data here?". It is true for a type
that asks (`calendar-google`, `files-google-drive`, `mail-gmail`) until
`binding.allowCloudModels` is set. The list is code, not catalog content, so a
manifest cannot decide that consent is unnecessary. Adding a type is one line
there.

`modelRunsOnThisComputer(provider, model, …)` in the same file is the only
answer to "is this model here?". A paired computer is not. Neither is Ollama
when the model is one of its hosted ones or its address is another machine.

The person sets the switch when connecting or on the connection's row ("Let
cloud AI read this"), never pre-ticked. Only the person's own app may set it
(`isFirstPartyCaller`); session tokens cannot reach the route, and an app grant
is refused. Each change is a history event (`project.connector.cloud.allowed`,
`.stopped`).

A cloud gezel still works in the project. It cannot list, read, search, query
or run a script against the kept data, and its prompt says why and what the
person can do.

## What is kept

[connectors/kept-local.ts](../packages/service/src/connectors/kept-local.ts)
`KeptLocalData.areas(projectId)`:

- each connection's own corpus folder;
- what a removed connection left behind, until a new connection takes the
  folder and answers for it;
- artifacts and task folders written by a conversation that read the data.

The last two are in `projects/{id}/kept-local.json`, through
`Store.readKeptLocal` / `updateKeptLocal`. Every entry names its connection, so
allowing cloud models for it releases everything it covers. The list folds
files into folders past 2,000 entries: wider, never narrower.

## Reads

A route that opens, lists or searches artifacts for a caller asks
[http/kept-local-gate.ts](../packages/service/src/http/kept-local-gate.ts):
`keptLocalFileRefusal` for one file, `keptLocalGate` for a listing. The person's
app passes. A session passes when its model is here, and is marked before the
answer leaves. Everyone else (a cloud session, an outside AI app, an app grant)
is refused, because Gezel cannot see where they would send it. Judge the file
the read will open, not the path a model wrote.

| Surface | Where |
|---|---|
| Artifact list, read, resolve, slice, grep, rename, thumbnails, copies, references | `routes/projects.ts`, `routes/reference-preview.ts` |
| Search, tables, documents as Markdown, images | `routes/tools.ts` |
| Image recognition, transcription, rendering, image and video inputs | `routes/recognition.ts`, `audio.ts`, `render.ts`, `caller-location.ts` |
| Report actions, task notes and outputs, connection drafts and account | `routes/report-actions.ts`, `project-tasks.ts`, `connectors.ts` |
| Memories | `routes/memory.ts` |
| Transcripts and audit events | `routes/sessions.ts`, `chats.ts`, `gezels.ts`, `history.ts` |
| Retrieval, images named in a message, the prompt | `chat/manager.ts` |
| Sandboxed scripts | `artifactReadRoots` grants what is beside the kept paths |
| Craftbook and project scripts | `scripts/kept-local.ts` |
| DocBlocks | read roots from `artifactReadRoots` |
| Claude Code's file tools | `Read(...)` deny rules for every project's kept paths |
| A CLI agent's shell, an unsandboxed Copilot | taken away in a project that keeps data |
| Outside AI apps reading images from disk | `mcp/src/harness/tools.ts` |

A new way to open artifacts for a caller joins this table and
`http/kept-local-routes.test.ts`.

## Conversations

A session that was shown kept data is marked (`ChatSession.keptLocal`). While
any of those connections still keeps its data here:

- It stays on the model here that read it, whatever its gezel moves to, and
  says so once. If it has no model here to stay on, the turn fails with
  `kept-local-data` and names the two ways forward.
- No one-shot quoting it runs elsewhere: memory extraction, summaries, a
  script's `llm.oneShot` (`ofSessionId`, `onBehalfOfSessionId`). The Inspector
  is never consulted about it, and a judge gate on its work is unavailable.
- Its messages reach only gezels here, whose conversations are marked too. Its
  replies to a cloud gezel become a sentence saying where the person can read
  the answer.
- Transcript search, history and timelines leave it out for a cloud gezel.
- A session opened from it, and every session on its task, inherits the mark.

## Memories

A memory from such a conversation carries `{kept:<binding>}` in its heading.
Cloud models never recall it, and the compactor, the lessons distiller and
growth never read it, because they may run on one. It stays kept after the
person allows cloud models, which applies from then on. A session here that
recalls one is marked.

## What this does not cover

Say so plainly wherever this is described to people.

- Files a gezel writes into the **workspace** or the shared library. Those are
  the person's folders, and CLI agents read them with their own tools.
- A script the person approves that runs with their rights
  (`run_playwright_script`, package scripts, `npx`), and third-party toolsets
  at `free`.
- What a person copies into a cloud chat, and apps holding the person's own
  credential.
- Conversations that read the data before it was kept, and anything a cloud
  model already received.
- Encryption of the copies. They are ordinary files, protected by the folder's
  permissions and the computer's disk encryption.
