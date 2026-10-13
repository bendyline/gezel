# @bendyline/gezel-inference

The shared on-device runtime used by Gezel's full service and by embedded applications. It owns native engine lifecycle and capacity admission, model preparation, OpenAI-compatible chat, knowledge retrieval, worker entry points, and native release verification. The full service supplies product state, tools, cloud providers, UI and background work. There is one implementation of the shared runtime.

Use the application SDK with `host: { mode: 'in-process', inferenceOnly: true }`. Install this package alongside `@bendyline/gezel-app-sdk`. Startup opens no HTTP listener and returns an authenticated Fetch transport serving `/v1/chat`, `/v1/responses`, `/v1/embeddings`, `/v1/models`, `/v1/models/ensure`, `/v1/knowledge` and the engine routes; `model: "gezel:embeddings"` runs the on-device text embedder. It does not download models. Model preparation requires an explicit request. This is the only implementation of the inference-only profile: a child-hosted `gezeld` serves the same host behind the service's loopback listener.

- `/packaging` stages the pinned native release for an Electron host.
- `/native-release` exposes the release pins without starting inference.
- `/speech` exposes the shared Kokoro frontend and dictionary resolver.
- `/internal/*` is the coordinated workspace interface for Gezel's full service; external applications should use the SDK.

The build copies only chat-model and knowledge-catalog metadata from the exact Gilde pin owned by the catalog package. This is generated content, never a separately edited catalog. `@bendyline/gezel-catalog` loads it through its ordinary source API. The full service separately installs all of Gilde.

Build with `pnpm --filter @bendyline/gezel-inference build` under the repository dependency lease. Unit and integration coverage for the moved runtime remains in the service suite; this package additionally tests the isolated host boundary.
