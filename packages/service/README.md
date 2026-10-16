# @bendyline/gezel-service

`gezeld`, the [Gezel](https://github.com/bendyline/gezel) service. A local HTTP
service that owns chat sessions, routes to LLM providers, manages memories,
tasks and projects, and reads and writes everything under `~/.gezel/`.

This is what `@bendyline/gezel-cli` runs behind the scenes. Install it directly
only if you are embedding Gezel or running the service standalone.

```bash
npm install @bendyline/gezel-service
npx gezeld
```

`gezeld` runs in the foreground and is configured through environment
variables (see [Environment](#environment)); `npx gezeld --help` lists them.

## What it contains

- Hono HTTP API on loopback, bearer-token authenticated
- `Store` — the single read/write path for all on-disk state
- `ChatManager` — session lifecycle, persistence, provider-state resume
- Providers: Copilot, OpenAI, Anthropic, llama.cpp, MLX, ds4, and a
  deterministic mock for tests
- A per-session MCP bridge over stdio and streamable HTTP
- Memory (sqlite-vec), history, tasks, usage tracking, engine downloads
- **The bundled web UI** at `dist/ui/`, so `gezel start --web` serves a full
  browser interface from a Node-only install with nothing else to fetch

## Entry points

| Subpath | Contents |
|---|---|
| `@bendyline/gezel-service` | `startService()` and the service types |
| `@bendyline/gezel-service/handboek` | Handboek rendering helpers |
| `@bendyline/gezel-service/gezapp` | AI App (`.gezapp`) validation, packing, and reading, without starting the service |
| `@bendyline/gezel-service/native-release` | The pinned native engine release and its archive digests, as data |
| `@bendyline/gezel-service/media` | Image, audio, and video embedding for building knowledge catalogs |
| `@bendyline/gezel-service/packaging` | Build-time helpers that stage the pinned native engines for an Electron app |
| `@bendyline/gezel-service/dist/bin/gezeld.js` | The service executable, also installed as the `gezeld` command. Tools that start Gezel for you, such as the CLI and the app SDK, launch this file |

```ts
import { startService } from '@bendyline/gezel-service';

const { port, clientToken, stop } = await startService({ home: '/tmp/gezel-home' });
console.log({ port, clientToken });
await stop();
```

## Optional peers

The base npm install leaves out a few large or native pieces. Cloud providers,
native engines, the HTTP API, MCP, UI, tasks, and file features work without
them. Install each only when this deployment needs it:

| Package | Needed for |
|---|---|
| `@huggingface/transformers@^4.3.1` | In-process memory embeddings |
| `kokoro-js@^1.2.1` | Kokoro text-to-speech |
| `node-pty@^1.1.0` | The interactive terminal; without it, opening a terminal reports that `node-pty` is missing and everything else keeps working |

```bash
npm install @huggingface/transformers@^4.3.1 kokoro-js@^1.2.1
```

npm consumers should also add two overrides to the application's root
`package.json` (npm ignores overrides declared by dependencies). `kokoro-js`
1.2.1 still declares Transformers.js `^3.5.1`; without the override npm
installs a second, 3.x copy beside the service's 4.x one, and the service
hands Kokoro tensors built from its own copy. `adm-zip` 0.6.1 is the first
release that clears its advisory:

```json
{
  "overrides": {
    "adm-zip": "0.6.1",
    "kokoro-js": { "@huggingface/transformers": "^4.3.1" }
  }
}
```

The desktop installers and the relocatable Node distribution already include
this ML runtime with the reviewed overrides. Both paths use one Transformers
4.x / ONNX Runtime line rather than installing independent 3.x and 4.x stacks.

## Native engines

On-device inference needs native engine binaries. They are not bundled — the
service downloads them on first use from the `native-v*` releases in the
[Gezel repository](https://github.com/bendyline/gezel/releases/), verifying the
release's `SHA256SUMS` against a digest built into this package before
trusting any individual archive hash. Set `GEZEL_LLAMA_SERVER_BIN` (and
siblings) to point at your own builds instead, or `GEZEL_NATIVE_BIN_DIR` at a
directory containing all of them.

Cloud providers need none of this.

## Shared speech models

Speech-to-text (Whisper) and text-to-speech (Kokoro) weights come from a pinned
catalog in `@bendyline/gezel/speech-models`, a Node-only module of the
`@bendyline/gezel` package that other desktop apps can use too. Every file is
pinned by revision, size, and SHA-256 and verified before use.

- Verified files are kept once per user, in
  `<GEZEL_HOME>/engines/speech-assets/<sha256>`. Each app keeps its own
  installation that hard links to those files (or copies them, without another
  download, when they are on a different volume), so two apps never download
  the same model twice, and removing one app's installation never breaks
  another's.
- Downloads and cleanup coordinate across processes; a cached file is deleted
  only when no installation still uses it.
- Lookup also finds models already present in Gezel's older model folders, in
  read-only model homes (`GEZEL_READONLY_MODEL_HOMES`), and in the desktop
  app's machine-wide assets folder. It never reads the machine service's
  private state.
- Nothing downloads on its own: a health check never fetches a model, and an
  older Kokoro export updates only when you pull the model again.
- An app that must keep its files to itself can give `SpeechAssetStore` a
  `root` of `null`, which turns sharing off.

## Environment

| Variable | Effect |
|---|---|
| `GEZEL_HOME` | State directory (default `~/.gezel`) |
| `GEZEL_PORT` | Listen on this port. Default: 6228 when it is free, otherwise a free port |
| `GEZEL_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `GEZEL_MOCK_PROVIDER=1` | Deterministic provider, no credentials needed |
| `GEZEL_SKIP_SYSTEM_BOOTSTRAP=1` | Skip first-boot background downloads |
| `GEZEL_DISABLE_FIRST_USE_GRACE=1` | Treat a fresh home as an established install: background indexing starts at once instead of waiting out the first half hour and a ready chat model, and quiet nights are reported from day one. Useful for tests and automated runs |
| `GEZEL_EMBEDDED_INFERENCE_ONLY=1` | Start `gezeld` as the inference-only host an app runs for its own model calls: `@bendyline/gezel-inference`'s surface (chat, Responses, embeddings, knowledge, model management) behind the service's loopback listener, with no product API, secret store, device identity, remote pairing or LAN serving. The app SDK sets it for an `inferenceOnly` child-hosted service |
| `GEZEL_DAEMON_LOG_FILE=1` | Also write the service's output to `<home>/logs/service-YYYY-MM-DD.log` (10 MB rolls, 7 days kept). The CLI and app SDK set it when they start `gezeld` in the background |
| `GEZEL_NATIVE_ENGINE_VERSION` | Override the pinned native release |

## Stability

Public API under semver. The HTTP API is versioned separately under `/api`;
prefer `@bendyline/gezel-client` over calling it directly.

## Documentation

- [Repository and full documentation](https://github.com/bendyline/gezel)
- [Notices and third-party licenses](https://github.com/bendyline/gezel/blob/main/NOTICE.md)
  (also shipped in this package as `dist/NOTICE.md`)

MIT © Bendyline
