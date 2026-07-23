# @bendyline/gezel-app-sdk

Public SDK for building third-party local apps against [gezel](https://github.com/bendyline/gezel). Gives you discovery, user consent, and an OpenAI-compatible chat / embeddings / models / ensure-model client in under 50 lines.

## Why

If you ship a desktop app and want to use the user's locally-installed models without re-implementing model management, runtime detection, and TLS pinning — point this SDK at gezel and you're done. Apps that already target OpenAI's chat API can use gezel as a drop-in via the OpenAI-shaped envelopes.

## Install

```bash
npm install @bendyline/gezel-app-sdk
```

Node 20+. The Node entry uses `undici` to trust gezel's loopback TLS cert.

## Quickstart

```ts
import { detectGezel, connect } from '@bendyline/gezel-app-sdk';

const status = await detectGezel();
if (!status.installed) throw new Error('gezel not installed');
if (!status.running) throw new Error('start the gezel app first');

const app = await connect({
  appId: 'docblocks',
  appName: 'DocBlocks',
  scopes: ['openai'],
  tokenStorage: {
    async save(id, token) {
      await keychain.set(`gezel:${id}`, token);
    },
    async load(id) {
      return keychain.get(`gezel:${id}`);
    },
  },
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

For CI / scripted environments, the gezel daemon honors `GEZEL_AUTOAPPROVE_APPS=appId1,appId2` and auto-approves listed apps at registration time.

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
| `detectGezel()` | Probe runtime files + health |
| `connect()` | Register + consent + token storage |
| `app.chat()` | OpenAI-compatible chat (streaming + non) |
| `app.embeddings()` | OpenAI-compatible embeddings |
| `app.models()` | List available models |
| `app.ensureModel()` | Make sure a local model is downloaded |
| `app.streamEnsureEvents()` | SSE: install progress + done/error |
| `app.revokeMyToken()` | Self-revoke (user can also revoke from Settings) |

## TLS pinning

The daemon serves HTTPS with a per-launch self-signed cert at `~/.gezel/runtime/cert.pem`. The SDK reads that cert and builds a fetch that trusts it — your first integration won't fail with `UNABLE_TO_VERIFY_LEAF_SIGNATURE`. The `createTrustingFetch` helper is exported in case you build your own request pipeline.

## Errors

Errors thrown by the SDK are `GezelSdkError` instances carrying both an HTTP `status` (when known) and a `code` from the server's response envelope. Common codes:

- `daemon_not_running` — no runtime files / health probe failed
- `user_denied` — consent dialog rejected
- `approval_timeout` — `approvalTimeoutSec` elapsed
- `model_not_found` — unknown `<provider>:<model>` prefix
- `tool_calling_not_supported_v1` — `tools` / `tool_choice` field present (deferred to v2)
- `embeddings_not_supported` — provider doesn't expose embeddings
- `missing_scope:<scope>` — token is missing the requested scope
- `provider_error` — backend provider call failed

## OpenAPI

The daemon serves the public contract at `GET /v1/openapi.json` (unauth). Point Swagger UI, Redocly, or your codegen at it.

## Spec

See the upstream gezel docs for the full route table and the OpenAPI document. The SDK is a thin wrapper over those routes; the routes are the source of truth.
