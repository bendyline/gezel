# Models from outside the catalog

A person can add a chat model the Gilde catalog does not curate, from three
places:

- **A Hugging Face GGUF repo** (llama.cpp, every platform).
- **A Hugging Face MLX build** (Apple silicon Macs).
- **GGUF files already on this computer.**

They choose **Add a model…** on an engine page in Settings, then **From
Hugging Face or a file…** under the catalog (**From Hugging Face…** on the MLX
page), or press **Use this model → Gezel** on a model page on huggingface.co,
which sends
`gezel://model/huggingface/<owner>/<name>` (see [deep-links.md](deep-links.md)).

Every catalog model was tried by a person before it shipped, so Gezel checks an
added one twice: before anything is added, from the files' headers or configs
and the Hub's metadata, and after, by running it.

## The flow

The routes live at `/api/model-imports`
([routes/model-imports.ts](../packages/service/src/http/routes/model-imports.ts)),
proxied in packaged installs to the machine broker's
`/v1/remote/manage/model-imports`, so the daemon that owns the model store
answers.

**From Hugging Face**
([models/imports/importer.ts](../packages/inference/src/models/imports/importer.ts)):

1. **Review** (`POST /review`, nothing written). The importer reads the repo's
   metadata and its file list at one commit.
   - A GGUF repo is grouped into choices: one per quant, a split model's shards
     together, a vision projector set aside. The pick is the explicit file or
     `:QUANT` when one is given, else the most preferred quant that fits this
     machine. That file's header is read with a ranged request (4 MB, growing
     to at most 64 MB).
   - An MLX repo is grouped into builds: directories holding `config.json` and
     safetensors. Only data files are selected (weights, configs, tokenizer
     files, templates). Configs and every small file without an LFS checksum
     are fetched in full and hashed.
2. **Confirm** (`POST /confirm`). The review is re-derived from the pinned
   commit and file (or build) and refused unless every check passes. The
   engine's model manager (`prepareImportedModel`) then writes the catalog
   entry into the model's folder.
3. **Install** (`POST /api/llama-cpp|mlx/models/:id/install`, unchanged). The
   ordinary installer downloads each file from `/resolve/<commit>/` and checks
   it against the recorded SHA-256. Resume, cancel, disk preflight and the
   Settings progress list work as they do for a catalog model.

**From this computer**
([models/imports/local-files.ts](../packages/inference/src/models/imports/local-files.ts)):

1. `POST /local` starts an import. Each file then streams in with
   `PUT /local/:id/files/:name`, and `GET /local/:id` reports bytes received.
   The daemon never opens a path it is handed: in a machine install it runs as
   a service account that cannot read the person's files, and a path is not
   consent. Bytes are hashed as they arrive and staged privately under
   `.transactions/local-model-imports/<id>/`, which expires after a day.
2. `POST /local/:id/review` checks what arrived. It must be one model: its
   shards and, optionally, a vision projector.
3. `POST /local/:id/confirm` publishes the staged folder as the model, through
   the same path `.gezmodel` imports use. The checksums recorded on the way in
   are reused, so nothing is hashed twice and nothing downloads.

Either way, the install hook then runs the
[fitness probe](../packages/service/src/fitness/). Routing skips a model that
fails it, and the person can still choose the model by hand.

## Checks before adding

Pure functions in [core model-import/checks.ts](../packages/core/src/model-import/checks.ts).
Any `fail` blocks the model.

| Check | Fails when | Warns when |
| --- | --- | --- |
| Download access (Hub only) | disabled, private, or gated without an HF token | gated with a token |
| This computer (MLX) | not an Apple silicon Mac | |
| Checksums | a Hub file has no SHA-256 (local files are always hashed on arrival) | |
| Readable file / model | the GGUF header or MLX config does not parse | |
| Chat model (GGUF) | a LoRA adapter, a vision projector, an embedding model, or no tokenizer | |
| No code inside (MLX) | a config names code to run (`auto_map`, `model_file`) | |
| Engine support | the design is not in the pinned engine's list | |
| Number formats (GGUF) | a tensor type llama.cpp removed, or one newer than the pin | the backend runs it badly (NVFP4 on Metal) |
| Conversation format | no chat template | |
| Tool use | | the template never renders tools |
| Working memory | | context under 16K tokens, or unknown |
| Fits this computer | too big for the capacity broker's budget | `tight` |
| Disk space | not enough free space | |

The engine tables come from the pinned upstream source.
`node scripts/sync-engine-model-support.mjs` regenerates both:

- [llama-cpp-gguf-support.ts](../packages/core/src/native/llama-cpp-gguf-support.ts),
  from llama.cpp's `LLM_ARCH_NAMES` and `enum ggml_type`;
- [mlx-model-support.ts](../packages/core/src/native/mlx-model-support.ts),
  from mlx-vlm's model packages and `MODEL_REMAPPING`. Gezel's MLX sidecar
  loads every model through mlx-vlm.

`engine-model-support.test.ts` fails when either table no longer matches its
pin (`native/engines/llama-cpp/VERSION`, `MLX_DEFAULT_PACKAGE_SPEC`).

**Why MLX checks for code.** mlx-vlm executes a `model_file` named in
`config.json`, and Transformers fetches and runs the code an `auto_map`
points at. Neither matters for curated models, but either would run an
uploader's program for anyone who added an arbitrary repo. A build that asks
for code is refused. `.py` files are never selected, and the sanitizer rejects
an MLX entry naming any file outside the data-file list.

When a curated catalog entry pins the same bytes (the first file's SHA-256),
the review names it. For a Hugging Face link, the dialog offers that entry
first. For a local file, the file simply takes that entry's settings.

## Checks after adding

The fitness probe's five axes (spawn, tool round trip, throughput, reasoning
budget, context fit) plus **coherence**, which matters most here. The short
reply must not be empty, must not leak conversation markers (`<|im_end|>`,
`[INST]`, `<start_of_turn>`), and must not loop. A GGUF whose conversation
format does not match its training passes every other axis and fails this one.

## Settings

An added model's settings come from the first of these that applies, and the
review says which:

1. **A curated entry for the same base model** (`tuning.from: 'catalog'`).
   The base model comes from the Hub's `cardData.base_model` and the GGUF's
   `general.base_model.N.repo_url`. It is matched against each curated entry's
   `upstream`, at a matching size (`findTuningDonor`). The catalog tunes per
   model, not per quant, so any upload of that model shares the settings. The
   entry stores only the donor's id (`tuningFrom`). The catalog lends the
   donor's style, behaviors and tuning live, so a catalog update that retunes
   the donor retunes the import (`applyTuningDonor`). The donor's engine launch
   settings never transfer: they describe its own files (its drafter, its
   cache types).
2. **The author's recommended sampling** (`'author'`). This is the repo's own
   `generation_config.json` (MLX builds carry one), else the base model's.
   Only plain numbers in sane ranges survive (`samplingFromGenerationConfig`),
   and they are recorded in the entry.
3. **The defaults** (`'defaults'`): the runtime's tier defaults for the model's
   size. A thinking budget is added when the template has a thinking channel.

## How an added model becomes a catalog model

Added models need no second code path. The importer builds an ordinary
chat-model manifest
([core model-import/manifest.ts](../packages/core/src/model-import/manifest.ts)):

- **Id.** `hf-<name>-<quant>-<hash>` from Hugging Face, `local-<file>-<hash>`
  from this computer.
- **Tag.** `from-hugging-face` or `from-local-file`.
- **Size and capabilities.** `parameterSize`, `supportsTools`, `contextWindow`
  and the KV geometry come from the header or config.
- **Source.** A `llamaCpp` or `mlx` source pinning the commit and every
  SHA-256. A local file's source names the files and the checksums recorded on
  arrival, under the sentinel repo `local-file/gguf`. The installer refuses to
  "download" such an entry, and it is never offered for resume or update.

The entry is written as `.gezel-catalog-entry.json` (`{ manifest, tuningFrom? }`)
in the model's folder. It is a dot-file, so payload hashing, pruning,
`.gezmodel` export and read-only verification skip it.

The catalog serves it through `ImportedChatModelsSource`. That is the
lowest-priority tier, which every `CatalogService` built with
`importedChatModels` gets (the product and engine daemons). The tier
classifier, launch planner, fit badges and model pickers therefore treat it
like any catalog model. Deleting the model deletes the entry with it. A
`.gezmodel` bundle carries the manifest, and importing it on another machine
restores the entry.

The entry is re-validated on every read (`parseImportedChatModelEntry`).
Only the fields an import writes survive. Engine flags, behaviors, styles,
prompts and foreign sources never pass through, whatever the file says.

## Security

- A `gezel://model/...` link and a pasted reference only open the review.
  Strict grammars (`parseHuggingFaceReference`, `isSafeGgufRepoPath`) refuse
  traversal, other hosts, datasets and Spaces.
- Downloads are pinned to a 40-character commit and verified by SHA-256.
- Header and config strings are the uploader's. They are shown as text,
  matched against fixed tables, and never used in a path, command or prompt.
- No downloaded model may run code (see "Why MLX checks for code").
- Local files arrive as bytes, under plain `.gguf` names, at most 32 per
  import, and are staged privately until the person confirms.
- The import routes sit under `/api/model-imports`, which session tokens
  cannot reach.

## Listing on Hugging Face

Hugging Face builds its "Use this model" menu from `LOCAL_APPS` in
`packages/tasks/src/local-apps.ts` of
[huggingface.js](https://github.com/huggingface/huggingface.js).

- **The PR.** Gezel's entry is a PR there, plus a test in `local-apps.spec.ts`.
  Atomic Chat's PR #2076 is the model to follow.
- **After the merge.** Hugging Face staff must also enable the app on the Hub's
  settings page.
- **Nothing in Gezel.** The entry needs no Gezel code, library or telemetry.

```ts
gezel: {
  prettyLabel: "Gezel",
  docsUrl: "https://gezel.com",
  mainTask: "text-generation",
  displayOnModelPage: (model) =>
    (isLlamaCppGgufModel(model) || isMlxModel(model)) && model.tags.includes("conversational"),
  deeplink: (model, filepath) => {
    const url = new URL(`gezel://model/huggingface/${model.id}`);
    // A file only for GGUF; an MLX repo is reviewed as a whole.
    if (filepath?.toLowerCase().endsWith(".gguf")) url.searchParams.set("file", filepath);
    return url;
  },
},
```

`conversational` is the Hub's tag for a repo with a chat template. Gezel
refuses a model without one, so the button stays off base models. The `file`
parameter only ever names a GGUF. For an MLX repo the review picks the build.
