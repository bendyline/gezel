# Signing in to hosted MCP servers

**Status:** proposal, not built (2026-11-08). Nothing here is an available API.

A hosted toolset (`http-mcp`) that requires OAuth installs today without
complaint and then never connects. This document records what happens now,
what each provider's own runtime already offers, and a recommended design.

## What happens today

- The catalog schema has `authHint: 'none' | 'bearer' | 'oauth'`
  ([catalog.ts](../packages/core/src/schemas/catalog.ts)), but the importer
  only ever writes `none` or `bearer`
  ([mapper.ts](../packages/catalog/scripts/importer/mapper.ts)), and nothing at
  runtime reads the field. The MCP registry does not declare OAuth, so the
  importer cannot know.
- Install records the URL and finishes
  ([routes/catalog.ts](../packages/service/src/http/routes/catalog.ts)).
- The managed bridge builds its HTTP and SSE transports with headers only, no
  `authProvider`. An OAuth server answers 401, and the bridge logs
  `connect FAILED … this bridge will register no tools`
  ([mcp-bridge.ts](../packages/service/src/providers/mcp-bridge.ts)). The
  person sees nothing.
- Copilot, Claude CLI and Codex receive the server's URL and headers and meet
  the same 401 inside their own runtimes.

How many of the ~7,200 hosted community entries need OAuth is unknown.
Measuring it means sending an unauthenticated `initialize` to each third-party
server, which is a decision to make deliberately, not a side effect of a
build.

## What each runtime already has

| Runtime | OAuth support | Why it is not enough alone |
|---|---|---|
| Managed bridge (on-device, OpenAI, Anthropic API) | The MCP SDK (1.32) takes an `OAuthClientProvider` on both HTTP transports and refreshes tokens itself. Not wired. | Needs a provider implementation, storage and a browser step from Gezel. |
| Copilot SDK 1.0.26 | `session.mcp.list` reports `needsAuthServers`; `session.mcp.oauth.*` runs a login. | Interactive, per session, tokens kept by the Copilot runtime. |
| Claude CLI | Reports `needs-auth` for such servers. | Gezel runs it in `--print` mode, where a login cannot complete. |
| Codex CLI | `codex mcp login` with a callback port. `CodexRuntimeConfig` can write `mcp_oauth_callback_port`/`_url` ([runtime-files.ts](../packages/service/src/providers/codex-cli/runtime-files.ts)), but nothing sets them. | Gezel gives each session its own `CODEX_HOME`, so where tokens persist is not settled. |

Leaving it to each runtime would give one person up to four sign-ins per
server, held in four places, and nothing at all for on-device models.

## Recommendation: Gezel owns the sign-in, providers get a token

1. **Detect.** When the person installs a hosted toolset, send one
   unauthenticated `initialize`. A 401 carrying `WWW-Authenticate` with
   `resource_metadata` (RFC 9728) marks it as needing sign-in. The bridge does
   the same on connect, catching the SDK's `UnauthorizedError` and recording a
   "needs sign-in" state rather than a generic failure. Never probe from the
   importer.
2. **Sign in.** An `OAuthClientProvider` in the daemon: authorization-server
   discovery, dynamic client registration (RFC 7591) where offered, PKCE. The
   redirect goes to a short-lived plain-HTTP loopback listener on an
   ephemeral port (RFC 8252 section 7.3), not the daemon's TLS listener, whose
   self-signed certificate a browser would refuse. The daemon asks the app to
   open the browser (Electron `shell.openExternal`). It never opens one
   itself: as a system service it runs under another account.
3. **Store.** Tokens and client registration in `SecretStore` under the
   toolset (`kind: 'toolset'` with a reserved field id). Never in `runtime/`,
   the toolset config, or a provider's own store.
4. **Deliver.**
   - Bridge providers get the `authProvider`, which refreshes as it goes.
   - Copilot, Claude CLI and Codex get `Authorization: Bearer <access token>`
     as an ordinary header, resolved at session build like any toolset
     secret. Their protections already apply: Codex passes header values
     through environment variables, and Claude's config file is 0600.
     Refresh before each session build, and rebuild a session whose token is
     close to expiry, because these runtimes cannot refresh a token they were
     handed.
5. **Show it.** The toolset row says "Sign in to …" with a key that starts the
   flow, and the same state explains why a gezel lacks the server's tools.
   Follow [ux.md](ux.md) for the key and the wording.

## Decisions needed before building

- **Whose sign-in.** Per install (today's secret scope) or per account, now
  that container accounts exist ([accounts.md](accounts.md)).
- **Daemons the browser cannot reach.** A remote or container daemon cannot
  receive a loopback redirect. A fallback where the person pastes the final
  redirect URL (the shape of `codex mcp login --no-browser`) covers it, at
  some cost in clarity.
- **The `gezel` CLI.** Whether headless installs get a sign-in command, or
  only the desktop app does.
- **Measuring demand.** Whether to probe the catalog's hosted entries once,
  with consent, to learn how many need OAuth before committing to the work.

## Cheaper step that stands alone

Steps 1 and 5 without the sign-in itself: detect the 401, and tell the person
the server needs a sign-in Gezel cannot do yet, instead of failing silently.
This is small and stays useful after the full flow lands.
