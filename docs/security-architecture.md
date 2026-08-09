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
5. **OS sandbox or refusal** — `denyNet` script execution runs under macOS Seatbelt or fails
   closed; Windows/Linux do not substitute a JavaScript shim for an OS boundary.

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
  CORS is **deliberately not served on `/v1/apps/*`** (the unauthenticated app-grant surface)
  so a drive-by page can't script the register→token-poll flow cross-origin.

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
| **desktop client** | `['ui','openai']` | no; written to `runtime/auth-token` | first-party product API + local OpenAI facade |
| **web-ui** | `['ui']` | no (ephemeral) | first-party product API; never daemon root |
| **inference app** (`/v1/apps/register`) | `['openai']` | yes (`tokens.json`, 0600) | only `/v1/*` inference, gated by `requireScope('openai')` |
| **product app** (`/v1/apps/register`) | `['product']` (+ `openai` when needed) | yes (`tokens.json`, 0600) | ordinary `/api/*` product access; never first-party app-grant administration |
| **CLI** (`/v1/apps/register`) | `['cli']` | yes (`tokens.json`, 0600) | ordinary `/api/*` product access with CLI-specific consent copy |
| **session** (a gezel's MCP subprocess) | `['session']` + `projectId`/`gezelId`/`team` | **no** (ephemeral, dies with daemon) | deny-by-default MCP route allowlist + ownership guards |

`TokenRecord` carries optional `projectId`, `gezelId`, and `team` (set only on session
tokens). `issueSession()` mints an ephemeral, never-persisted, upsert-on-respawn token;
`revokeSession()` drops it. The root token comparison is a `Map` lookup of a high-entropy secret.

Stateful app scopes (`product`, `cli`, and future non-inference scopes) require a
daemon-generated six-character requester code in addition to the detailed consent prompt.
The requester receives and displays the plaintext once; the daemon persists only a salted
hash, and the Gezel approval surface never displays the code. Inference-only scopes may opt
into the same handshake.

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
routes, foreign project-document fallbacks, and body/query scope spoofing. Three ownership/
role middlewares provide additional defense-in-depth:

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

---

## 5. The security-policy / capability model

`packages/core/src/security/policy.ts` — the single source of truth.

One config object (`config.securityPolicy`) drives everything. The `level` is a **UI label
only**; enforcement reads the **five capability booleans** via `resolveSecurityPolicy()`. The
axis that matters is **agency** — these gate what *the model* may do autonomously; user-
initiated actions (a human pulling a repo, the app's own npm/CLI processes) are exempt.

| Capability | `super-lockdown` | `lockdown` | `free` |
|---|---|---|---|
| `allowFileEdits` (model Git/GitHub + script `documents.write`) | ✗ | ✓ | ✓ |
| `allowExternalChat` (cloud LLM providers) | ✗ | ✓ | ✓ |
| `allowExternalServices` (web search, `fetch_url`, …) | ✗ | ✗ | ✓ |
| `allowScriptExecution` (gate-scripts, code-exec) | ✗ | ✓ | ✓ |
| `allowAppNetwork` (background app egress) | ✗ | ✓ | ✓ |
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
tools. Workspace writes have a separate per-project consent gate:

| `project.allowGezelWrites` | Internal workspace | External `workingDir` |
|---|---|---|
| `true` | writable | writable |
| `false` | read-only | read-only |
| absent | writable | read-only |

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
   - `web_search` / `wikipedia_search` → `providers/search/factory.ts` (no provider when
     `!allowExternalServices`).
   - `fetch_url` → `http/routes/tools.ts` checks `allowExternalServices` **and** SSRF (§11).
   - external chat → `chat/manager.ts` (`!allowExternalChat` → refused).
   - script execution → `scripts/runner.ts` (gates the run; strips `network`/`credential:*`
     caps when `!allowExternalServices`, applies the per-project workspace gate to
     `workspace.write`, and strips `documents.write` when `!allowFileEdits`).
   - workspace writes → `fs/store.ts` `assertWorkspaceWritable` (the per-project
     `allowGezelWrites` tri-state above; independent of `allowFileEdits`).

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
`packages/sdk`. Backs gate-scripts (`defineScript`) and the model's `run_nodejs_script` /
`run_playwright_script` tools.

**Execution model — a real OS process, not `node:vm`.** `vm` is *not* a security boundary
(constructor escapes); Gezel correctly avoids it. Each run is `child_process.spawn` of a Node
binary wrapped in:

1. **`node --permission`** with `--allow-fs-read` / `--allow-fs-write` scoped to the script's
   scratch + workspace dirs. `--allow-child-process`, `--allow-worker`, `--allow-addons` are
   all **OFF** (so no `child_process` escape, no fork bombs, no native addons).
2. **macOS Seatbelt** (`sandbox-exec`) with a `deny default` profile (defense-in-depth).
3. **Network egress block** (`denyNet`, **fail closed**): macOS Seatbelt `(deny network*)` is
   the current enforceable boundary. The JS `--import` preload also blocks fetch/WebSocket,
   net/dgram, callback + promise DNS, named built-in exports, and Resolver instances, but is
   defense-in-depth rather than a malicious-code boundary. Windows/Linux refuse `denyNet`
   execution with exit 126 until an OS sandbox exists; macOS also refuses when Seatbelt is
   unavailable and never retries a failed denyNet launch unsandboxed. fd-3 RPC remains usable
   because it wraps an inherited descriptor and never calls `.connect()`.
4. **Resource cap** — `--max-old-space-size` bounds heap so a runaway allocation can't OOM the
   host; wall-clock timeout + SIGKILL.
5. **Env scrub** — `sandboxEnv` allowlists only `PATH`/`HOME`/`NODE_*`/locale; strips
   `GEZEL_TOKEN`, `OPENAI_API_KEY`, etc. → a script **cannot read host secrets from
   `process.env`**.

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
- **lockdown** — adds cloud chat, script execution, model Git/GitHub tools, and auto-update,
  but keeps open-web services, mail, and unconfined third-party toolsets off. Note
  `run_package_script` can reach the network (consent-gated, content-hashed — see below).
- **free** — adds `fetch_url`/`web_search` (SSRF-guarded) and non-builtin MCP toolsets
  (unconfined third-party code — the riskiest surface, `free` only).

**Self-escalation is contained:** no MCP tool writes `securityPolicy` or grants, and the
daemon token never reaches scripts (env scrub), so a script can't flip the policy via the
config route.

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
- **Navigation is locked down** — `will-navigate` pins the renderer to the daemon origin;
  `setWindowOpenHandler` + `shell.openExternal` only accept an `https/http/mailto/tel`
  allowlist (no `file://`, custom schemes, `javascript:`).
- **Cert pinning** — `session.setCertificateVerifyProc` accepts the custom loopback cert
  **only** for loopback hosts matching the current pin; all other origins defer to Chromium.
  Rotates with each daemon restart. It does **not** blanket-accept certs.
- **Token to renderer** — surfaced via a synchronous `ipcMain` bridge + `window.__GEZEL__`.
  Any renderer XSS = token theft, which is exactly why the CSP/SVG/sandbox controls above
  matter. The preload is minimal (per-channel `contextBridge`, no raw `ipcRenderer`/`fs`/
  `shell`).
- **Bundle integrity** — the extracted service bundle's tarball is **sha256-verified against
  the shipped meta before extraction/execution** (`supervisor/extract-bundle.ts`). (This is
  integrity/corruption protection; the tarball + meta ship together inside the signed app.)

---

## 10. Path-safety primitives

`packages/service/src/fs/safe-paths.ts` — every user/model-supplied path funnels through these:

- `safeJoin(base, rel)` — lexical containment with a **trailing-separator terminator** (so
  `/home/foo` doesn't match `/home/foobar`) and platform-correct case folding. Blocks `..`,
  absolute paths, drive swaps.
- `realpathContained(base, full)` — resolves symlinks (realpath of nearest existing ancestor)
  and verifies the result stays inside `base`.
- `resolveInside(base, rel)` — the end-to-end helper: `safeJoin` + reserved-Windows-name
  reject + `realpathContained`. Throws `PathSafetyError`.

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

---

## 12. Process execution & supply chain

- **Spawns use argv arrays, not shell strings.** The "reveal in file manager" launcher uses
  `execFile('open'|'xdg-open'|'explorer', [dir])` (a project `workingDir` is model-settable and
  flows here). On Windows, `runPnpm` quotes args for cmd.exe when `shell:true` is unavoidable
  (the `.cmd` shim). `run_git` is restricted to read-only subcommands and rejects `-c`/`--exec`.
- **`install_package`** is consent-gated and forces `--ignore-scripts` (npm lifecycle-script
  vector closed).
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
| Broker LAN-serving administration via `machine-models` | PRODUCT CHOICE | The broker's `/v1/remote/manage/serving` surface (enable LAN serving, approve/deny device pairings, revoke devices) is authorized by the same shared runtime credential — until installer membership exists, any local account can administer LAN serving for the machine. The scope stays never-grantable via `/v1/apps/register`, so LAN peers can never obtain it. |
| Remote product UI/API access | INTERIM — tunnel recipe | The product `/api` + web UI stay loopback-only by three independent layers (bind, host guard, cert/auth). The supported interim is a loopback-preserving tunnel (SSH `-L` / Tailscale toward loopback) with the schema-declared `service:{url,token}` supervisor mode; first-class remote access is designed in `docs/remote-access.md` and gated on the accounts ADR (0004). |
| External user working directories from a machine daemon | NEEDS BROKER/GRANT | Dedicated service identities cannot safely inherit arbitrary user-profile access. Add an explicit ACL grant or user-context broker when linking such a folder; do not restore a privileged daemon identity. |
| `denyNet` execution on Windows/Linux | FAIL CLOSED | Model/gate scripts return exit 126 because no supported OS network boundary exists yet. Restore execution only with a real OS sandbox, not a JavaScript-only shim. |
| SSRF connect-time IP pin | DEFERRED | Current guard validates at DNS-resolution time (rebinding-window residual). |
| Default security level = `free` | BY DESIGN | Confirm against product risk appetite. |

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
- `packages/service/src/scripts/runner.ts`, `dispatcher.ts` — capability gating, credential resolution.

**fs / secrets / ssrf**
- `packages/service/src/fs/safe-paths.ts`, `fs/store.ts`, `fs/atomic.ts`.
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
