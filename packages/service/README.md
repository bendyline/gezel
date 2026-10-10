# @bendyline/gezel-service

`gezeld` — the [gezel](https://github.com/bendyline/gezel) daemon. A local HTTP
service that owns chat sessions, routes to LLM providers, manages memories,
tasks and projects, and reads and writes everything under `~/.gezel/`.

This is what `@bendyline/gezel-cli` runs behind the scenes. Install it directly
only if you are embedding gezel or running the daemon standalone.

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
| `@bendyline/gezel-service/handboek` | Handbook rendering helpers |
| `@bendyline/gezel-service/dist/bin/gezeld.js` | The daemon binary. Resolved by string from `@bendyline/gezel-client`'s `discoverOrSpawn()` — this export must never be removed |

```ts
import { startService } from '@bendyline/gezel-service';

const { port, clientToken, stop } = await startService({ home: '/tmp/gezel-home' });
console.log({ port, clientToken });
await stop();
```

## Optional local ML runtime

The base npm install intentionally omits Transformers.js and Kokoro. Cloud
providers, native engines, the HTTP API, terminal, MCP, UI, tasks, and file
features work without them. Install the optional peers only when this npm
deployment needs in-process memory embeddings or Kokoro text-to-speech:

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
daemon downloads them on first use from this repository's `native-v*` GitHub
releases, verifying the release's `SHA256SUMS` against a digest baked into this
package before trusting any individual archive hash. Set
`GEZEL_LLAMA_SERVER_BIN` (and siblings) to point at your own builds instead, or
`GEZEL_NATIVE_BIN_DIR` at a directory containing all of them.

Cloud providers need none of this.

## Environment

| Variable | Effect |
|---|---|
| `GEZEL_HOME` | State directory (default `~/.gezel`) |
| `GEZEL_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` \| `silent` |
| `GEZEL_MOCK_PROVIDER=1` | Deterministic provider, no credentials needed |
| `GEZEL_SKIP_SYSTEM_BOOTSTRAP=1` | Skip first-boot background downloads |
| `GEZEL_EMBEDDED_INFERENCE_ONLY=1` | Start `gezeld` in the embedded inference profile an app hosts for its own model calls: inference and model management only, no secret store, no device identity, no remote pairing or LAN serving. The app SDK sets it for an `inferenceOnly` child-hosted daemon |
| `GEZEL_DAEMON_LOG_FILE=1` | Also write the daemon's output to `<home>/logs/service-YYYY-MM-DD.log` (10 MB rolls, 7 days kept). The CLI and app SDK set it when they start `gezeld` in the background |
| `GEZEL_NATIVE_ENGINE_VERSION` | Override the pinned native release |

## Stability

Public API under semver. The HTTP API is versioned separately under `/api`;
prefer `@bendyline/gezel-client` over calling it directly.

MIT © Bendyline

## Shared speech models

Desktop speech weights use the Node-only `@bendyline/gezel/speech-models` API,
shared with DocBlocks. The catalog pins Whisper GGML models, the timestamped
Kokoro q8 ONNX export, and the eight curated English voices by revision, size,
and SHA-256. The normal q8 provider loads a complete local model directory;
its tiny tokenizer metadata ships with the API so adopting DocBlocks' model
needs no network. Other explicitly configured quantizations retain their
existing loader. Older standard Kokoro exports require an explicit model pull
to update; a health check never downloads the new export.

The per-user cache is `<GEZEL_HOME>/engines/speech-assets/<sha256>`. Each app
keeps its own installation manifest and hard links to those verified bytes.
A different filesystem falls back to copying verified bytes without another
download. Downloads and cache collection coordinate through process locks;
removing one installation releases only its links, and cache bytes are removed
when no installation references them. Discovery reads legacy Gezel model
folders, configured read-only model homes, and the public machine assets
overlay. It never probes the machine service's private state. Machine-scope
writes use `<GEZEL_SHARED_ASSETS_DIR>/models/speech-assets`.

Existing local Whisper files join the cache when used. The first app to pull
a model publishes the cache for the other app; use acquires independent file
references before launching an engine. The speech runtime remains local to
each application: reuse starts no daemon or consent flow. Sandboxed embedders
can disable shared storage entirely. Release the core package containing the
`./speech-models` export before updating a consumer's registry pin.
