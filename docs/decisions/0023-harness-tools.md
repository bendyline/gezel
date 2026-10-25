# 0023 — Gezel's tools in other AI apps

Status: Accepted (2026-10). Builds on [0015](0015-project-inference.md) and
[0018](0018-local-add-in-grants.md).

## Context

`@bendyline/gezel-mcp` could already be started from any MCP client's
configuration, and since 2026-10 it found the running service by itself. As
a product that path was wrong in three ways:

- **It ignored the folder.** It bound to whatever project `GEZEL_PROJECT_ID`
  named, `default` unless set.
- **It ran with the owner's whole credential.** It read the owner credential
  from `runtime/auth-token`, so it had every product route, no project
  boundary, and no row in Integrations. Several data sinks treated any caller
  that was not a gezel session as the owner. That leaked photo locations and
  skipped the cloud image-cost question.
- **It exposed the whole gezel surface.** That meant about 180 tools: file
  edits, a shell, task-step machinery and admin. Their descriptions were
  written for Gezel's own prompts.

Claude Code, Codex, Cursor, Claude Desktop and VS Code already read, write,
search and run files themselves. What they lack is what only Gezel has:
- the index over the folder and its Office documents
- the shared library and the person's memories
- installed knowledge catalogs
- on-device image reading
- the image engine the person chose

## Decision

**A separate, small entry point.** `gezel-mcp --harness <client>` runs
`dist/harness.js`, which never imports the in-app server. It registers the
tools in `HARNESS_TOOL_NAMES` in core (nine at first; [0027](0027-issue-triage.md) added two for issues), plus six DocBlocks document tools passed through to the DocBlocks Gezel ships (`HARNESS_DOCUMENT_TOOL_NAMES`, [harness-tools.md](../harness-tools.md#making-documents)), with descriptions written for an app
that has its own file tools. Every path it returns is absolute. The bare
command keeps its old, owner-credential behavior for compatibility.

**A project-bound, ephemeral principal.** The harness reads `runtime/auth-token`
once and trades it at `POST /v1/apps/harness-connect` for a token scoped
`harness`, as ADR 0018 lets Gezel's own add-ins do. The token is bound to one
project, or to none, and every request carries it; the owner credential never
rides a request. The token is never written to `tokens.json`, so an older
daemon never meets a scope it does not know.

**Folders bind the way folder inference does, with three server-side
options.** The daemon:
- reuses the deepest project that already contains the folder
- otherwise creates a read-only project for exactly that folder, with no lead
  gezel, no adopting of a same-named project, and no climbing to a parent
- binds no project for a folder Gezel never owns, or for Claude Desktop with
  no project picked

Under "Only folders already in Gezel" it never creates one.

**Deny by default, enforced where the data is.** `harnessRouteGuard` admits a
short list of routes, project-bound in path, query or body, on `/api/*` and
`/events/*`. The data sinks then apply the person's choices:
- **Images.** Generation runs on-device only unless "Any image engine" is
  allowed, and never writes into the folder.
- **Memory.** Saves go to the project, stamped `{app:<client>}`.
- **Photo locations.** A harness never sees them.
- **Search.** Results carry no craftbook hints that name tools the app does
  not have.

The guard also checks the master switch and the block list on every request.

**Stopping is a block, not a revoke.** Revoking alone would be undone by the
next exchange, since the harness still holds the owner credential. "Stop for
this folder" adds the app and project pair to `harnessTools.blocked` in
config, and the exchange answers `harness_disconnected` until the person
undoes it. A change to any choice revokes every harness token, so each app
re-trades and learns the new choice.

**Each app keeps one `gezel` entry, written the way that app expects.**
- Claude Code and Codex are configured through their own `mcp add` and
  `mcp remove` commands; Gezel only reads `~/.claude.json` and `config.toml`.
- Cursor, Claude Desktop and VS Code's `mcp.json` get a one-entry JSONC
  splice that leaves comments and other entries byte for byte.
- `integrations/<client>/tools-setup.json` records what Gezel wrote. Gezel
  never removes or replaces an entry it did not write unless asked, and then
  keeps a `.backup`.
- Every entry runs `<absolute node> ~/.gezel/integrations/mcp/launch.mjs`,
  whose `current.json` the daemon rewrites at each start from its own
  `require.resolve`.

## Consequences

- **The token narrows the app's model, not the app.** Any process of this
  user can read `runtime/auth-token`, the harness's own shell included. The
  token keeps a prompt-injected model inside Gezel's few tools and the
  person's choices; it is not a sandbox around Claude Code or Codex.
- **Super-lockdown turns the feature off.** Gezel cannot tell whether an
  outside app's model is local, so `harness-connect` refuses under
  `allowExternalChat: false`.
- **Project memory now has a third author besides people and gezels.** The
  `{app:…}` stamp keeps that legible. Saving to the person's own "About you"
  memory is deliberately not offered yet.
- **Codex's default tool timeout (60 s) can cut off a slow local image.**
  Raising it means editing `config.toml`, which Gezel leaves to Codex.
- **A VS Code user with the Gezel extension and a Settings-written `mcp.json`
  entry sees Gezel twice.** The VS Code section says to use one.
- **Two fixes came out of the review:** gezels' own `describe_image` and
  `read_image_metadata` were refused by the session guard, and are now
  admitted with the project bound.

See [docs/harness-tools.md](../harness-tools.md) for the contract.
