---
id: building-connected-apps-with-gezel-app-sdk
title: Building connected apps with gezel-app-sdk
order: 9
summary: Discover Gezel, ask for user consent, and use local models or product APIs from another app.
---

# Building connected apps with gezel-app-sdk

`@bendyline/gezel-app-sdk` is for software that runs *beside* Gezel. It lets a desktop or Node application discover the logged-in user's daemon, trust its loopback TLS certificate, ask the user for a scoped connection, remember the issued token securely, and use OpenAI-shaped model APIs.

This differs from `@bendyline/gezel-sdk`, whose scripts run *inside* Gezel's sandbox. A connected app owns its own interface and process. Gezel owns model discovery and downloads, consent, revocation, and the local inference service.

The [Connected apps](../conceptual/connected-apps.md) article explains what the user sees. This article covers the developer side.

## Install and connect

The Node entry requires Node.js 24 or newer:

```bash
npm install @bendyline/gezel-app-sdk
```

The normal third-party flow is: detect Gezel, request the narrowest scope, let the user approve in the desktop app, and store the resulting token in the operating system's credential store.

```ts
import { connect, detectGezel } from '@bendyline/gezel-app-sdk';

// Demo only: this lasts for one process. Replace it with Keychain,
// Credential Manager, libsecret, or your existing secure credential vault.
const demoTokens = new Map<string, string>();
const tokenStorage = {
  load: (appId: string) => demoTokens.get(appId) ?? null,
  save: (appId: string, token: string) => demoTokens.set(appId, token),
  delete: (appId: string) => demoTokens.delete(appId),
};

const status = await detectGezel();
if (!status.running) {
  throw new Error('Start Gezel, then connect this app again.');
}

const app = await connect({
  appId: 'acme.notes',
  appName: 'Acme Notes',
  scopes: ['openai'],
  tokenStorage,
});

const available = await app.models();
const model = available.data[0];
if (!model) throw new Error('No Gezel models are available.');

const stream = await app.chat({
  model: model.id,
  messages: [{ role: 'user', content: 'Give this note a short title.' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}
```

The in-memory map keeps the quickstart self-contained, but a real application must replace it with secure operating-system storage; do not save the token in source code, a project file, or plain-text preferences. `connect()` verifies a stored token still has the requested scopes. If it was revoked or is too narrow, the SDK discards it and starts a fresh visible consent flow.

Call `app.models()` rather than hardcoding a model id. The response is the authoritative list available to this connection and can include both raw models and eligible gezels. Selecting a gezel gives the caller that gezel's character and tuned model, while your app keeps ownership of its interface and conversation loop.

## Consent and scopes

Every connection has a stable `appId`, a user-visible name, and one or more scopes. The user can review and revoke it under **Settings → Connected Apps**.

| Scope | Use it for | Approval |
| --- | --- | --- |
| `openai` | Model listing, chat, embeddings, and ensuring a local model is present | Click approval by default |
| `product` | The ordinary Gezel product API through `@bendyline/gezel-client` | Approval plus a requester-visible verification code |
| `remote-inference` | Gezel's paired-device inference surface | Click approval by default |

Third-party applications should not request the first-party `cli` scope or call `authorizeLocalOwner()`. Those surfaces are reserved for Gezel's own command line and same-user clients. Ask for `product` only when the application truly needs projects, tasks, gezels, or other product state; add `openai` only if that same application also performs inference.

Stateful scopes require `onVerificationCode`. Show the code in the requesting application so the user can type it into Gezel's approval dialog:

```ts
import { authorizeLocal } from '@bendyline/gezel-app-sdk';

const authorized = await authorizeLocal({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['product'],
  tokenStorage,
  onVerificationCode(code) {
    showConnectionCode(code);
  },
});
```

The daemon generates the code and never sends it to the Gezel desktop approval surface. This proves that the person approving the grant can also see the application that requested it.

## Use the full product API

The app SDK's `GezelApp` class deliberately stays focused on the OpenAI-compatible surface. When a connected app also needs projects, tasks, chats, scripts, or other Gezel state, use `authorizeLocal()` to obtain the approved transport and pass it to the typed client:

```ts
import { authorizeLocal } from '@bendyline/gezel-app-sdk';
import { GezelClient } from '@bendyline/gezel-client/node';

const authorized = await authorizeLocal({
  appId: 'acme.editor',
  appName: 'Acme Editor',
  scopes: ['product'],
  tokenStorage,
  onVerificationCode: showConnectionCode,
});

const client = new GezelClient(authorized);
const projects = await client.listProjects();
```

This pairing is the supported route for a rich integration: the app SDK owns discovery, pinned TLS, consent, and scoped credentials; `@bendyline/gezel-client` owns the typed product API. Avoid hand-written `/api` requests when the client already covers the endpoint.

## Model and inference methods

| Method | Purpose |
| --- | --- |
| `app.models()` | List the models and gezels exposed to this app |
| `app.chat()` | OpenAI-compatible chat completion, streaming or complete |
| `app.embeddings()` | OpenAI-compatible embeddings when the selected provider supports them |
| `app.ensureModel()` | Make sure a catalog model is installed and warm |
| `app.streamEnsureEvents()` | Follow model download progress and completion over SSE |
| `app.revokeMyToken()` | Let the app revoke its own connection |

`detectGezel()` is a useful preflight, but it does not authorize anything. `connect()` returns a ready `GezelApp`; `authorize()` returns the generic base URL, token, and trusted `fetch`; `connectLocal()` combines the full Node-native local flow with non-sensitive daemon diagnostics.

Ordinary third-party apps should ask the user to start Gezel when discovery reports `daemon_not_running`. The optional start-if-missing path is only for native integrations that deliberately bundle the matching `gezeld` package.

## TLS, browsers, and errors

The local daemon uses a per-launch self-signed certificate. The Node SDK reads the public certificate from Gezel's runtime directory and constructs a pinned `fetch`, so you should not disable TLS verification globally or replace the transport with an unpinned client.

A browser cannot read `~/.gezel/runtime/` and cannot perform this local trust setup itself. Use a desktop helper to complete discovery and consent, then pass the resolved address and scoped token to a renderer that imports `GezelApp` from `@bendyline/gezel-app-sdk/browser`. Pure websites should not attempt to bypass the browser's loopback TLS protections.

Catch `GezelSdkError` and branch on its `code`. Common cases include `daemon_not_running`, `user_denied`, `approval_timeout`, `verification_code_handler_required`, `model_not_found`, `embeddings_not_supported`, `missing_scope:<scope>`, and `provider_error`. Treat denial as a normal user choice, and give timeouts and missing-daemon errors an obvious retry path.

The daemon publishes the current public OpenAPI document at unauthenticated `GET /v1/openapi.json`. Use it for route inspection or code generation; use the SDK types for ordinary application code.
