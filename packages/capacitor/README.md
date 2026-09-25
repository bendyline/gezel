# Gezel for Capacitor

`@bendyline/gezel-capacitor` connects the existing Gezel App SDK to an iOS or
Android app's own on-device runtime. No daemon, HTTP server, account, product
workspace, or speech pack is required. The package contains prebuilt llama.cpp
binaries; installing apps do not build the engine.

```ts
import { connect, GezelRuntime } from '@bendyline/gezel-capacitor';

// Show a system file picker. The model is copied into this app's private storage.
const { model } = await GezelRuntime.importModel();
if (model) {
  const app = connect(); // GezelApp<'portable'>, using the existing SDK client
  try {
    const stream = await app.chat({
      model: `llama-cpp:${model.id}`,
      messages: [{ role: 'user', content: 'Summarize these notes: …' }],
      stream: true,
      max_tokens: 512,
    });
    for await (const chunk of stream) {
      console.log(chunk.choices[0]?.delta.content ?? '');
    }
  } finally {
    await app.close();
  }
}
```

`app.models()` lists imported models and system providers with availability,
capabilities and qualified model IDs. Use the ID of the model the person chose.
Apple Foundation Models and Android ML Kit use the same `chat` method. An
unavailable provider is an error; there is no implicit model or cloud fallback.

`app.ensureModel({ model })` checks readiness. It never downloads implicitly.
`GezelRuntime.prepareProvider({ providerId: 'android-mlkit' })` explicitly asks
ML Kit to prepare its model; iOS manages Apple model preparation in Settings.
The native API also exposes pinned-source resolution, resumable GGUF downloads,
selection, removal, and `releaseModel()`. It is separate from ordinary inference
so an availability probe cannot start a large download.

## Contract and lifecycle

- Text messages (`system`, `user`, `assistant`), streaming, explicit model ID,
  and `max_tokens` are supported. Tools, images, JSON constraints, sampling
  options and other unsupported controls reject with `unsupported_capability`.
- Replies preserve `stop`, `length`, and `cancelled`. Usage is absent when the
  provider cannot measure it. Desktop's existing `GezelApp` default types remain
  unchanged; portable clients use `GezelApp<'portable'>`.
- Pass `{ signal }` as the second `chat` argument to cancel. Breaking out of a
  stream or closing its client also cancels and waits for native release.
- Clients share one process runtime and admission gate. Closing an idle client
  does not stop another client's generation. `releaseModel()` is explicitly
  process-wide and may cancel active work. A closed client cannot be reused.
- Backgrounding cancels inference and pauses downloads; foregrounding does not
  automatically restart either. Memory/thermal admission remains native.
- Model files belong to the host app's sandbox. Sharing this package between
  Docblocks and Qualla does **not** share their live model files or permissions.
- The embedding application owns WebView navigation and content trust, as with
  other Capacitor native plugins. Keep untrusted pages out of the privileged
  app bridge; this plugin does not override the application's navigation policy.

`connectRuntime(plugin)` accepts an injected implementation for alternate native
bridges and contract tests. `connect()` requires a native Capacitor platform;
there is no browser runtime stub pretending to run a local model.

## Local development and distribution

This is a local preview; registry publication is not required. The producer
stages the runtime once using [the native host guide](../../native/runtime/README.md),
then builds and packs this package. Install matching local tarballs for `gezk`,
core, client, App SDK and Capacitor in the consumer app, and run `npx cap sync`.

```sh
# In the Gezel checkout; dependency installation follows the repository's lease policy.
node packages/capacitor/scripts/stage-native.mjs ios /path/to/staged-ios-runtime
node packages/capacitor/scripts/stage-native.mjs android /path/to/staged-android-runtime
# Build core and app-sdk first, then this package. Pack with pnpm so workspace:*
# references become ordinary package versions.
pnpm --filter @bendyline/gezel-capacitor build
pnpm --filter @bendyline/gezel-capacitor pack --pack-destination /path/to/local-packages
```

Pack the other four workspace packages into that same folder with `pnpm pack`.
For pnpm 11 local previews, put overrides for the five `@bendyline/*` packages
in the **consumer's** `pnpm-workspace.yaml`, so transitive dependencies resolve to
the matching tarballs rather than looking up unreleased versions in a registry:

```yaml
overrides:
  '@bendyline/gezel-capacitor': file:/path/to/local-packages/bendyline-gezel-capacitor-0.1.0.tgz
  '@bendyline/gezel-app-sdk': file:/path/to/local-packages/bendyline-gezel-app-sdk-1.0.10.tgz
  '@bendyline/gezel-client': file:/path/to/local-packages/bendyline-gezel-client-1.1.2.tgz
  '@bendyline/gezel': file:/path/to/local-packages/bendyline-gezel-1.1.2.tgz
  '@bendyline/gezk': file:/path/to/local-packages/bendyline-gezk-1.0.2.tgz
```

Use the filenames actually produced by your checkout. Then add the Capacitor
package and `@capacitor/core` to that app's dependencies normally. Registry
releases will remove the need for these local overrides. No `node_modules`
folder or running model service needs to be shared between the applications.

The `prepack` check verifies both native payloads and requires matching versions.
The tarball includes a self-contained Swift package and folder Maven repository.
There are no consumer references to `native/mobile/.build` or sibling checkouts.
Use Capacitor 8.5.2, Android API 28+ (compile SDK 36), and iOS 16.4+ with a current
Xcode toolchain supporting the Foundation Models adapter. System AI availability
depends on OS, hardware, configuration and model readiness. The current engine
preview includes arm64 Android, arm64 iOS devices and arm64 iOS simulators.

Native generation on physical devices, store distribution, and third-party
application adoption remain qualification steps; package compilation alone is
not an inference-quality certification.
