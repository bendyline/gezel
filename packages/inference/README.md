# @bendyline/gezel-inference

The on-device inference runtime shared by [Gezel](https://github.com/bendyline/gezel)
and by applications that embed it. It runs local AI models on the user's own
computer and answers them through OpenAI-compatible routes:

- **Native engines** — starting, sizing, and stopping llama.cpp, MLX, and the
  other on-device engines, with admission control so models fit in memory.
- **Model management** — listing, downloading, verifying, and preparing local
  chat models.
- **Embeddings and knowledge** — the on-device text embedder
  (`model: "gezel:embeddings"`) and search over installed knowledge catalogs,
  each in its own worker.
- **OpenAI-compatible routes** — `/v1/chat`, `/v1/responses`,
  `/v1/embeddings`, `/v1/models`, `/v1/models/ensure`, `/v1/knowledge`, and
  the engine routes.

It holds no product state: no gezels, projects, chats, tools, cloud providers,
or UI. Those belong to the full Gezel service, `@bendyline/gezel-service`,
which uses this same runtime.

## Install

```bash
npm install @bendyline/gezel-app-sdk @bendyline/gezel-inference
```

Node 24 or newer. On-device text embeddings and the optional relevance model
also need the `@huggingface/transformers` peer:

```bash
npm install @huggingface/transformers@^4.3.1
```

## Use it through the app SDK

Most applications should not import this package directly. Install it beside
[`@bendyline/gezel-app-sdk`](https://www.npmjs.com/package/@bendyline/gezel-app-sdk)
and ask the SDK for an inference-only host. The SDK loads this runtime inside
your process, so there is no second process to supervise, no separate Node
executable to ship, and no loopback network connection:

```ts
import { connectOrHost } from '@bendyline/gezel-app-sdk/host';

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

The runtime never downloads a model on its own: weights are fetched only when
your app asks for them, for example with `ensureModel`. See the
[app SDK README](https://www.npmjs.com/package/@bendyline/gezel-app-sdk) for
consent, hosting options, shipping engines and models with your app, and
knowledge catalogs.

## Entry points

| Import | What it provides |
|---|---|
| `@bendyline/gezel-inference` | `startService()`, the in-process host the app SDK calls, and `verifyNativeBinaries()` |
| `@bendyline/gezel-inference/native-release` | The pinned native engine release and its archive digests, as data. Importing it starts nothing |
| `@bendyline/gezel-inference/packaging` | Build-time helpers that stage the pinned native engines for an Electron app |
| `@bendyline/gezel-inference/speech` | The Kokoro text-to-speech frontend and its pronunciation-dictionary lookup |

The package also includes chat-model and knowledge-catalog metadata generated
from the pinned [`@bendyline/gilde`](https://www.npmjs.com/package/@bendyline/gilde)
catalog. The pronunciation dictionaries' license is at
`dist/kokoro-lexicon/LICENSE`.

## Stability

The entry points above are public API under semver.
`@bendyline/gezel-inference/internal/*` is not: it is how the Gezel service
reaches the runtime, always installed at exactly the same version, and it can
change in any release. Do not import it.

## Documentation

- [Repository and full documentation](https://github.com/bendyline/gezel)
- [Embedding guide](https://github.com/bendyline/gezel/blob/main/docs/embedding-sdk.md)

MIT © Bendyline
