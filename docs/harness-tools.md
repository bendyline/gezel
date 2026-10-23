# Gezel's tools in other AI apps

Claude Code, Codex, Cursor, Claude Desktop and VS Code can use a small set of
Gezel's tools through MCP, bound to the Gezel project for the folder they work
in. This is the contract; the decision and its alternatives are in
[ADR 0023](decisions/0023-harness-tools.md), and the person-facing article is
the Handboek's [Connected apps](handboek/conceptual/connected-apps.md).

## The pieces

| Piece | Where |
|---|---|
| Tool profile and descriptions | [core tools/harness-profile.ts](../packages/core/src/tools/harness-profile.ts) |
| Prompts (`triage_issues`, `fix_issues`) | [core tools/harness-prompts.ts](../packages/core/src/tools/harness-prompts.ts), registered in [mcp harness/issues.ts](../packages/mcp/src/harness/issues.ts) |
| Schemas (clients, config, connect, setup status) | [core schemas/harness-tools.ts](../packages/core/src/schemas/harness-tools.ts) |
| Harness entry (`gezel-mcp --harness`, `dist/harness.js`) | [mcp src/harness/](../packages/mcp/src/harness/) |
| Owner-credential exchange | [service http/routes/harness-connect.ts](../packages/service/src/http/routes/harness-connect.ts) |
| Folder → project binding | [service harness-tools/binding.ts](../packages/service/src/harness-tools/binding.ts) over `inferProjectForPath` |
| Route allowlist | [service http/harness-route-guard.ts](../packages/service/src/http/harness-route-guard.ts) |
| Setup in each app, launcher, choices | [service harness-tools/](../packages/service/src/harness-tools/), `/api/harness-tools` |
| Settings → Integrations | [ui components/harness-tools/](../packages/ui/src/components/harness-tools/) |
| CLI | `gezel mcp status`, `install <app>`, `remove <app>` ([cli mcp-command.ts](../packages/cli/src/mcp-command.ts)) |
| VS Code extension | [vscode mcp-provider.ts](../packages/vscode/src/mcp-provider.ts) |

## How a call travels

1. The app starts `<node> ~/.gezel/integrations/mcp/launch.mjs --harness <client> [--folder ${workspaceFolder} | --project <id>]`.
   The launcher imports the entry `current.json` names; the daemon rewrites
   that file at every start from its own `require.resolve`.
2. On the first tool call the harness picks a folder, in this order:
   `--project`, then `--folder`, then the client's MCP roots, then its working
   directory. Claude Desktop never infers one. A tool given an absolute path
   binds the root that contains it, so a multi-root VS Code window holds one
   token per project.
3. It reads `runtime/auth-token` and posts `{client, folder | projectId}` to
   `/v1/apps/harness-connect` (first-party only).
4. The daemon refuses when:
   - the tools are off
   - the security level forbids outside models
   - the app and project pair is stopped

   Otherwise it binds a project, mints `harness:<client>:<projectId|none>`
   (scope `harness`, ephemeral), and answers with the project, the library
   and artifacts folders, and the memory and image modes.
5. Every later request carries that token, through the `credential` hook of
   `connectToLocalGezel`. A 401 re-trades once. A daemon restart re-trades on
   the new launch. The owner token is never sent.

## What a harness token may reach

Deny by default, on `/api/*` and `/events/*`:

| Route | Binding |
|---|---|
| `POST /api/projects/<bound>/tools/search` | explicit `sources` from `harnessSearchSources`; never a `gezelId`; unbound apps search `default` for `shared`, `knowledge`, `user-memory` only |
| `POST /api/projects/<bound>/tools/read-doc-as-markdown`, `GET /api/projects/<bound>`, `GET …/index/status` | bound project only |
| `POST /api/recognition/describe` | `?project=<bound>`; an unbound app sends bytes, never an artifact path |
| `POST /api/image-gen/generate` | `projectId` equals the binding; no `gezelId`, `sessionId` or `saveAs`; images not `off` |
| `POST /api/memory/save` | scope `project`, the bound id, memory `save` |
| `GET /api/documents`, `/search`, `/read` | no `projects/` path, no `?project=` |
| `GET /api/knowledge/catalogs`, `…/:id/(document\|passage)` | — |
| `POST /api/projects/<bound>/tools/issue-handoff` | bound project only; issues not `off`; the issues handed over are leased to the app for two hours |
| `POST /api/projects/<bound>/tools/issue-verdicts` | bound project only; issues `triage`; no `by` in the body; at most 25 per call and 400 an hour per app and project |

**Sink rules for a harness caller:**
- **image-gen:**
  - `local` refuses cloud engines.
  - `any` asks no cost question.
  - No workspace copy is ever written.
- **memory save:** stamped `{app:<client>}`, and the request's own `source` is ignored.
- **photo locations:** withheld (`callerMaySeeLocation`).
- **search:** no craftbook hints.
- **issue verdicts:** recorded as `{kind:'app', client}` from the token. An app may not judge an issue a task is working on, and may never import a handoff document (`/issue-verdicts/import` is first-party only). See [issue-triage.md](issue-triage.md).

## What `search` returns

A coding app already holds the repo's own docs (`CLAUDE.md` and friends) and
reads files itself, so the harness reshapes the daemon's fused ranking
([harness/tools.ts](../packages/mcp/src/harness/tools.ts)
`arrangeSearchResults`):

- **Gezel's own Handboek never reaches an outside app.** `HARNESS_HIDDEN_CATALOGS`
  (core `harness-profile.ts`) is dropped from `search`, refused by
  `read_document` and left out of `gezel_status`, and the daemon enforces the
  same for harness tokens (search route, catalog list, and
  `harnessRouteGuard` on document and passage reads). It documents Gezel's UI
  and craftbooks and took four of ten slots on every code question in the
  squisq experiment.
- **Default scopes are the folder, the library and memories.** Other
  knowledge catalogs are opt-in (`scopes: ["knowledge"]`).
- **One line per file.** Chunks of the same file merge into one entry listing
  every matching range; the harness asks the daemon for three times the
  results it shows, so the list stays full.
- **Code first.** Source and test files come first. Docs and manifests
  (`.md`, `docs/`, `package.json`) follow under their own heading, at most
  three, unless they are the only matches.
- **Other corpora only when strong.** Unless the app named them, library and
  memory hits appear only at the daemon's `strong` tier, at most three, after
  the folder's results.
- **No untouched starter files.** The daemon drops Gezel's own starter files
  for harness tokens through `untouchedStarterFiles`
  ([search/project-retrieval.ts](../packages/service/src/search/project-retrieval.ts)),
  the same check proactive injection uses. The library's welcome document
  matched nearly every code question until the person edits it.
- **No photo matches beside code.** A photo, video or audio hit found by
  meaning (`media` set) is dropped when the folder has any other match; a
  match on a file's name stays.
- **Area summaries are named by their folder.** An index overview row
  (`overview:<project>:<area>`, no path) renders as "Overview of
  `<absolute folder>`", at most two per search.

Ranking itself is the daemon's `searchCodeHybrid`
([index-store.ts](../packages/service/src/index-store/index-store.ts)): an
enrichment summary corroborates the chunks of the file it describes instead
of standing alone at line 1, and scores stay below 1 so corroborated hits
keep their order (a tie at 1 sorted them by path).

## The person's choices

`config.harnessTools`, read through `resolveHarnessToolsConfig`; every field
is optional and lenient:

| Field | Values | Default |
|---|---|---|
| `enabled` | boolean | `true` |
| `memory` | `off` · `read` · `save` | `save` |
| `images` | `off` · `local` · `any` | `local` |
| `newFolders` | `add` · `existing` | `add` |
| `issues` | `off` · `read` · `triage` | `triage` |
| `blocked` | `[{ client, projectId }]` (`none` for unbound) | `[]` |

Changing any of them through `PUT /api/harness-tools/config` revokes every
harness token. Each app re-trades on its next call and so learns the change.
"Stop for this folder" adds a block and revokes that app's token for that
project.

## Setting the tools up in each app

| App | Written by | Entry |
|---|---|---|
| Claude Code | `claude mcp add --scope user gezel -- …` | read from `~/.claude.json` `mcpServers.gezel` |
| Codex | `codex mcp add gezel -- …` | read from `$CODEX_HOME/config.toml` `[mcp_servers.gezel]` |
| Cursor | JSONC splice | `~/.cursor/mcp.json` `mcpServers.gezel`, with `--folder ${workspaceFolder}` |
| Claude Desktop | JSONC splice | `claude_desktop_config.json` `mcpServers.gezel`, with `--project <id>` (Windows and macOS) |
| VS Code | JSONC splice, or the extension's MCP provider | the profile's `mcp.json` `servers.gezel` (`type: stdio`, `--folder ${workspaceFolder}`) |

**How an entry is judged** (`integrations/<client>/tools-setup.json` records
what Gezel wrote):

| State | Meaning |
|---|---|
| `configured` | Gezel's entry, current |
| `update-needed` | Gezel's entry, for an older launch command; file entries are repaired at start |
| `conflict` | an entry Gezel did not write, or one edited by hand; replacing it keeps a `.backup` |
| `unavailable` | the app or its command was not found; a copyable command is offered |

## Getting the app to use the tools

Setup gives an app the tools, but the app still reaches for its own Grep and
Glob first. One line in the folder's own agent file is what changed that:
Claude Code called Gezel's tools in 0 of 38 unprompted trials, and in 23 of 24
once the folder's CLAUDE.md told it to use `search`. On an undocumented
codebase (Brackets, 2021) that halved the time it took to answer questions
about the code and cut cost by about 28%; on a well-documented one (squisq)
it made no difference, because the app's own search already found the code.

Once an app is set up, its section in Settings → Integrations, and
`gezel mcp install`, show the line to copy (`harnessAgentFileLine` in core
`harness-profile.ts`) and the file it goes in (`HARNESS_AGENT_FILE`):
CLAUDE.md for Claude Code, AGENTS.md for Codex, Cursor and VS Code. Claude
Desktop has no folder and gets none. The Claude Code wording, naming
`mcp__gezel__search`, is the one tested; the others name the `gezel` server,
because each app spells MCP tool names its own way. Gezel shows the line; it
never writes it into the person's folder.

## Prompts: working through the night shift's issues

The server also offers two MCP prompts, `triage_issues` and `fix_issues`
([harness-prompts.ts](../packages/core/src/tools/harness-prompts.ts)). A person
runs one in their app (`/mcp__gezel__triage_issues` in Claude Code,
`/mcp.gezel.triage_issues` in VS Code; `harnessPromptInvocation` names the
command where it is known), and the prompt arrives with the next batch of BW
issues already in it. Nothing is written into the folder or the app's
settings, and the text updates with Gezel. Because the person runs it, it
needs no line in CLAUDE.md to get used. Settings → Integrations and
`gezel mcp install` show the command once an app is set up. The full contract
is in [issue-triage.md](issue-triage.md).

## Adding a tool to the profile

1. Its daemon route joins the `harnessRouteGuard` allowlist, bound to the
   token's project, with a test in `harness-route-guard.test.ts`.
2. Its handler joins [harness/tools.ts](../packages/mcp/src/harness/tools.ts):
   absolute paths in and out, nothing that names a tool outside the profile.
3. Its name and description join `HARNESS_TOOL_NAMES` and
   `HARNESS_TOOL_DESCRIPTIONS`; `harness.test.ts` pins the list.
4. If an app should reach for it unprompted, say when in
   `HARNESS_SERVER_INSTRUCTIONS`. Claude Code defers MCP tools: until the
   model loads one, it sees only the names, so a tool's description never
   reaches a model that is deciding whether to use it. The server
   instructions are the only text it reads up front, and they are not
   enough on their own. In the squisq experiment (2026-10-20) Claude Code
   called none of these tools in 38 unprompted trials, under general and
   then specific instructions it could quote word for word; one line from
   the person in the prompt got `search` used on two of six tasks. Its own
   Grep and Glob win whenever a repo's names or its CLAUDE.md point the way.
