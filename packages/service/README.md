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
npm install @huggingface/transformers@^3.8.1 kokoro-js@^1.2.1
```

Until their upstream dependency ranges move to the fixed releases, npm
consumers should also pin the secure transitive versions in the application's
root `package.json` (npm ignores overrides declared by dependencies):

```json
{
  "overrides": {
    "adm-zip": "0.6.0",
    "sharp": "0.35.3"
  }
}
```

The desktop installers and the relocatable Node distribution already include
this ML runtime with the reviewed overrides. Both paths use one Transformers
3.x / ONNX Runtime line rather than installing independent 3.x and 4.x stacks.

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
| `GEZEL_NATIVE_ENGINE_VERSION` | Override the pinned native release |

## Stability

Public API under semver. The HTTP API is versioned separately under `/api`;
prefer `@bendyline/gezel-client` over calling it directly.

MIT © Bendyline
