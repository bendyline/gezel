# Notices and attributions

Gezel itself is released under the [MIT License](./LICENSE). This file lists
the third-party open source software bundled into, or distributed alongside,
Gezel — along with each component's upstream license and homepage. Release
builds collect the corresponding license and notice texts into the installed
application's `resources/licenses/` directory; the generated manifest maps
each production package to the exact text shipped for it.

---

## Runtime dependencies

These ship in the Electron app or the `gezeld` daemon. Two further components
— the GitHub Copilot CLI and the Playwright MCP server — are deliberately
*not* among them; Gezel downloads them on first run instead. See
**Downloaded on first run** below.

| Package | License | Homepage |
|---|---|---|
| [@hono/node-server](https://github.com/honojs/node-server) | MIT | honojs/node-server |
| [@modelcontextprotocol/sdk](https://modelcontextprotocol.io) | MIT | modelcontextprotocol.io |
| [@napi-rs/keyring](https://github.com/napi-rs/node-keyring) | MIT | napi-rs/node-keyring |
| [@prismatic-io/spectral](https://github.com/prismatic-io/spectral) | MIT | prismatic-io/spectral |
| [@radix-ui/react-alert-dialog](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-dialog](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-dropdown-menu](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-popover](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-select](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-tabs](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@radix-ui/react-tooltip](https://radix-ui.com/primitives) | MIT | radix-ui.com |
| [@huggingface/transformers](https://github.com/huggingface/transformers.js) | Apache-2.0 | huggingface/transformers.js |
| [@pdf-lib/upng](https://github.com/Hopding/upng) | MIT | Hopding/upng |
| [commander](https://github.com/tj/commander.js) | MIT | tj/commander.js |
| [hono](https://hono.dev) | MIT | hono.dev |
| [jpeg-js](https://github.com/jpeg-js/jpeg-js) | BSD-3-Clause | jpeg-js/jpeg-js |
| [kokoro-js](https://github.com/hexgrad/kokoro) | Apache-2.0 | hexgrad/kokoro |
| [monaco-editor](https://github.com/microsoft/monaco-editor) | MIT | microsoft/monaco-editor |
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) | MIT | microsoft/onnxruntime |
| [openai](https://github.com/openai/openai-node) | Apache-2.0 | openai/openai-node |
| [pino](https://getpino.io) | MIT | getpino.io |
| [react](https://react.dev) | MIT | react.dev |
| [react-dom](https://react.dev) | MIT | react.dev |
| [vectra](https://github.com/Stevenic/vectra) | MIT | Stevenic/vectra |
| [yaml](https://github.com/eemeli/yaml) | ISC | eemeli/yaml |
| [zod](https://zod.dev) | MIT | zod.dev |

## Bundled application runtimes

These executables are part of the desktop distribution rather than ordinary
production dependencies. Their redistribution texts are copied into the
installed `resources/licenses/runtimes/` directory. Electron's Chromium
attribution file is taken from the exact Electron distribution being packaged.

| Component | Pinned version | License | Source |
|---|---|---|---|
| **Electron** | `43.2.0` | MIT, with bundled Chromium notices | [electron/electron](https://github.com/electron/electron) |
| **Node.js** | `24.18.1` | MIT, with bundled third-party notices | [nodejs/node](https://github.com/nodejs/node) |
| **pnpm** | `11.15.1` | MIT | [pnpm/pnpm](https://github.com/pnpm/pnpm) |

### pnpm embedded dependency graph

The ordinary pnpm package carries its own private `dist/node_modules/` graph;
those packages are executable runtime content, not dependencies from Gezel's
workspace lockfile. The table below is derived from the exact pnpm tarball
bound by `PNPM_PACKAGE_SHA256`. Packaging verifies the original graph, removes
foreign-platform packages, and removes pnpm's optional `@reflink` package scope
after routing its three clone call sites to Node's built-in
`COPYFILE_FICLONE_FORCE` with pnpm's existing ordinary-copy fallback. The
staged graph is then verified again. Packages that cannot occur in a currently
published installer are intentionally omitted.

| Package | Version | License | Installer targets |
|---|---|---|---|
| `@isaacs/fs-minipass` | `4.0.1` | ISC | all released targets |
| `abbrev` | `4.0.0` | ISC | all released targets |
| `chownr` | `3.0.0` | BlueOak-1.0.0 | all released targets |
| `env-paths` | `2.2.1` | MIT | all released targets |
| `exponential-backoff` | `3.1.3` | Apache-2.0 | all released targets |
| `fdir` | `6.5.0` | MIT | all released targets |
| `graceful-fs` | `4.2.11` | ISC | all released targets |
| `isexe` | `4.0.0` | BlueOak-1.0.0 | all released targets |
| `minipass` | `7.1.3` | BlueOak-1.0.0 | all released targets |
| `minizlib` | `3.1.0` | MIT | all released targets |
| `node-gyp` | `12.4.0` | MIT | all released targets |
| `nopt` | `9.0.0` | ISC | all released targets |
| `picomatch` | `4.0.5` | MIT | all released targets |
| `proc-log` | `6.1.0` | ISC | all released targets |
| `semver` | `7.8.5` | ISC | all released targets |
| `tar` | `7.5.20` | BlueOak-1.0.0 | all released targets |
| `tinyglobby` | `0.2.17` | MIT | all released targets |
| `undici` | `6.27.0` | MIT | all released targets |
| `v8-compile-cache` | `2.4.0` | MIT | all released targets |
| `which` | `6.0.1` | ISC | all released targets |
| `yallist` | `5.0.0` | BlueOak-1.0.0 | all released targets |

---

## Sibling packages (same author)

These are developed in the neighbouring [Squisq](https://github.com/bendyline/squisq)
repository and linked into the workspace. Their license matches Squisq's
(MIT). Consuming packages pin every Squisq dependency exactly.

- `@bendyline/squisq` — MIT
- `@bendyline/squisq-cli` — MIT
- `@bendyline/squisq-react` — MIT
- `@bendyline/squisq-editor-react` — MIT
- `@bendyline/squisq-formats` — MIT
- `@bendyline/squisq-video` — MIT
- `@bendyline/squisq-video-react` — MIT (Gezel's editor consumes only its
  cover-image entry; the browser encoder and FFmpeg runtime are not shipped)

---

## Icon fonts carried inside dependencies

Two icon sets ship inside the packaged UI without being direct dependencies of
this workspace: the bundler emits them from packages listed above. They are
called out separately because their **icon artwork is CC BY 4.0**, which
requires attribution, even though the surrounding package is MIT. They are not
in `packages/ui/src/assets/fonts/`; `pnpm check:notice` inventories them from
the built `packages/service/dist/ui/assets/` tree where they actually ship.

| Asset | License | Arrives via | Source |
|---|---|---|---|
| **Font Awesome Free 7.2.0** (`fa-solid-900`, `fa-regular-400`, `fa-brands-400` WOFF2) | Icons [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); fonts SIL OFL 1.1; code MIT — upstream expression `(CC-BY-4.0 AND OFL-1.1 AND MIT)` | `@bendyline/squisq-editor-react`, whose stylesheet bundles `@fortawesome/fontawesome-free` | [FortAwesome/Font-Awesome](https://github.com/FortAwesome/Font-Awesome) |
| **Visual Studio Code icons** (`codicon.ttf`) | Icons [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); the carrying package is MIT | `monaco-editor`, which embeds the codicon font in its distribution | [microsoft/vscode-codicons](https://github.com/microsoft/vscode-codicons) |

Attribution notice, as CC BY 4.0 requires: Font Awesome Free is by
[Fonticons, Inc.](https://fontawesome.com/); the Visual Studio Code icons are
by [Microsoft Corporation](https://github.com/microsoft/vscode-codicons).
Both are used unmodified.

---

## Reviewed unmodified component redistributions

Gezel's release policy approves the following exact package versions for
redistribution as unmodified upstream components inside the larger Gezel app.
The exception is package-, version-, and license-scoped: upgrades or license
changes fail the production license gate until reviewed again. Redistribution
does not alter the upstream license terms, and packaged artifacts must retain
the applicable upstream license and notice material.

- `@resvg/resvg-js@2.6.2` and its platform binaries — MPL-2.0.

`pnpm audit:licenses` encodes these as narrow reviewed exceptions. It remains
red for any different package, version, or reported license expression.

---

## Vendored connector components (Prismatic)

Gezel's `spectral` connector driver runs Apache-2.0
[Prismatic](https://prismatic.io/) integration components off-platform to mirror
external data sources into a project. Two upstreams are involved:

- **[@prismatic-io/spectral](https://github.com/prismatic-io/spectral)** (MIT) —
  the component SDK, pinned at `10.23.0` and bundled with the
  `@bendyline/gezel-connectors-spectral` package (also in the runtime table
  above). It is the host runtime a vendored component's action executes against.
- **[prismatic-io/components](https://github.com/prismatic-io/components)**
  (Apache-2.0) — the individual connector components. Rather than depend on the
  whole library, we **vendor the minimal read slice** of each component we ship,
  as readable source under
  [`packages/connectors-spectral/vendor/<component>/`](packages/connectors-spectral/vendor/).
  Every vendored file carries an in-source provenance header (the Apache-2.0
  §4 attribution; upstream ships no `NOTICE` file to propagate), and the set is
  recorded in
  [`vendor/provenance.json`](packages/connectors-spectral/vendor/provenance.json)
  with a pinned content hash — gated by `pnpm --filter
  @bendyline/gezel-connectors-spectral verify:vendor`. The build-time auth
  harvest
  ([`packages/catalog/scripts/import-prismatic-auth.mts`](packages/catalog/scripts/import-prismatic-auth.mts))
  likewise derives connector authentication config from this same Apache-2.0
  source.

  The standalone npm package distributes its own `NOTICE.md`, the full
  Apache-2.0 text under `THIRD_PARTY_LICENSES/`, and the machine-readable
  `vendor/provenance.json` ledger. Both compiled entry points carry a prominent
  banner identifying the modified Apache-derived portions. The npm legal-payload
  gate packs the package and rejects a release if any of those files or banners
  is missing.

Component read-slices vendored so far:

| Component | Upstream | License |
|---|---|---|
| **Airtable** (`listRecords`) | [@prismatic-io/airtable](https://github.com/prismatic-io/components/tree/main/components/airtable) | Apache-2.0 |

---

## Native engines and bundled binaries

Gezel builds (or downloads) several native, non-npm tools and stages the
release artifacts under `packages/app/native-bin/` for each platform. Upstream
pins live in `native/engines/<name>/VERSION`; distributable license copies and
their pin-bound manifest live in [`native/licenses/`](native/licenses/).

| Component | Pinned version | License | Source |
|---|---|---|---|
| **llama.cpp** (`llama-server`, `libllama*`) | tag `b10353` | MIT | [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) |
| **ggml** (`libggml*` — Metal/BLAS/CPU/RPC backends) | bundled with llama.cpp/whisper.cpp | MIT | [ggml-org/ggml](https://github.com/ggml-org/ggml) |
| **ds4 / DwarfStar** (`ds4-server` + `metal/*.metal` shaders) | commit `84cc8823` (`main-2026-08-09`) | MIT | [antirez/ds4](https://github.com/antirez/ds4) |
| **stable-diffusion.cpp** (`sd-server`) | tag `master-789-5114672` | MIT | [leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp) |
| **whisper.cpp** (`whisper-server`) | tag `v1.9.1` | MIT | [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp) |
| **uv** (precompiled binary, not built from source) | tag `0.11.32` | Apache-2.0 OR MIT | [astral-sh/uv](https://github.com/astral-sh/uv) |
| **Vulkan loader** (`libvulkan.so.1`, bundled beside stable-diffusion.cpp on `linux-x64`) | build-platform version | Apache-2.0 | [KhronosGroup/Vulkan-Loader](https://github.com/KhronosGroup/Vulkan-Loader) |

The `ggml` compute library is vendored as a submodule of both
llama.cpp and whisper.cpp and is compiled into the shared libraries
that ship beside those servers; its MIT license travels with those
binaries. `uv` is used only to bootstrap the managed Python venv for
the MLX provider — the MLX framework and `mlx-vlm` are installed into
that venv at runtime (Apache-2.0/MIT) and are not bundled.

The **ds4** engine (antirez's DeepSeek-V4 inference engine) is MIT-licensed:
its `LICENSE` carries the dual copyright *"The ds4.c authors"* and *"The ggml
authors"* — its Metal kernels derive from ggml, the same MIT as llama.cpp
above. The `ds4-server` binary statically incorporates antirez's **rax** radix
tree (BSD-3-Clause, © Salvatore Sanfilippo), and `metal/dsv4_rope.metal`
embeds a **YaRN** RoPE implementation (MIT, © 2023 Jeffrey Quesnelle and Bowen
Peng) — both permissive and attributed in-source. We ship only `ds4-server`
plus its `metal/` shader sources (compiled at runtime by the OS's own Metal
framework, which is not redistributed); ds4's GGUF quantizer under
`gguf-tools/` and its BSD `linenoise` CLI dependency are **not** linked into
`ds4-server` and are not bundled. On Apple Silicon the ds4 bundle is therefore
fully permissive (MIT + BSD-3). The Linux **CUDA** build additionally bundles
NVIDIA's `libcudart`/`libcublas` runtime libraries — see the proprietary-
components note below (the same NVIDIA redistributables llama.cpp's CUDA
variant ships).

The DeepSeek-V4 model **weights** ds4 runs are not bundled — they are
downloaded on demand from Hugging Face (`antirez/deepseek-v4-gguf`, MIT) and
carry their own license; see **Catalog models** below.

---

## Runtime-downloaded models

Some features download model weights from Hugging Face on first use and
cache them outside the app bundle (in the OS cache or `~/.gezel`). These
weights are third-party and carry their own licenses.

| Model | Used for | License | Source |
|---|---|---|---|
| **whisper** `tiny.en` / `base.en` / `small.en` (GGML) | speech-to-text (whisper.cpp provider) | MIT | [ggerganov/whisper.cpp](https://huggingface.co/ggerganov/whisper.cpp) |
| **Kokoro-82M** (ONNX) | text-to-speech (kokoro-js provider) | Apache-2.0 | [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) |
| **all-MiniLM-L6-v2** | semantic memory embeddings (`@huggingface/transformers`) | Apache-2.0 | [Xenova/all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2) |
| **bge-small-en-v1.5** | default text-search embeddings (`@huggingface/transformers`) | MIT | [Xenova/bge-small-en-v1.5](https://huggingface.co/Xenova/bge-small-en-v1.5) |
| **CLIP ViT-B/32** (ONNX, vision tower) | visual image similarity (`@huggingface/transformers`) | MIT (model card; OpenAI CLIP weights) | [Xenova/clip-vit-base-patch32](https://huggingface.co/Xenova/clip-vit-base-patch32) |
| **YuNet 2023mar** (ONNX) | face detection (face-recognition opt-in; sha256-pinned) | MIT | [opencv/opencv_zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) |
| **AuraFace-v1** (`glintr100.onnx`) | face embeddings (face-recognition opt-in; sha256-pinned) | Apache-2.0 | [fal/AuraFace-v1](https://huggingface.co/fal/AuraFace-v1) |

---

## Downloaded on first run

These third-party components are **not** bundled into any installer. Gezel
downloads them on first run, from the public npm registry into the user's own
Gezel home (`system-toolsets/`), using the bundled pnpm and a
version+integrity set pinned in
[`packages/service/src/system-toolsets/locks.ts`](packages/service/src/system-toolsets/locks.ts).

Gezel does **not** redistribute these packages — they are fetched from npm on
the user's own machine, and each is governed by its own license as published
by its author. The install is pinned rather than floating so every machine
resolves the exact versions reviewed at release time.

| Package | Used for | License |
|---|---|---|
| [@github/copilot-sdk](https://github.com/github/copilot-sdk) | GitHub Copilot chat provider | MIT |
| [@github/copilot](https://github.com/github/copilot-cli) and its `@github/copilot-{darwin,linux,linuxmusl,win32}-{arm64,x64}` binary siblings, pulled in transitively by the SDK | GitHub Copilot chat provider | **Proprietary** — GitHub Copilot CLI License |
| [@playwright/mcp](https://github.com/microsoft/playwright-mcp) | browser-automation MCP toolset | Apache-2.0 |

The Playwright component additionally downloads a **Chromium** build
(~281 MB) from Playwright's own CDN into `~/.gezel/playwright-browsers/`, via
`playwright install chromium`. That browser is not bundled either, and carries
Chromium's own BSD-3-Clause license plus the third-party notices shipped inside
it. It is a separate copy from the Chromium inside Electron listed under
**Bundled application runtimes** above.

Because none of the above is present in any installer, none of it appears in
the CycloneDX SBOM published with each release or in the `resources/licenses/`
bundle installed alongside the app — both inventory only what Gezel actually
redistributes.

---

## Catalog models

The model catalog (the external
[@bendyline/gilde](https://github.com/bendyline/gilde) content package,
bundled into the app) describes chat and image models that users can
download on demand. Gezel
does **not** redistribute these weights — they are fetched from their
upstream registries (Hugging Face, ollama.com) at install time — but the
catalog references them, so their publishers and licenses are listed
here. Each model's `manifest.json` carries an authoritative `license`,
`maintainer`, and `upstream` field; this section is a summary.

**Chat models** — publishers: Meta, Google, Alibaba (Qwen), Mistral AI,
DeepSeek, OpenAI (gpt-oss), NVIDIA (Nemotron), plus community quantizers
(e.g. antirez). Licenses in use:

- **Apache-2.0** — most Qwen, Gemma, Mistral 7B, gpt-oss
- **MIT** — DeepSeek family
- **MIT-Modified** — Mistral Medium (revenue carve-out)
- **Llama 3.2 Community License** — Meta Llama models
- **NVIDIA Open Model License** — NVIDIA Nemotron models

**Image models** — publishers: Stability AI, Black Forest Labs (FLUX),
Cagliostro Lab (Animagine), ByteDance. Licenses in use:

- **Apache-2.0** — FLUX.1 [schnell], FLUX.2 [klein]
- **CreativeML Open RAIL / RAIL++-M**, **OpenRAIL++** — Stable Diffusion
  1.5 / SDXL family, SDXL-Lightning
- **Stability AI Community / Non-Commercial Research License** — newer
  Stability AI checkpoints
- **FLUX.1 [dev] Non-Commercial License** — FLUX.1 [dev]
- **Fair AI Public License 1.0-SD** — Animagine XL

> **Note:** several catalog model licenses are non-OSI and carry
> commercial or acceptable-use restrictions (Llama Community,
> NVIDIA Open Model, FLUX.1 [dev] Non-Commercial, the various
> RAIL licenses). Review the per-model license before commercial use.

---

## Development dependencies

Used to build and test Gezel but not shipped to end users.

| Package | License | Homepage |
|---|---|---|
| [@biomejs/biome](https://biomejs.dev) | MIT OR Apache-2.0 | biomejs.dev |
| [@playwright/test](https://playwright.dev) | Apache-2.0 | playwright.dev |
| [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react) | MIT | vitejs/vite-plugin-react |
| [esbuild](https://esbuild.github.io/) | MIT | esbuild.github.io |
| [playwright](https://playwright.dev) | Apache-2.0 | playwright.dev |
| [tsup](https://tsup.egoist.dev/) | MIT | tsup.egoist.dev |
| [typescript](https://www.typescriptlang.org/) | Apache-2.0 | typescriptlang.org |
| [vite](https://vite.dev) | MIT | vite.dev |
| [vitest](https://vitest.dev) | MIT | vitest.dev |

---

## Bundled fonts and emoji

The UI ships the following WOFF2 assets under
[packages/ui/src/assets/fonts/](packages/ui/src/assets/fonts/). Each carries
its own license which travels with the file.

| Asset | License | Source |
|---|---|---|
| **Hanken Grotesk** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-hanken-grotesk.txt) | [Hanken Design](https://github.com/hanken-design/HankenGrotesk) |
| **PT Serif** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-pt-serif.txt) | [Google Fonts](https://fonts.google.com/specimen/PT+Serif) |
| **Playfair Display** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-playfair-display.txt) | [Google Fonts](https://fonts.google.com/specimen/Playfair+Display) |
| **Source Serif 4** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-source-serif-4.txt) | [Adobe Fonts](https://github.com/adobe-fonts/source-serif) |
| **Inter** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-inter.txt) | [Inter](https://github.com/rsms/inter) |
| **Oswald** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-oswald.txt) | [Google Fonts](https://fonts.google.com/specimen/Oswald) |
| **Roboto** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-roboto.txt) | [Google Fonts](https://fonts.google.com/specimen/Roboto) |
| **Merriweather** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-merriweather.txt) | [Google Fonts](https://fonts.google.com/specimen/Merriweather) |
| **Lora** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-lora.txt) | [Google Fonts](https://fonts.google.com/specimen/Lora) |
| **JetBrains Mono** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-jetbrains-mono.txt) | [JetBrains](https://github.com/JetBrains/JetBrainsMono) |
| **IBM Plex Sans** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-ibm-plex-sans.txt) | [IBM](https://github.com/IBM/plex) |
| **DM Serif Display** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-dm-serif-display.txt) | [Google Fonts](https://fonts.google.com/specimen/DM+Serif+Display) |
| **DM Sans** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-dm-sans.txt) | [Google Fonts](https://fonts.google.com/specimen/DM+Sans) |
| **Cormorant Garamond** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-cormorant-garamond.txt) | [Google Fonts](https://fonts.google.com/specimen/Cormorant+Garamond) |
| **Crimson Text** | [SIL Open Font License 1.1](packages/ui/src/assets/fonts/licenses/LICENSE-crimson-text.txt) | [Google Fonts](https://fonts.google.com/specimen/Crimson+Text) |
| **OpenMoji Color** | [CC BY-SA 4.0](packages/ui/src/assets/fonts/LICENSE-CC-BY-SA-4.0.txt) | [OpenMoji](https://openmoji.org/) |

OpenMoji attribution note: emojis rendered via this font are by the
[OpenMoji project](https://openmoji.org/) — the open-source emoji and icon
project, [Hochschule für Gestaltung Schwäbisch Gmünd](https://www.hfg-gmuend.de/).

---

## Proprietary and non-permissive components

Most of Gezel's own **code** dependencies (npm packages and native engines) are
permissively licensed (MIT / Apache-2.0 / BSD / ISC). The reviewed resvg
component redistribution is documented above. Two proprietary
components are redistributed:

- **NVIDIA CUDA runtime** (`libcudart`, `libcublas`, `libcublasLt` on Linux;
  `cudart`/`cublas` DLLs on Windows) is bundled beside the **CUDA variants** of
  the `llama-server` and `ds4-server` engines so they run without a local CUDA
  Toolkit install. These are NVIDIA-proprietary libraries, redistributed under
  the **NVIDIA CUDA Toolkit EULA** (`cudart`/`cublas` are on NVIDIA's
  redistributable list). The NVIDIA GPU **driver** itself (`libcuda.so.1` /
  `nvcuda.dll`) is *not* bundled — it must already be present on the user's
  machine. The Metal (macOS), CPU, and Vulkan builds bundle no proprietary
  GPU components. (The Visual C++ runtime below is installer-scoped on
  Windows, so it accompanies every Windows variant including those.)

- **Microsoft Visual C++ 2015-2022 Redistributable (x64)**
  (`vc_redist.x64.exe`) is embedded in the **Windows installer only** and run
  once during installation (`/install /quiet /norestart`, see
  `packages/app/installer/nsis-hooks.nsh`). It is required rather than
  optional: every native engine binary Gezel ships on Windows imports
  `MSVCP140.dll`, `VCRUNTIME140.dll` and `VCRUNTIME140_1.dll`, which are not
  Windows components — without the redistributable the loader fails those DLLs
  before `main()` and local models never start. It is redistributed under
  Microsoft's [redistributable
  terms](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution),
  which permit shipping it with an application that requires it.

  It is installed centrally rather than copied app-local, so Windows Update
  services it. `packages/app/scripts/stage-vc-redist.mjs` takes the copy
  belonging to the Visual Studio toolset that compiled those engine DLLs — a
  CRT must match its compiling toolset — and refuses to stage any file whose
  Authenticode signature is not valid and does not name Microsoft Corporation.

  Unlike every other component in this file, its licence text is **not** copied
  into `resources/licenses/`: Microsoft ships the redistributable as a single
  self-extracting executable whose terms live in the Visual Studio licence
  rather than as a text file beside the binaries. The link above is the
  authoritative text. macOS and Linux builds do not carry it.

Separately, the **GitHub Copilot CLI** (`@github/copilot` and its
platform-specific binary siblings, pulled in transitively by
`@github/copilot-sdk`) is proprietary, under the free-of-charge **GitHub
Copilot CLI License**. Gezel does not redistribute it: it is downloaded from
npm into the user's own Gezel home on first run — see **Downloaded on first
run** above.

Some **catalog models** likewise ship under non-OSI licenses with
acceptable-use or commercial restrictions (Llama Community License,
NVIDIA Open Model License, FLUX.1 [dev] Non-Commercial, the RAIL
licenses, and Mistral's MIT-Modified). Gezel
does not redistribute those weights either, but see the **Catalog models**
section above before relying on any of them commercially.

---

## Transitive dependencies

The packages above pull in hundreds of transitive dependencies. They appear in
the pnpm lockfile with pinned versions and are predominantly permissive (MIT /
Apache-2.0 / BSD / ISC / CC0), except for the explicitly reviewed components
documented above. A machine-readable summary can be produced at any time with:

```sh
pnpm licenses list --prod --long
```

Any dependency that surfaces with a non-permissive license (GPL, AGPL,
commercial-only, proprietary) should be flagged and either replaced or
documented here explicitly. The audit is enforced by a script:

```sh
pnpm audit:licenses
```

which runs `node scripts/check-licenses.mjs` and fails CI if a transitive
dependency appears outside the permissive allowlist or carries an
`Unknown` license without being pre-approved in the script's
`KNOWN_UNKNOWN` map. When adding or upgrading a dependency, run it once
locally and handle any offenders before pushing.

---

## Regenerating this file

The "Runtime" and "Development" tables are derived from workspace
`package.json` files. A one-shot shell pipeline that rebuilds them:

```sh
for p in $(jq -r '.dependencies // {}, .devDependencies // {} | keys[]' \
    packages/*/package.json package.json | sort -u | grep -v '^@bendyline/' | grep -v '^@types/'); do
  dir=$(ls -d node_modules/.pnpm/"$(echo $p | tr / +)"@*/node_modules/"$p" 2>/dev/null | head -1)
  lic=$(jq -r '.license // "?"' "$dir/package.json")
  hp=$(jq -r '.homepage // .repository.url // ""' "$dir/package.json" | sed 's/^git+//; s/\.git$//')
  echo "| $p | $lic | $hp |"
done
```

The vendored-font manifest in
[`packages/ui/src/assets/fonts/README.md`](packages/ui/src/assets/fonts/README.md)
maps Gezel's source assets to their canonical license texts. The redistributed
inventory is the built `packages/service/dist/ui/assets/` tree. `pnpm
check:notice` reconciles every built WOFF/WOFF2/TTF/OTF file — including Font
Awesome and codicon from dependencies — with the notice rows and verifies the
19 legal files staged into the service's npm payload byte-for-byte.

The **Bundled application runtimes** table is checked against Electron's exact
installed package version and the Node.js/pnpm pins compiled into the desktop
app. Packaging also fails unless all three runtime license inventories are
present in the generated legal bundle.

The **Native engines**, **Runtime-downloaded models**, and **Catalog
models** sections are also hand-maintained, since none of those
components live in the pnpm lockfile:

- Native engines: update when `native/engines/<name>/VERSION` changes or
  a new engine is added under `native/engines/`. `pnpm check:notice` compares
  the visible versions above to every `VERSION` file and requires the matching
  entry in `native/licenses/manifest.json` to name the same pinned commit.
- Vendored connector components: update the "Vendored connector components
  (Prismatic)" table when a new component slice is added under
  `packages/connectors-spectral/vendor/`. The authoritative list — with
  per-slice upstream, license, and content hash — is
  `packages/connectors-spectral/vendor/provenance.json`; `pnpm --filter
  @bendyline/gezel-connectors-spectral verify:vendor` fails if a slice drifts
  from it.
- Catalog models: the per-model `license`/`maintainer`/`upstream` fields
  in the gilde repo's `data/**/manifest.json` (sibling checkout
  `../gilde`, published as `@bendyline/gilde`) are authoritative; refresh
  the summary when a new publisher or license class appears, e.g.:

  ```sh
  for f in ../gilde/data/{chat,image}-models/**/manifest.json; do
    jq -r '"\(.license)\t\(.maintainer.name)"' "$f"
  done | sort -u
  ```
