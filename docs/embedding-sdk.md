# Embedding Gezel in an application

The optional embedding wrapper owns AI lifecycle and model preparation across
Electron/Node and Capacitor. Applications keep their preferences, encrypted
credential storage, UI, document transactions, and result-review policy.
The existing `GezelApp`, `connectRuntime`, and `connectOrHost` APIs remain available.

## Small application adapter

```ts
// Capacitor
import { createMobileEmbedding, selectModel } from '@bendyline/gezel-capacitor';
const ai = createMobileEmbedding();

// Electron main process: use this factory instead of createMobileEmbedding.
// import { createDesktopEmbedding } from '@bendyline/gezel-app-sdk/host';
// const ai = createDesktopEmbedding({
//   appId: 'my-editor', appName: 'My editor', tokenStorage,
//   hostWhenRefused: true, // only if the app obtains its own AI consent
//   host: { home: privateHome, nativeBinDir: bundledEngines,
//           distributionProfile: 'store' },
//   onVerificationCode: showConnectionCode,
// });

await ai.setEnabled(savedPreferences.aiEnabled); // no connection or native calls
const choices = await ai.models.list();          // lazy, silent connection
const selected = selectModel(choices, {
  preferredId: savedPreferences.model,
  fallback: savedPreferences.model ? 'none' : 'prefer-system',
});
if (selected) {
  await ai.streamText({
    model: selected.id,
    messages: [{ role: 'user', content: 'Summarize this paragraph…' }],
    maxTokens: Math.min(512, selected.max_output_tokens ?? 512),
  }, { signal: requestController.signal, onEvent: renderDraft });
}
// From a Download/Prepare gesture only:
const installed = await ai.models.prepare(chosenId, {
  allowDownload: true, signal: downloadController.signal, onProgress: showProgress,
});
saveSelectedModel(installed.id);

await ai.suspend();       // background: abort requests/preparation, await disposal
ai.resume();             // foreground: reconnect on next use
await ai.setEnabled(false);
await ai.close();         // app teardown; await before destroying the host
```

`reconnect()` is the explicit Connect gesture and may display a verification
code. Initial connection and reconnection after suspension omit that handler
and require a code, so they can reuse a grant but cannot request new consent.
Configured remote failures and unhealthy daemons remain errors. The existing
`hostWhenRefused` policy determines whether a refused grant may use the app's
private service. Persist grants through an app-supplied secure `tokenStorage`.

The wrapper starts disabled. Reading preferences and constructing it do not
start Gezel. `list`, `inspect`, and `watch` never download weights or prepare
system models. `prepare` needs `allowDownload: true` for missing weights; its
promise resolves only after a terminal result and refreshed ready inventory.
Preparing an installed catalog alias returns its canonical installed ID without
downloading again. A saved selection never falls back unless the app explicitly
chooses a fallback policy.

`streamText` emits deltas followed by exactly one `done` or `error`. Cancellation
returns `done` with the partial text and `cancelled: true`; errors also reject
the promise. Observer exceptions cannot change operation outcome. Preserve
`finishReason`: `length` means the result may be truncated. The wrapper never
writes the result into a document automatically.

## Models and readiness

`ModelManager` has the same contract on both platforms:

| Method | Behavior |
| --- | --- |
| `list({ signal })` | Installed models, system readiness, and available catalog entries |
| `inspect(id, { signal })` | One descriptor or `null`; accepts a catalog alias for installed weights |
| `prepare(id, { allowDownload, signal, onProgress })` | One explicit preparation operation; concurrent preparation rejects `busy` |
| `watch(listener, { signal, intervalMs, onError })` | Read-only polling, initial `ready` barrier, changed snapshots only, awaited `dispose()` |
| `close()` | Abort owned preparation and watches and await completion; permanently closes this manager |

Use `connectEmbeddingRuntime(plugin).models`, `createMobileModelManager(plugin)`,
or `createHttpModelManager(app)` when managing connections yourself and needing
`watch`. Dispose the watch with its owning view. Polling errors stop the watch
and reach `onError`; restart explicitly after recovery.

Descriptors include labels, locality, availability, reason codes and recovery
actions, preparation owner, download size, effective context/output limits,
default output budget, and accepted options when the transport can report them.
Missing metadata from older HTTP servers stays unknown. In particular, the SDK
does not infer local execution from a model name. Mobile exposes native
capabilities separately as `native_capabilities`; `capabilities` describes what
this transport actually accepts. Portable text chat does not advertise tools,
images, structured output, or sampling controls it cannot execute.

Apple Foundation Models preparation belongs to system settings. Android ML Kit
preparation uses the native provider's explicit download API. Availability
reasons remain visible in the model picker; no silent substitution occurs.
`mobileCatalog` and `mobileCatalogVersion` expose the SDK's pinned Gilde
projection. Native source resolution must preserve the pinned model identity,
and native installation verifies the file hash. Apps need no repository imports
or separate catalog extraction script. Producer refresh uses
`pnpm mobile:catalog:refresh`.

Cancellation ownership is explicit: a native manager reports
`cancellation: 'download'`; the HTTP manager reports `'observation'`. HTTP ensure
jobs may be shared with other apps, and disconnecting a subscriber does **not**
stop that shared download. It does stop waiting and prevents success/default
pinning. Do not label this action "Cancel download" for an HTTP connection.

Mobile preparation uses an awake-time budget and owns its abort cleanup,
including cancellation while a native start has not returned its download ID.
Applications should call `suspend` on background transitions, and `close` before
teardown. Native runtime adapters can still report platform limitations.

## Packaging

Electron build scripts can call
`stageElectronNative({ platform, arch, destination, cache })` from
`@bendyline/gezel-service/packaging`. It uses the **installed service's pinned
release**, verifies archive hashes, bounds extraction, preserves notices and
existing native signatures, and replaces the prior payload only after staging
succeeds. Copy the resulting directory into app resources with electron-builder.
Keep Gezel's already-signed executables out of any blanket re-signing hook;
sign the enclosing application normally. Unsupported targets fail unless the
build explicitly passes `allowUnavailable` and disables hosted AI.

At runtime, `verifyNativeBinaries` is the side-effect-free service verifier.
Store-mode in-process hosting invokes it before starting a service when a native
payload is configured. Store mode clears ambient developer engine overrides
for the host lifetime and refuses executable downloads. The desktop factory
requires a bundled engine path for store mode. Development can use the standard
profile. OS sandbox suitability, entitlements, architecture selection, and the
app's signing identity remain the application's release decisions.

Capacitor exports `@bendyline/gezel-capacitor/packaging`:

```js
import { verifyCapacitorPackage } from '@bendyline/gezel-capacitor/packaging';
const compatibility = await verifyCapacitorPackage();
```

The packaged `embedding-manifest.json` records SDK and native versions, ABI,
Capacitor compatibility, native toolchain/settings, privacy manifests, notices,
device qualification status, and hashes for shipped runtime files. The doctor
works in an installed package without the producer checkout. It verifies both
platforms, rejects unexpected native files, and never downloads or repairs
payloads. Trust the npm/release archive's external integrity first: an internal
manifest alone is not proof of origin. `stageNative` is also exported for build
pipelines. `configureCapacitorProject({ projectRoot, platform })` raises generated iOS/Android deployment floors to the SDK minimum after `cap sync`, preserving higher app requirements.

The Capacitor package remains a private preview pending its public release;
these APIs do not publish it. Native packaging retains the release policy in
[`native/runtime/PUBLIC-DISTRIBUTION.md`](../native/runtime/PUBLIC-DISTRIBUTION.md).
Device qualification is reported as recorded by the native release, never
inferred from TypeScript tests or a successful build.

## DocBlocks migration

This layer moves the reusable work out of DocBlocks: mobile catalog merging,
provider labels, preparation/polling, source pin checks, download cancellation,
lazy connection, opt-out/background cleanup, terminal text delivery, desktop
consent connection policy, native verification, environment restoration, and
native archive staging. A consumer upgrade can replace `mobile/src/ai/install`,
most of `models`, and lifecycle machinery in `host` with the wrapper; the desktop
connector uses the desktop factory and service packaging helper. Keep DocBlocks'
`host.ai` wire validation, renderer ownership, settings, encrypted token store,
and editor transaction/review behavior in DocBlocks. This change supplies the
upstream APIs; the existing released dependency pins do not gain new exports
until upgraded to packages containing this change.

## Qualification

After building core, client, App SDK and Capacitor and staging both native runtime
payloads, run `pnpm check:embedding-consumers`. It packs the actual SDKs, installs
them into a temporary directory, and runs an Electron-main CommonJS consumer and
a Capacitor consumer using a synthetic native bridge. `--offline --keep` uses
cached npm dependencies and retains the fixture for inspection.

On a machine with Xcode and Android toolchains, add `--native-ios --native-android`
to compile fresh Capacitor apps against those same tarballs. The fixture uses
`com.bendyline.gezel.embedding.tests`; compilation never installs or resets a
personal app. Native generation qualification remains the runtime consumer and
explicit-device synthetic-weight tests described in the native runtime guide.
