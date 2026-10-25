# @bendyline/gezel-app-sdk

Public SDK for building third-party local apps on [Gezel](https://github.com/bendyline/gezel). Gives you discovery, user consent, and an OpenAI-compatible chat / embeddings / models / ensure-model client in under 50 lines.

## Why

If you ship a desktop app and want to use the user's locally installed models without re-implementing model management, runtime detection, and TLS pinning, point this SDK at Gezel and you're done. Apps that already target OpenAI's chat API can use Gezel as a drop-in through the OpenAI-shaped envelopes.

If your users may not have Gezel at all, the [`/host`](#hosting-gezel-inside-your-app) entry runs one inside your own application, against a Gezel home that belongs to your app. Same API either way.

## Install

```bash
npm install @bendyline/gezel-app-sdk
```

Node 24+. The Node entry uses `undici` to trust Gezel's loopback TLS certificate.

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
if (!status.installed) throw new Error('Gezel is not installed');
if (!status.running) throw new Error('start the Gezel app first');
if (!status.compatible) throw new Error('update the Gezel app');

const app = await connect({
  appId: 'acme.notes',
  appName: 'Acme Notes',
  scopes: ['openai'],
  tokenStorage,
});

// Make sure the model is downloaded and warm.
const ensure = await app.ensureModel({
  model: 'llama-cpp:gemma4-e2b-q4',
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
  model: 'llama-cpp:gemma4-e2b-q4',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

## Consent flow

The first time your app calls `connect()` for a given `appId`, Gezel shows a desktop consent dialog to the user. You'll see one of:

- **Approved** — your app stores the issued token via `tokenStorage.save`. Subsequent runs (via `tokenStorage.load`) skip the dialog entirely.
- **Denied** — `connect()` throws a `GezelSdkError` with `code: 'user_denied'`. Tell your user plainly that they declined the Gezel connection.
- **Timeout** — defaults to 120s. Override with `approvalTimeoutSec`. Throws `code: 'approval_timeout'`.

Gezel keeps one grant per `appId`. Registering again while a request is still
waiting for the user fails with `grant_already_pending`, and registering an app
that is already connected fails with `already_connected` (both HTTP 409). Reuse
the stored token instead. To start over, revoke the old grant with
`app.revokeMyToken(appId)`, or have the user remove the app in Gezel's settings.

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

It connects directly to the user's own Gezel service, described by
`~/.gezel/runtime`. The returned object contains only the app's scoped token
plus non-sensitive daemon diagnostics. It never exposes the daemon's own
credential.

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

SDK-owned launches are always detached per-user daemons on a free port. They
publish their actual address through the user's runtime directory, where the
next discovery finds them.

Gezel's own desktop app and CLI use `authorizeLocalOwner()`, which connects
as the user who owns the daemon without an app consent request.
Third-party integrations must use `authorizeLocal()`; the owner surface is not
an app-consent bypass. Likewise, `gezelAddIn: true` is reserved for Gezel's own
add-ins (Office, LibreOffice, VS Code): the daemon refuses it for any other app
id, so it does nothing for third-party apps.

Use `product` for ordinary stateful product access and add `openai` only when
the same app also calls the OpenAI-compatible inference routes. `product` does
not grant first-party administration of other app connections.

For CI / scripted environments, the Gezel daemon honors `GEZEL_AUTOAPPROVE_APPS=appId1,appId2` and auto-approves listed apps at registration time.

## Hosting Gezel inside your app

`connect()` needs a Gezel the user already runs. When your app should work whether or not they have one, use the host entry: it can connect to their Gezel when it is there (see [When hosting happens](#when-hosting-happens)), and otherwise starts one in your own process.

```ts
import { connectOrHost } from '@bendyline/gezel-app-sdk/host';

const gezel = await connectOrHost({
  appId: 'acme.travel',
  appName: 'Acme Travel',
  // Lets the SDK ask to join the user's own Gezel. Without it, a product
  // grant cannot be approved, so the SDK hosts privately instead.
  onVerificationCode(code) {
    console.log(`Enter ${code} in Gezel to connect Acme Travel.`);
  },
  // Hosting is opt-in. Without `host`, a missing Gezel is still an error.
  host: { mode: 'in-process' },
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

- **Its own home.** State goes under `~/.gezel/apps/<appId>/` (or the folder you pass as `host.home`), never the user's own `~/.gezel`. Your app's projects and gezels stay out of their workshop, and the Gezel desktop app can never restart your daemon out from under you.
- **Their models, read-only.** Models the user already installed are found through a read-only overlay, so a 2 GB download does not happen twice. Nothing of yours is ever written there.
- **No Chromium.** The system bootstrap (Playwright plus a ~280 MB browser) is off unless you pass `host: { systemBootstrap: true }`.
- **One per process.** The daemon reads its settings from the environment, so a second hosted daemon in the same process is refused. A second *instance of your app* adopts the daemon the first one started.
- **Logs on stderr.** An in-process daemon writes its log records to stderr, so your app's stdout carries only what your app writes there. `host: { logOutput: 'split' }` restores Node's convention (info on stdout), and `GEZEL_LOG_LEVEL` sets how much is written (`silent` for nothing).
- **Its own port.** A hosted daemon always listens on a free port chosen at launch, never the canonical port 6228 the user's own Gezel uses.
- **An inference-only profile.** `host: { inferenceOnly: true }` serves on-device model listing and installation, OpenAI-compatible chat and Responses, embeddings (`model: 'gezel:embeddings'` runs the on-device text embedder) and knowledge search — and nothing of the product: no projects, chats or app tools, so `ensureProject` and `openChat` need a full host. It starts no background jobs or indexing, and sets up no remote connectivity: no secret store (nothing in the OS keychain), no device identity, and no pairing or LAN-serving endpoints. Both host modes serve the same surface. In-process, the SDK calls `@bendyline/gezel-inference` directly, so Electron needs neither a separate Node executable nor a loopback network connection.

An inference-only app ensures its model and chats with the id `ensureModel` returns as `chatModel`, which names the engine as well as the model:

```ts
const gezel = await connectOrHost({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['openai'],
  host: { mode: 'in-process', inferenceOnly: true },
});

const { chatModel } = await gezel.ensureModel({ model: 'qwen3.5-0.8b-q4' });

const reply = await gezel.openai.chat({
  model: chatModel, // 'mlx:qwen3.5-0.8b-q4' on Apple Silicon, 'llama-cpp:…' elsewhere
  messages: [{ role: 'user', content: 'Suggest a title for these notes: …' }],
});
console.log(reply.choices[0].message.content);

await gezel.close();
```

A bare id such as `qwen3.5-0.8b-q4` also works while it is the pinned default, which `ensureModel` sets on a daemon your app hosts.

Install `@bendyline/gezel-inference` alongside this SDK for inference-only in-process hosting, or `@bendyline/gezel-service` for full or child-process hosting. Both are optional peer dependencies, so apps that only connect never download either.
Keep the SDK and the hosting package on compatible releases. A hosting package
too old to start the inference-only profile fails immediately with
`service_inference_only_unsupported` instead of silently starting the full
product.

**Under Electron**, `process.execPath` is your app binary, not Node. Full-product hosting runs a tool server as a child process, so ship a Node binary and pass `host: { nodePath }`; without one, the SDK uses the Node a Gezel install keeps at `<Gezel home>/bin/node` when available. Inference-only in-process hosting starts no child-process features and needs no Node path.

### When hosting happens

`connectOrHost` uses an explicit `baseUrl` if you pass one (and never falls
through from it), then the user's own running Gezel, then a daemon of your own
when you passed `host`. Whether it asks the user's Gezel at all depends on
whether that request could be approved:

- **Inference-only scopes** (`openai`, `remote-inference`) use click approval,
  so the SDK asks the running Gezel and the user sees the consent dialog.
- **Any other scope**, including the default `['product', 'openai']`, needs a
  verification code shown by your app. With `onVerificationCode`, the SDK asks
  the running Gezel. Without it, the SDK cannot ask: it reuses a grant saved in
  `tokenStorage` or `existingToken` when there is one, and otherwise hosts a
  private daemon **without contacting the user's Gezel, even when it is
  running**. The same applies to inference-only scopes when you set
  `requireVerificationCode: true`.
- **`adoptUserDaemon: false`** always hosts, whatever else is running.

Once the SDK has asked, only a Gezel that is not running, or one that does not
speak this SDK's API (`daemon_incompatible`), falls through to hosting. A
person who declines the connection, or lets the approval expire, gets exactly
that: no private daemon started behind their back.

**`hostWhenRefused: true`** also hosts after a refusal, an expired or
unanswered approval, an app that is already connected, or a connected-app
surface switched off in Gezel. It is for apps that obtain their own consent —
the AI is optional and the person switched it on inside the app. A daemon that
is alive but unwell still fails loudly.

For an app whose own **Use AI** switch is the consent boundary, the silent
startup policy is therefore:

```ts
const gezel = await connectOrHost({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['openai'],
  requireVerificationCode: true,
  tokenStorage,
  // No onVerificationCode at startup: reuse a saved grant or host, never prompt.
  host: { mode: 'in-process', inferenceOnly: true },
  hostWhenRefused: true,
});
```

Connecting the standalone Gezel later is an optional user action: close the
private connection and repeat the call from that action with an
`onVerificationCode` handler. Omitting that handler during startup is what
makes the initial path incapable of raising a connection prompt.

### Shipping the engines with your app

A hosted daemon downloads the native engine it pins (`llama-server`, from the `native-v<release>` GitHub release) the first time a model needs it. To skip that download — or to work offline from the first launch — ship the engines and pass their directory:

```ts
host: { nodePath, daemonEntry, nativeBinDir: '/opt/acme/gezel-host/native-bin' }
```

The directory holds the extracted release archives as `<platform>-<backend>/` — for example `win32-x64-vulkan/` and `win32-x64-cpu/`, each with its `gezel-llama-server` and libraries. Discovery falls back from CUDA to Vulkan to CPU, so Vulkan plus CPU serves most machines without the much larger CUDA archive. Ship the release the bundled service pins, verified against its digests; the service publishes both as data, without loading any daemon code:

```ts
import {
  NATIVE_ENGINE_RELEASE,
  NATIVE_ENGINE_ARCHIVE_SHA256,
} from '@bendyline/gezel-service/native-release';
```

Engines from another release may not accept the flags the daemon passes them. On macOS the release's binaries arrive Developer ID signed; exclude that tree from re-signing so the pinned bytes stay intact.

### Shipping a model with your app

`ensureModel` resolves in three steps: already installed, then a `.gezmodel` bundle you ship, then a catalog download. Export a bundle with `gezel model export <id>`, put it in your app's resources, and a first run needs no network:

```ts
await gezel.ensureModel({ model: 'gemma4-e2b-q4', bundle: '/opt/acme/gemma4-e2b-q4.gezmodel' });
```

An app that may prepare an engine automatically but requires a separate user
gesture before downloading model weights uses `allowWeightDownload: false`.
If the model is absent, Gezel prepares the engine and then throws
`model_download_required` before any weight download starts:

```ts
await gezel.ensureModel({
  model: 'gemma4-e2b-q4',
  allowWeightDownload: false,
});
```

`ensureProject` does the same for a `.gezapp`'s declared chat-model dependencies — pass `bundles: { 'gemma4-e2b-q4': '/opt/acme/gemma4-e2b-q4.gezmodel' }`.

Both calls are idempotent, so the normal shape is to run them on every launch. `ensureProject` preserves the user's edits to seeded files and reuses the crew already on the roster.

## Custom app tools

Register tools your application runs itself. The model sees them beside Gezel's own tools; when one is called, your handler runs in your process and its return value becomes the tool's output.

```ts
const registration = await project.registerTools({
  tools: [
    {
      name: 'add_travel_points',
      description: 'Award travel points to the traveler.',
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
- Names are snake_case and may not shadow a built-in Gezel tool.
- Needs the `product` scope (or a daemon your app hosts), and Node or Electron — `/api/*` is not reachable from a browser.

Tools work the same against a hosted daemon and the user's own Gezel; `registerTools` is also available on a plain `authorize()` result via the exported `registerAppTools`.

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
| `app.revokeMyToken(appId)` | Self-revoke this app's token (the user can also revoke it in Settings) |
| `app.close()` | Release the SDK-owned transport after consuming or canceling response streams |

From `@bendyline/gezel-app-sdk/host`:

| Method | Purpose |
|---|---|
| `connectOrHost()` | Connect to the user's Gezel, or host one in this process; returns a `Gezel` |
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
- `daemon_incompatible` — a daemon is running but does not serve this SDK's API generation (the `apiCompat` range on `/api/health`): it predates the handshake, or one side needs updating. Versions are never compared; a daemon the SDK started itself is never checked. `connectOrHost` with `host` runs its own daemon instead
- `user_denied` — consent dialog rejected
- `approval_timeout` — `approvalTimeoutSec` elapsed
- `grant_expired` — the request expired or used all verification attempts
- `grant_already_pending` (HTTP 409) — a connection request for this `appId` is still waiting for the user
- `already_connected` (HTTP 409) — this `appId` already holds a grant; reuse its stored token, or revoke it before registering again
- `verification_code_handler_required` — a stateful scope omitted `onVerificationCode`
- `verification_not_supported` — the daemon did not honor an explicit code requirement
- `model_not_found` — unknown `<provider>:<model>` prefix
- `tools_not_supported_for_provider` — the resolved provider runs its own tool loop and cannot take caller-executed tools
- `tool_choice_function_not_supported_v1` — a specific function was pinned via object-form `tool_choice`
- `embeddings_not_supported` — provider doesn't expose embeddings
- `missing_scope:<scope>` — token is missing the requested scope
- `capacity_denied` — this machine does not have enough free memory to run the on-device model
- `engine_busy` — the on-device engine is busy with another request; retry shortly
- `engine_launch_failed` — the on-device engine process could not be started
- `engine_crashed` — the on-device engine stopped unexpectedly; the next request restarts it, on another engine build when the crash proved this one cannot run here
- `engine_out_of_memory` — the computer ran out of memory and Linux stopped the on-device engine; the next request restarts it, but sending the same request into the same shortage fails the same way
- `engine_not_ready` / `model_not_ready` — the engine or model is still downloading or loading
- `context_length_exceeded` (HTTP 400) — the prompt is longer than the model's context window
- `provider_error` — backend provider call failed for any other reason

From the host entry:

- `node_binary_required` — hosting under Electron without `host.nodePath`
- `service_not_installed` — the hosting package (`@bendyline/gezel-service`, or `@bendyline/gezel-inference` with `inferenceOnly`) is not installed and no `serviceModule` was passed
- `host_already_active` — this process already hosts a daemon
- `folder_has_other_app` — the target folder belongs to a different app's project
- `tool_name_reserved` / `tool_name_conflict` — an app tool name collides with a built-in or another app

## OpenAPI

The daemon serves the public contract at `GET /v1/openapi.json` (unauth). Point Swagger UI, Redocly, or your codegen at it.

## Spec

The SDK is a thin wrapper over the daemon's HTTP routes, and the routes are the source of truth. The full route table is in the [Gezel repository](https://github.com/bendyline/gezel).

## Application embedding wrapper

For opt-in lifecycle, model readiness/preparation, cancellation, and packaging, see
[the embedding guide](https://github.com/bendyline/gezel/blob/main/docs/embedding-sdk.md).
The existing low-level connection APIs remain available. Applications with an
existing lifecycle can use `connectDesktopEmbedding` from `/host`; it shares the
same consent and hosted-model policy and returns `app`, `models`, `mode`,
`revoke`, and `close`. Both desktop APIs opt into catalog authority with
`knowledge: true`. `streamText` accepts temperature/reasoning controls and optional
knowledge budgets, and emits progress plus final model/usage metadata.

## Knowledge catalogs

Request the `knowledge` scope alongside `openai` and show the verification code
when connecting a user's Gezel. The SDK probes both scopes on reconnect; an old
inference-only grant cannot silently gain catalog-management authority. The same
API works through the private in-process host's direct Fetch transport.

- `app.knowledge.state({ signal })` lists installed and available catalogs,
  updates, download progress, and errors. `improvement` is non-null when a
  one-time relevance-model download would rank passages better: a catalog is
  enabled, the model is missing, and this Gezel can download it. It carries
  `downloadBytes` for the offer and `downloading` / `percent` once started.
- `app.knowledge.update({ action, catalogId }, { signal })` supports
  `install` (also updates), `remove`, `enable`, `disable`, and `cancel`.
  Only curated IDs are accepted; downloads use private user placement. Removal
  affects every app using that provider's catalog registry.
- `app.knowledge.update({ action: 'prepare-reranker' }, { signal })` starts the
  `improvement` download. Poll state until `improvement` is null.
- `app.knowledge.retrieve({ query, maxResults: 4, maxCharacters: 12000 },
  { signal })` returns bounded, cited passages from enabled catalogs. By
  default (`rerank: 'auto'`) Gezel ranks them with the relevance model when it
  is installed, and otherwise returns only passages that clear the bar Gezel
  applies to its own unranked catalog hits; `reranked` says which. A missing
  model is never an error. Against a Gezel older than `auto`, the SDK falls back
  to `required` and returns no passages when that Gezel has no model.
  `rerank: 'required'` refuses with `reranker_required` instead. Neither mode
  installs the model.

Offer `improvement` to people as better results with its size, for example
"Improve knowledge results with a 300 MB model download", and stop showing it
once it is null.

The caller includes returned passages in its own chat prompt as untrusted
reference material. Plain `app.chat()` does not implicitly retrieve knowledge.
With no enabled catalogs or no candidates, retrieval returns an empty list.
Gezel's bundled Handboek is Gezel's own manual: apps never see, manage, or
retrieve from it, so a fresh install has no enabled catalogs and needs no
relevance model.
Catalog and relevance-model downloads must follow an explicit user action.
This surface grants no access to projects, sessions, arbitrary paths, URLs,
machine-wide catalogs, or broader product administration.

## Image generation

`app.images` renders images on this computer with Gezel's local engine
(stable-diffusion.cpp) and manages its models. It needs the `images` scope,
which carries a verification code because image models use graphics memory and
tens of gigabytes of disk. Hosted inference grants it to its host.

- `app.images.support({ signal })` reads health: `supported` is false on a
  Gezel that predates image generation for apps, `available` false when no
  engine can render here. Ask for the scope only when `supported` is true.
- `app.requestScopes({ appId, appName, scopes: [...held, 'images'],
  onVerificationCode, tokenStorage })` adds the scope to a connected app from
  an explicit action. The current token keeps working until the person
  approves; the client then switches to the new token. It never revokes, and
  answers `images_unsupported` or `scope_upgrade_unsupported` before changing
  anything on a Gezel that cannot.
- `app.images.models({ signal })` lists installed and downloadable models as
  `sd-cpp:<catalogId>`, apart from `/v1/models`, with `fit`, `license`,
  `commercial_use`, `renders_text`, `prompt_style` and `hardware_tier`.
  `shared` marks a model another store owns, which `remove` refuses.
- `app.images.ensure(model)` returns `ready` or a background download's
  `jobId`; `ensureEvents(jobId)` streams its progress and `cancelEnsure(jobId)`
  stops it. A model that cannot run on this computer refuses with
  `model_wont_run`.
- `app.images.generate({ prompt, model, aspectRatio, quality, seed },
  { onProgress, signal })` returns the PNG bytes and the size, seed and model
  used. Progress phases are `queued`, `loading_model` (weights load inside the
  first render after the engine starts), `sampling` and `decoding`. Renders
  run one at a time. Aborting the signal stops the render by stopping the
  engine, so the next render reloads its weights. Failures carry codes such as
  `image_capacity` (not enough graphics memory), `no_local_image_model` and
  `model_not_installed`.

### Live inference progress

Pass `stream_options: { include_progress: true, include_usage: true }` to `app.chat`
with `stream: true`. Progress-only chunks have an empty `choices` array and a
validated `gezel_progress` object: `phase` (`starting`, `queued`, `loading_model`,
`prefill`, `reasoning`, or `generating`), `percent`, `outputTokens`, and
`tokensPerSecond`. Read reply text with `chunk.choices[0]?.delta.content`.

Percentages come from the engine and apply only to loading or prefill. Token
counts and throughput are exact when reported; unknown values are `null`.
Counts may include private reasoning, but progress never includes reasoning
text, prompts, session identifiers, or engine log messages. Phase transitions
are immediate and counter updates are throttled. Providers without telemetry
still announce observed reasoning/response activity; older Gezel releases
ignore the option and keep streaming content normally. This requires a Gezel
service release containing the progress extension, not just an SDK update.

`withKnowledgeContext(app.knowledge, messages, options)` provides optional cited
evidence within explicit `maxPromptCharacters` and `maxMessages` limits. Optional
context/output budgets use a conservative character estimate, not a tokenizer.
It fails open on unavailable or malformed knowledge and propagates cancellation;
plain `app.chat` does not enrich requests automatically. This helper is also
available from `/browser`. `knowledgeContext(…)` takes the same options and also
reports what it added (`status`, `reason`, `passages`). Pass `query` to search
for what the person asked rather than the last user message, and
`citations: 'numbered'` to have passages cited as `[n]`; check the result with
`groundText()` from `@bendyline/gezel/grounding`.
