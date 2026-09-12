# @bendyline/gezel-app-sdk

Public SDK for building third-party local apps against [gezel](https://github.com/bendyline/gezel). Gives you discovery, user consent, and an OpenAI-compatible chat / embeddings / models / ensure-model client in under 50 lines.

## Why

If you ship a desktop app and want to use the user's locally-installed models without re-implementing model management, runtime detection, and TLS pinning — point this SDK at gezel and you're done. Apps that already target OpenAI's chat API can use gezel as a drop-in via the OpenAI-shaped envelopes.

If your users may not have gezel at all, the [`/host`](#hosting-gezel-inside-your-app) entry runs one inside your own application, against a gezel home that belongs to your app. Same API either way.

## Install

```bash
npm install @bendyline/gezel-app-sdk
```

Node 24+. The Node entry uses `undici` to trust gezel's loopback TLS cert.

## Quickstart

```ts
import { detectGezel, connect } from '@bendyline/gezel-app-sdk';

// Demo only: replace this with Keychain, Credential Manager, libsecret, etc.
const tokens = new Map<string, string>();
const tokenStorage = {
  save(appId: string, token: string) { tokens.set(appId, token); },
  load(appId: string) { return tokens.get(appId) ?? null; },
  delete(appId: string) { tokens.delete(appId); },
};

const status = await detectGezel();
if (!status.installed) throw new Error('gezel not installed');
if (!status.running) throw new Error('start the gezel app first');

const app = await connect({
  appId: 'docblocks',
  appName: 'DocBlocks',
  scopes: ['openai'],
  tokenStorage,
});

// Make sure the model is downloaded and warm.
const ensure = await app.ensureModel({
  model: 'llama-cpp:qwen3-4b-instruct-q4_k_m',
});
if (ensure.status === 'downloading') {
  for await (const ev of app.streamEnsureEvents(ensure.job_id!)) {
    if (ev.type === 'progress') {
      console.log(`${ev.bytesWritten}/${ev.totalBytes} bytes`);
    }
  }
}

// Stream a chat completion.
const stream = await app.chat({
  model: 'llama-cpp:qwen3-4b-instruct-q4_k_m',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

## Consent flow

The first time your app calls `connect()` for a given `appId`, gezel shows a desktop consent dialog to the user. You'll see one of:

- **Approved** — your app stores the issued token via `tokenStorage.save`. Subsequent runs (via `tokenStorage.load`) skip the dialog entirely.
- **Denied** — `connect()` throws a `GezelSdkError` with `code: 'user_denied'`. Surface a clear "User declined the gezel connection" to your user.
- **Timeout** — defaults to 120s. Override with `approvalTimeoutSec`. Throws `code: 'approval_timeout'`.

Grants that can read or change Gezel product state require an additional
requester-visible code. Supply `onVerificationCode` and show the value in your
application; the user types it into Gezel's approval dialog:

```ts
await connect({
  appId: 'acme.gezel-tools',
  appName: 'Acme Gezel Tools',
  scopes: ['cli'],
  onVerificationCode(code) {
    console.error(`Enter ${code} in Gezel to approve this connection.`);
  },
});
```

The daemon generates the six-character code, expires it with the grant after
ten minutes, and never sends it to the desktop approval surface. Inference-only
scopes (`openai` and `remote-inference`) retain click approval without a code.
Inference-only clients can opt into the same stronger handshake by setting
`requireVerificationCode: true` and providing `onVerificationCode`.

## Product clients

`authorizeLocal()` is the complete Node-native connection path when your
integration needs Gezel's product API rather than only the OpenAI-compatible
facade. It discovers the logged-in user's dynamic daemon port, pins that
daemon's per-launch TLS certificate, verifies any persisted token still has
the requested scopes, and otherwise performs registration, code delivery,
approval polling, and token persistence:

```ts
import { authorizeLocal } from '@bendyline/gezel-app-sdk';
import { GezelClient } from '@bendyline/gezel-client/node';

const authorized = await authorizeLocal({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['product', 'openai'],
  onVerificationCode(code) {
    showConnectionCode(code);
  },
  tokenStorage: keychainStorage,
});

const client = new GezelClient(authorized);
```

The normal path connects directly to the per-user daemon described by
`~/.gezel/runtime`; it never connects to or bootstraps through a
`machine-engine` broker on port 6228. The returned object contains only the
app's scoped token plus non-sensitive daemon diagnostics. It never exposes the
daemon's first-party discovery credential.

During a rolling upgrade, the SDK first probes the installed system service.
If that service declares `legacy-full` (or predates role publication), the SDK
uses it as the temporary product endpoint so VS Code and Electron cannot show
different pre-migration projects. A `machine-engine` service is never treated
as a product endpoint; the ladder continues to the per-user daemon.

`authorize()` remains the transport-level primitive for callers that already
resolved a base URL or do not need daemon diagnostics.

### Optional native launcher

Ordinary third-party apps should omit `daemon`: when Gezel is not running the
SDK throws `daemon_not_running`, and the app should ask the user to start
Gezel. A native integration that deliberately bundles the matching `gezeld`
package can opt into safe start-if-missing behavior:

```ts
const authorized = await authorizeLocal({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['product', 'openai'],
  onVerificationCode: showConnectionCode,
  tokenStorage: keychainStorage,
  daemon: {
    daemonEntry: bundledGezeldEntry,
    spawnIfMissing: true,
  },
});
```

SDK-owned launches are always detached per-user daemons with
`GEZEL_SERVICE_ROLE=user` and `GEZEL_PORT=0`. They therefore publish their
actual dynamic address through the user's runtime directory and cannot race
the machine broker for port 6228. VS Code is the reference implementation of
this optional launcher path.

Gezel's own same-user desktop and CLI clients use `authorizeLocalOwner()`.
That narrowly named first-party surface adopts or starts the same user daemon
but returns its rotating runtime `ui` credential without opening a Connected
Apps consent request, so a headless CLI never waits for a desktop approval UI.
Third-party integrations must use `authorizeLocal()`; do not use the owner
surface as an app-consent bypass.

Use `product` for ordinary stateful product access and add `openai` only when
the same app also calls the OpenAI-compatible inference routes. `product` does
not grant first-party administration of other app connections.

For CI / scripted environments, the gezel daemon honors `GEZEL_AUTOAPPROVE_APPS=appId1,appId2` and auto-approves listed apps at registration time.

## Hosting gezel inside your app

`connect()` needs a gezel the user already runs. When your app should work whether or not they have one, use the host entry: it connects to their gezel if it is there, and otherwise starts one in your own process.

```ts
import { connectOrHost } from '@bendyline/gezel-app-sdk/host';

const gezel = await connectOrHost({
  appId: 'acme.travel',
  appName: 'Acme Travel',
  // Hosting is opt-in. Without `host`, a missing gezel is still an error.
  host: { nodePath: process.execPath },
});

// Engine binary, weights, and the default-model pin, in one call.
await gezel.ensureModel({ model: 'gemma4-e2b-q4' });

// Project folder, crew, scripts and seeds from a .gezapp you ship.
const project = await gezel.ensureProject({
  package: '/opt/acme/travel.gezapp',
  folder: '/Users/me/Travel',
});

const chat = await project.openChat({ role: 'travel-guide' });
for await (const event of chat.send('Where should I eat in Utrecht?')) {
  if (event.type === 'delta') process.stdout.write(event.content);
}

await gezel.close();
```

`Gezel` is the central object: the connection, the models, and the projects. Most work then happens in a `GezelProject`, because chats and app tools are both project-scoped — having the project means never passing its id back in. Everything after `connectOrHost` is identical whether the daemon is the user's or yours, so application code never branches on it; read `gezel.mode` if you want to tell.

`ensureProject` returns the project it created. Pass no `package` and it simply binds the folder to a project, which is all an app that ships no `.gezapp` needs. For a project that already exists — one an earlier run made, or one the person made themselves — use `gezel.openProject(id)`.

### What hosting does

- **Its own home.** State goes under `~/.gezel/apps/<appId>/`, never the user's `~/.gezel` runtime. Your app's projects and gezels stay out of their workshop, and your daemon can never be restarted out from under you by the gezel desktop app.
- **Their models, read-only.** Models the user already installed are found through a read-only overlay, so a 2 GB download does not happen twice. Nothing of yours is ever written there.
- **No Chromium.** The system bootstrap (Playwright plus a ~280 MB browser) is off unless you pass `host: { systemBootstrap: true }`.
- **One per process.** The daemon reads its settings from the environment, so a second hosted daemon in the same process is refused. A second *instance of your app* adopts the daemon the first one started.

Install `@bendyline/gezel-service` alongside this SDK to host — it is an optional peer dependency, so apps that only connect never download it.

**Under Electron**, `process.execPath` is your app binary, not Node, and gezel runs its tool server as a child process. Ship a Node binary and pass `host: { nodePath }`; the SDK fails immediately with `node_binary_required` rather than coming up with no tools.

### Shipping a model with your app

`ensureModel` resolves in three steps: already installed, then a `.gezmodel` bundle you ship, then a catalog download. Export a bundle with `gezel model export <id>`, put it in your app's resources, and a first run needs no network:

```ts
await gezel.ensureModel({ model: 'gemma4-e2b-q4', bundle: '/opt/acme/gemma4-e2b-q4.gezmodel' });
```

`ensureProject` does the same for a `.gezapp`'s declared chat-model dependencies — pass `bundles: { 'gemma4-e2b-q4': '/opt/acme/gemma4-e2b-q4.gezmodel' }`.

Both calls are idempotent, so the normal shape is to run them on every launch. `ensureProject` preserves the user's edits to seeded files and reuses the crew already on the roster.

## Custom app tools

Register tools your application runs itself. The model sees them beside gezel's own tools; when one is called, your handler runs in your process and its return value becomes the tool's output.

```ts
const registration = await project.registerTools({
  tools: [
    {
      name: 'add_travel_points',
      description: 'Award travel points to the traveller.',
      inputSchema: {
        type: 'object',
        properties: { points: { type: 'number' }, reason: { type: 'string' } },
        required: ['points'],
      },
      async handler({ points, reason }) {
        await awardPoints(Number(points), String(reason ?? ''));
        return `awarded ${points} points`;
      },
    },
  ],
});
```

Notes worth knowing:

- **Registration lives with the connection.** Close the handle, or exit, and the tools are withdrawn. A brief disconnect is held for a grace window and reconnects transparently; a tool whose handler is gone would accept a call and never answer, which is worse for the model than no tool at all.
- **Arguments are validated** against your `inputSchema` before the call leaves the daemon, so a malformed call comes back to the model as a fixable error instead of reaching your handler.
- **A handler that throws** is an ordinary tool failure: the model is told, and the turn continues.
- **Timeouts** default to 60 s per call (`timeoutMs`, max 300 s).
- Names are snake_case and may not shadow a built-in gezel tool.
- Needs the `product` scope (or a daemon your app hosts), and Node or Electron — `/api/*` is not reachable from a browser.

Tools work the same against a hosted daemon and the user's own gezel; `registerTools` is also available on a plain `authorize()` result via the exported `registerAppTools`.

## Headless / browser apps

The Node entry reads `~/.gezel/runtime/` to discover the daemon. In a browser (or any context without filesystem access), use the browser entry and supply `baseUrl` + an `existingToken` explicitly:

```ts
import { GezelApp } from '@bendyline/gezel-app-sdk/browser';

const app = new GezelApp({
  baseUrl: 'https://127.0.0.1:54321',
  token: tokenFromYourBackend,
  fetch: window.fetch,
});
```

Browser apps can't trust the loopback self-signed cert without OS-level intervention — gate browser support behind a desktop helper that does discovery + consent and ferries the resolved URL/token to the renderer.

## API surface

| Method | Purpose |
|---|---|
| `detectGezel({ timeoutMs? })` | Probe runtime files + health; defaults to a 5-second headers-and-body budget |
| `connect()` | Register + consent + token storage |
| `authorize()` | Generic discovery + consent result (`baseUrl`, scoped token, fetch) |
| `connectLocal()` | Complete Node-native discovery + consent, returning `GezelApp` and diagnostics |
| `authorizeLocal()` | Complete Node-native discovery + consent for typed product clients |
| `authorizeLocalOwner()` | First-party same-user daemon connection without app consent |
| `app.chat()` | OpenAI-compatible chat (streaming + non) |
| `app.embeddings()` | OpenAI-compatible embeddings |
| `app.models()` | List available models |
| `app.ensureModel()` | Make sure a local model is downloaded |
| `app.streamEnsureEvents()` | SSE: install progress + done/error |
| `app.revokeMyToken()` | Self-revoke (user can also revoke from Settings) |
| `app.close()` | Release the SDK-owned transport after consuming or cancelling response streams |

From `@bendyline/gezel-app-sdk/host`:

| Method | Purpose |
|---|---|
| `connectOrHost()` | Connect to the user's gezel, or host one in this process; returns a `Gezel` |
| `gezel.ensureModel()` | Engine binary + weights (present, bundled, or downloaded) + default pin |
| `gezel.ensureProject()` | Bind a folder to a `GezelProject`, applying a `.gezapp` when one is given |
| `gezel.openProject()` | A `GezelProject` for a project that already exists |
| `gezel.client` | The full typed product API (`@bendyline/gezel-client`) |
| `gezel.openai` | The OpenAI-shaped `GezelApp` for stateless completions |
| `gezel.close()` | Stop a daemon this process started; release the transport either way |
| `project.openChat()` | Open or resume a conversation, by gezel id or role |
| `project.registerTools()` | Offer tools your application runs itself |
| `project.gezels` | Gezel id by role template id |
| `chat.send()` | Stream one turn as `delta` / `tool` / `complete` / `done` events |

## TLS pinning

The daemon serves HTTPS with a per-launch self-signed cert at `~/.gezel/runtime/cert.pem`. The SDK reads that cert and builds a fetch that trusts it — your first integration won't fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The `createTrustingFetch` helper is exported in case you build your own request pipeline.

Health discovery uses a separate five-second budget covering both headers and the
response body. `detectGezel({ timeoutMs: 2_000 })` customizes that budget in awake
milliseconds. A stalled health request returns `installed: true, running: false`;
it never waits on the inference transport's unlimited header/body policy. Native
SDK discovery uses the same default health budget.

Temporary probes close their dispatcher after a response and destroy it on a
request failure or timeout. Connected apps own their dispatcher until `app.close()`
(or the authorization result's optional `close()` callback). Injected fetches are
borrowed and never closed or destroyed by the SDK. The Node fetch helpers also
expose `close()` and `destroy()` for callers managing their own transport lifetime.

## Errors

Errors thrown by the SDK are `GezelSdkError` instances carrying both an HTTP `status` (when known) and a `code` from the server's response envelope. Common codes:

- `daemon_not_running` — no runtime files / health probe failed
- `user_denied` — consent dialog rejected
- `approval_timeout` — `approvalTimeoutSec` elapsed
- `grant_expired` — the request expired or used all verification attempts
- `verification_code_handler_required` — a stateful scope omitted `onVerificationCode`
- `verification_not_supported` — the daemon did not honor an explicit code requirement
- `model_not_found` — unknown `<provider>:<model>` prefix
- `tool_calling_not_supported_v1` — `tools` / `tool_choice` field present (deferred to v2)
- `embeddings_not_supported` — provider doesn't expose embeddings
- `missing_scope:<scope>` — token is missing the requested scope
- `provider_error` — backend provider call failed

From the host entry:

- `node_binary_required` — hosting under Electron without `host.nodePath`
- `service_not_installed` — `@bendyline/gezel-service` is not installed and no `serviceModule` was passed
- `host_already_active` — this process already hosts a daemon
- `folder_has_other_app` — the target folder belongs to a different app's project
- `tool_name_reserved` / `tool_name_conflict` — an app tool name collides with a built-in or another app

## OpenAPI

The daemon serves the public contract at `GET /v1/openapi.json` (unauth). Point Swagger UI, Redocly, or your codegen at it.

## Spec

See the upstream gezel docs for the full route table and the OpenAPI document. The SDK is a thin wrapper over those routes; the routes are the source of truth.
