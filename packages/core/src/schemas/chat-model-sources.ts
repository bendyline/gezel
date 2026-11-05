import { z } from 'zod';

/** Per-entry Ollama source: just a pull tag. Lifecycle/integrity owned by Ollama. */
export const ChatModelOllamaSourceSchema = z.object({
  /** The pull tag — exactly what `ollama pull <tag>` expects. */
  tag: z.string(),
});
export type ChatModelOllamaSource = z.infer<typeof ChatModelOllamaSourceSchema>;

/**
 * Per-entry llama.cpp source: a Hugging Face repo plus either a single
 * GGUF (`filename` + `sha256`) or a sharded set (`shards[]`). Sharded
 * sources are used for models too large to fit HF's 50 GB LFS file cap,
 * which forces uploaders like `bartowski` and `ggml-org` to split big
 * quants into `*-00001-of-NNNNN.gguf` files. llama.cpp auto-discovers
 * the rest when launched with the first shard via `--model`.
 *
 * Invariant: exactly one of (filename + sha256) or (shards) must be set.
 */
const ShardEntrySchema = z.object({
  /** Filename within the HF repo, e.g. `model-Q4_K_M-00001-of-00002.gguf`. May include a subdirectory. */
  name: z.string(),
  /** SHA-256 of this shard, lifted from HF LFS metadata. */
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Size on disk for this shard. */
  sizeBytes: z.number().int().positive(),
});
export const ChatModelLlamaCppSourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `ggml-org/gemma-4-E2B-it-GGUF`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /**
     * Git revision (commit SHA, tag, or branch) to download from. When
     * set, files are fetched from `…/resolve/<revision>/…` so the bytes
     * are immutable and the pinned `sha256`s always match — upstream
     * re-publishes to `main` can't drift us. Captured at catalog-build
     * time alongside the sha256 pins (both describe the same snapshot).
     * Optional for backward compatibility: absent → download from
     * `main` (the legacy behavior, where an upstream update can cause a
     * checksum mismatch). Prefer a full 40-char commit SHA; a branch
     * name re-introduces drift and a tag can be force-moved.
     */
    revision: z.string().optional(),
    /** Single-file form: filename within the repo, e.g. `gemma-4-E2B-it-Q4_K_M.gguf`. */
    filename: z.string().optional(),
    /** Single-file form: SHA-256 of the GGUF file, verified after download. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /**
     * Sharded form: ordered list of GGUF shards. Order is significant —
     * the installer downloads sequentially, names on disk preserve the
     * `-NNNNN-of-NNNNN` suffix, and the first entry is what gets passed
     * to llama-server via `--model` (it discovers the rest by pattern).
     */
    shards: z.array(ShardEntrySchema).min(2).optional(),
    /** Total on-disk size: the GGUF for single-file, sum of all shards for sharded. */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Working-set footprint when loaded, **KV cache EXCLUDED**: weights as
     * the engine actually buffers them, plus its compute/output buffers and
     * process cost. Used by the local-engine capacity broker to decide how
     * many models fit concurrently; it prices KV explicitly on top from the
     * launch context (see `mlxPlannedReservationBytes` in the MLX builder).
     *
     * Folding KV in here double-counts it. This field used to be documented
     * as "weights + KV cache at default context", and the pins authored to
     * that reading carried a flat 1.2-1.3x that was mostly KV — worth ~10 GiB
     * of phantom reservation on a 35B, while still under-reserving small
     * models whose real overhead is a fixed process cost.
     *
     * Optional, and only worth setting when someone has MEASURED this model:
     * absent entries fall back to `estimateLlamaCppResidentBytes` /
     * `estimateMlxResidentBytes`, which are themselves measured (see their
     * comments in model-fit.ts) and improve as the fleet is re-measured. A
     * pin that merely restates the formula is drift waiting to happen.
     */
    residentBytes: z.number().int().positive().optional(),
    /** Short quant tag for display ('Q4_K_M', 'Q8_0', 'BF16'). */
    quantization: z.string().optional(),
    /**
     * Optional multimodal projection sidecar. Multimodal GGUFs (LLaVA,
     * Gemma 4 vision, Nemotron-3 Omni, …) ship an extra projector file
     * alongside the LLM weights; llama-server loads it via
     * `--mmproj <path>` and the model can then accept image / audio /
     * video inputs. Absent → text-only install.
     *
     * Lives in the same HF repo as the weights, downloaded into the
     * same model directory, verified the same way. The installer
     * records its filename in the on-disk install manifest so the
     * supervisor knows to append `--mmproj` on launch.
     */
    mmproj: z
      .object({
        /** Filename within the repo, e.g. `mmproj-<model>-BF16.gguf`. */
        filename: z.string(),
        /** SHA-256 of the mmproj file, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
    /**
     * Optional speculative-decoding companion GGUF. Some model families
     * (notably Gemma 4) publish their MTP assistant head as a separate
     * model rather than embedding it in the primary GGUF. llama-server
     * loads this file through `--spec-draft-model`.
     *
     * This is deliberately generic: the tuning block selects the matching
     * `draft-mtp`, `draft-dflash`, or other draft mode. Merely shipping a
     * sidecar does not opt a model into a speculative-decoding algorithm.
     */
    draftModel: z
      .object({
        /**
         * Optional repository override when the drafter is published apart
         * from the target GGUF (NVIDIA ships Nemotron 3.5 Bolt's LiLiCorr
         * drafter in its own repo). Absent inherits the enclosing source repo.
         */
        huggingfaceRepo: z
          .string()
          .regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/)
          .optional(),
        /** Immutable drafter-repository revision. Absent inherits the parent revision. */
        revision: z.string().optional(),
        /** Filename within the repo. May include a subdirectory. */
        filename: z.string(),
        /** SHA-256 of the draft GGUF, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
    /**
     * llama-server backends this GGUF must not be offered or run on. A
     * tensor type a backend has no kernel for falls back to the CPU there:
     * an NVFP4 file "works" on Metal at a fraction of its speed, which reads
     * as a broken model. Hidden from the download list, refused at install
     * and launch. Read through `llamaCppBackendExclusion`.
     */
    excludeBackends: z.array(z.enum(['cuda', 'vulkan', 'metal', 'cpu'])).optional(),
    /** Plain sentence shown with an excluded backend, saying why. */
    excludeReason: z.string().min(1).optional(),
  })
  .refine(
    (v) => {
      const single = Boolean(v.filename) && Boolean(v.sha256);
      const sharded = Array.isArray(v.shards) && v.shards.length >= 2;
      return single !== sharded;
    },
    {
      message: 'llamaCpp source must set exactly one of (filename + sha256) or shards[] (>=2)',
    },
  );
export type ChatModelLlamaCppSource = z.infer<typeof ChatModelLlamaCppSourceSchema>;

/**
 * One measured ds4 memory line: what ds4-server planned at `ctxTokens`, and
 * how much that grows per added context token. Author both points from real
 * launches at two windows — ds4 prints the totals at load — so a launch at
 * any other window is priced as `bytes + bytesPerToken × (ctx − ctxTokens)`.
 */
const Ds4MemoryLineShape = {
  /** Window, in tokens, the bytes were measured at. */
  ctxTokens: z.number().int().positive(),
  /** Bytes each added context token costs in this mode (KV, buffers, graph reserve). */
  bytesPerToken: z.number().int().positive(),
};

/**
 * Backends whose ds4 build can stream a family's routed experts from SSD.
 * ds4 picks Metal on macOS and CUDA on Linux.
 */
export const Ds4StreamingBackendSchema = z.enum(['metal', 'cuda']);
export type Ds4StreamingBackend = z.infer<typeof Ds4StreamingBackendSchema>;

/**
 * Per-entry ds4 (DwarfStar) source. ds4 loads supported routed-MoE GGUFs
 * (including DeepSeek V4/V4.1, GLM 5.2/5.3, and Qwen3.8 Flash Next), so the
 * shape mirrors
 * {@link ChatModelLlamaCppSourceSchema} — HF repo + revision + filename/shards
 * + sha256 + residentBytes + quantization — plus two ds4-specific SSD-
 * streaming hints. Current Gezel registrations use single-file artifacts.
 * ds4 is NOT a general GGUF loader: use this block only for architectures and
 * quants the engine explicitly supports. Stock llama.cpp cannot load the
 * routed ds4-only quants.
 */
export const ChatModelDs4SourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `antirez/deepseek-v4-gguf`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /** Git revision (commit SHA) for immutable, sha256-stable downloads. */
    revision: z.string().optional(),
    /** Single-file form: filename within the repo. */
    filename: z.string().optional(),
    /** Single-file form: SHA-256 of the GGUF, verified after download. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    /** Sharded form: ordered list of GGUF shards (first is passed to ds4 --model). */
    shards: z.array(ShardEntrySchema).min(2).optional(),
    /** Total on-disk size (the GGUF, or sum of shards). */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Streaming working-set footprint (expert-cache budget + KV + resident
     * non-routed weights) — NOT the on-disk weight size. ds4 streams MoE
     * experts from SSD, so this is what the capacity broker bills, decoupled
     * from `approxSizeBytes`. Absent → broker falls back to a conservative
     * streaming default (see `CapacityBroker.estimateResidentBytes('ds4')`),
     * so a 64GB box is never told an 87GB DeepSeek-V4 model can't fit.
     *
     * This is a footprint at ONE context window — {@link residentCtxTokens}.
     * Pair it with {@link kvBytesPerToken} to price any other window.
     *
     * Builds that read {@link streamingMemory} and {@link fullResidencyMemory}
     * price each launch mode from those instead; this stays the streamed
     * figure every other reader (lists, fallbacks, older builds) quotes.
     */
    residentBytes: z.number().int().positive().optional(),
    /**
     * Bytes of model weights that must actually be resident when ds4 is not
     * using routed-expert SSD streaming. This normally equals the GGUF size,
     * but architectures with always-disk tables are different: Qwen3.8 keeps
     * its BF16 n-grams on disk and DeepSeek V4.1 does the same for Engrams.
     * The full-residency fit gate uses this value instead of charging those
     * intentionally disk-only bytes as RAM.
     */
    residentWeightBytes: z.number().int().positive().optional(),
    /**
     * Resident bytes each context token costs: ds4's compressed KV rows plus
     * the context buffers that scale with the window. ds4-server prints the
     * split at load —
     * `memory: KV 1.36 GiB (raw 0.36 + compressed 1.00) + buffers 1.00 GiB + …`
     * with `memory detail: ctx=… compressed_kv_rows=…` beneath it — so author
     * this from a real launch, not from an architecture guess.
     *
     * ds4 spills COLD context to SSD, which is why the slope is far below a
     * llama.cpp-class KV: DeepSeek V4 Flash's DSA costs ~8 KiB/token where
     * GLM 5.2's MLA costs ~89 KiB/token. Absent → the footprint is treated as
     * flat and the UI says so instead of drawing a line it can't justify.
     */
    kvBytesPerToken: z.number().int().positive().optional(),
    /**
     * The launch `--ctx` {@link residentBytes} was measured at. Only meaningful
     * alongside {@link kvBytesPerToken}: together they re-base the authored
     * footprint onto whatever window this device actually launches with —
     * `residentBytes + kvBytesPerToken × (ctx − residentCtxTokens)`.
     */
    residentCtxTokens: z.number().int().positive().optional(),
    /** Short quant tag for display ('IQ2_XXS', 'Q4_K', …). */
    quantization: z.string().optional(),
    /**
     * Optional model-specific vision encoder GGUF. DwarfStar loads this
     * sidecar with `--vision <path>`; unlike llama.cpp's `mmproj`, this is a
     * complete encoder whose output is projected into the selected model's
     * visual-token space. The encoder MUST match the language checkpoint.
     *
     * It is downloaded, hashed, and stored beside the language GGUF. The
     * repository normally inherits from the language model, but may be
     * overridden when upstream publishes the matched encoder separately.
     * Declaring one makes native image input available for the installed ds4
     * model; absent means the model is deliberately text-only.
     */
    visionEncoder: z
      .object({
        /**
         * Optional repository override when the model-matched encoder is
         * published separately from the language GGUF. Absent inherits the
         * enclosing ds4 source repository.
         */
        huggingfaceRepo: z
          .string()
          .regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/)
          .optional(),
        /** Immutable encoder-repository revision. Absent inherits the parent revision. */
        revision: z.string().optional(),
        /** Filename within the repo, e.g. `GLM-5.3-Flash-Vision-Encoder.gguf`. */
        filename: z.string(),
        /** SHA-256 of the encoder GGUF, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
    /**
     * Model-embedded multi-token prediction. Presence declares that this GGUF
     * contains the draft block consumed by ds4's `--mtp` flag and enables it
     * under the default `ds4Mtp=auto` policy. This is distinct from
     * {@link draftModel}, which is an external DSpark companion.
     */
    mtp: z
      .object({
        /**
         * Preserve ordinary non-zero-temperature sampling by also passing
         * `--mtp-exact-sampling`. Qwen3.8 should set this: opportunistic MTP
         * otherwise accepts matching greedy drafts directly and changes the
         * requested distribution.
         */
        exactSampling: z.boolean().optional(),
      })
      .optional(),
    /**
     * Suggested `--ssd-streaming-cache-experts` budget in bytes for this
     * quant. Drives both the launch flag and the resident estimate on
     * machines that can't hold the full weights. Absent → ds4 auto-sizes.
     */
    cacheExpertsBytes: z.number().int().positive().optional(),
    /**
     * Whether SSD streaming is recommended for this quant on sub-residency
     * machines (e.g. a 64GB Mac for the 87GB IQ2_XXS). Informational — the
     * runtime decides per actual device RAM.
     */
    ssdStreaming: z.boolean().optional(),
    /**
     * Whether this model family implements ds4's routed-expert
     * `--ssd-streaming` mode. Defaults to true for existing entries. Set false
     * for a family whose pinned ds4 cannot stream it; ds4 refuses such a
     * launch at startup.
     */
    ssdStreamingSupported: z.boolean().optional(),
    /**
     * Backends whose ds4 implements streaming for this family. Absent → every
     * backend. Qwen3.8 streams on Metal only; ds4 refuses it on CUDA.
     */
    ssdStreamingBackends: z.array(Ds4StreamingBackendSchema).min(1).optional(),
    /**
     * Measured working set with every routed expert resident (no
     * `--ssd-streaming`): resident weights, KV and buffers — ds4's
     * `memory: … planned` total, without a vision encoder. Gezel reserves this
     * for a fully loaded launch. Absent → a conservative 96 GiB floor for any
     * family that can stream, because {@link residentBytes} then describes the
     * streamed launch.
     */
    fullResidencyMemory: z
      .object({
        workingSetBytes: z.number().int().positive(),
        ...Ds4MemoryLineShape,
      })
      .optional(),
    /**
     * Measured streamed footprint, everything ds4 holds besides the routed-
     * expert cache budget: resident non-routed weights, context buffers, KV
     * and the graph reserve, without a vision encoder. ds4 prints these at load
     * (`Qwen SSD: … static weights, … graph reserve` and `memory: …`); the
     * prefill expert staging is part of the `--ssd-streaming-cache-experts`
     * budget, so it is not counted here. Declaring this lets Gezel size the
     * expert cache to this device's local-model budget instead of a generic
     * 24 GiB headroom.
     */
    streamingMemory: z
      .object({
        fixedBytes: z.number().int().positive(),
        ...Ds4MemoryLineShape,
        /**
         * Smallest expert cache worth streaming with. A device that cannot
         * fit it beside {@link fixedBytes} is told the model needs more memory.
         */
        minCacheBytes: z.number().int().positive().optional(),
      })
      .optional(),
    /**
     * Model-specific graph prefill cap passed as `--prefill-chunk`. Qwen3.8
     * needs a 1K cap on memory-constrained Macs because its transient Metal
     * workspace scales with this value. Omit for families such as GLM whose
     * graph selects its own chunk size and rejects the flag.
     */
    prefillChunk: z.number().int().positive().optional(),
    /**
     * Ceiling on the launch-time `--ctx` window, in tokens. ds4's default is
     * RAM-tiered, which assumes DeepSeek-V4's small resident footprint; a
     * model that keeps far more weight resident needs a smaller window so KV
     * plus the expert cache still fit. GLM 5.2 IQ2_XXS holds 19.6 GiB of
     * non-routed weights (vs ~4 GiB for DeepSeek V4 Flash) and spends
     * 89 KiB/token on MLA KV, so the RAM-tiered 128K would claim 11 GiB of KV
     * on top of an already-5x-larger fixed cost. Absent → the RAM-tiered
     * default. An explicit `config.ds4NumCtx` always wins over this.
     */
    maxLaunchCtx: z.number().int().positive().optional(),
    /**
     * Optional DSpark speculative-decoding companion GGUF, the ds4 analogue of
     * {@link ChatModelLlamaCppSourceSchema}'s `draftModel`. ds4 loads it with
     * `--mtp-model <path>` and drafts with `--dspark`; the draft width comes from the
     * support model's own `block_size`, not from `--mtp-draft` (that flag is
     * for model-embedded MTP). Family-scoped: DeepSeek V4 Flash publishes one; GLM
     * 5.2/5.3 do not use an external `--mtp-model` file. GLM 5.3 Flash instead
     * carries an embedded draft block enabled with the boolean `--mtp` flag.
     *
     * Declaring this makes it a MANDATORY download for every install of the
     * entry — `buildDownloadPlan` fetches a declared draft companion
     * unconditionally, unlike the opt-in `mmproj`. The DeepSeek support GGUF is
     * ~5.6 GiB, DSpark is off under `--ssd-streaming` (DeepSeek V4.1 excepted,
     * and only with `ds4Dspark=on`) and unhelpful on Metal, so weigh that cost
     * against who can actually use it before adding this to an entry.
     */
    draftModel: z
      .object({
        /** Filename within the same HF repo. May include a subdirectory. */
        filename: z.string(),
        /** SHA-256 of the support GGUF, lifted from HF LFS metadata. */
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        /** Size on disk after download. */
        sizeBytes: z.number().int().positive(),
      })
      .optional(),
  })
  .refine(
    (v) => {
      const single = Boolean(v.filename) && Boolean(v.sha256);
      const sharded = Array.isArray(v.shards) && v.shards.length >= 2;
      return single !== sharded;
    },
    {
      message: 'ds4 source must set exactly one of (filename + sha256) or shards[] (>=2)',
    },
  );
export type ChatModelDs4Source = z.infer<typeof ChatModelDs4SourceSchema>;

/**
 * Per-entry MLX source. MLX models ship as a directory of files
 * (`config.json`, `tokenizer.json`, one or more `.safetensors` shards),
 * so the manifest pins each file's sha256 individually and the
 * installer downloads them as a batch. Apple Silicon only — `MlxProvider`
 * errors actionably on other platforms.
 */
function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

const ContainedPosixModelPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !path.includes('\\') &&
      !containsAsciiControlCharacter(path) &&
      !path.startsWith('/') &&
      path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..'),
    'path must be a contained POSIX-style relative path',
  );

export const ChatModelMlxSourceSchema = z
  .object({
    /** Hugging Face repo id, e.g. `mlx-community/gemma-4-e4b-it-4bit`. */
    huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
    /**
     * Optional model root inside a multi-build Hugging Face repository, e.g.
     * `6bit`. Remote files are fetched below this directory, while their
     * manifest `name`s are installed relative to the selected model root so
     * `config.json` still lands at the local model directory root.
     */
    subdir: ContainedPosixModelPathSchema.optional(),
    /**
     * Git revision (commit SHA, tag, or branch) to download from. When
     * set, files are fetched from `…/resolve/<revision>/…` so the bytes
     * are immutable and the pinned `sha256`s always match — upstream
     * re-publishes to `main` can't drift us. Captured at catalog-build
     * time alongside the sha256 pins (both describe the same snapshot).
     * Optional for backward compatibility: absent → download from `main`
     * (the legacy behavior, where an upstream update can cause a checksum
     * mismatch). Prefer a full 40-char commit SHA; a branch name
     * re-introduces drift and a tag can be force-moved.
     */
    revision: z.string().optional(),
    /**
     * Files to download from the selected model root, each with an
     * LFS-derived sha256. Names are contained, POSIX-style paths relative to
     * that root; they may preserve nested model layout but cannot escape the
     * install directory. Order is significant for progress reporting but not
     * for install correctness.
     */
    files: z
      .array(
        z.object({
          name: ContainedPosixModelPathSchema,
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          sizeBytes: z.number().int().positive(),
        }),
      )
      .min(1),
    /** Total on-disk size across all files. */
    approxSizeBytes: z.number().int().positive(),
    /**
     * Working-set footprint when loaded, **KV cache EXCLUDED**: resident
     * weights plus the Python/MLX process and fixed engine buffers. The
     * capacity broker prices this value and config.json-derived KV separately
     * for the admitted context and concurrency, so including KV here would
     * double-count it. Optional — absent entries fall back to
     * `estimateMlxResidentBytes(approxSizeBytes)`, currently weights × 1.02
     * plus a fixed 1 GiB engine allowance.
     */
    residentBytes: z.number().int().positive().optional(),
    /** Short quant tag for display (`4bit`, `8bit`, `bf16`). */
    quantization: z.string().optional(),
    /**
     * Optional speculative-decoding drafter to install beside the model.
     *
     * MLX speculation arms from a drafter's *presence* next to the model
     * (`engines/mlx/drafters/<modelId>-mtp`), so this block is what turns the
     * feature on for an entry — no per-user configuration. Absent means the
     * model simply decodes normally.
     *
     * A drafter carries a model's multi-token-prediction head and nothing
     * else: it binds to the target's embeddings at load, so ONE artifact
     * serves every quantization of the same base model, and several catalog
     * entries may legitimately point at the same repo. It cannot change what
     * the model emits — every proposed token is verified against the target —
     * so a mismatched or corrupt drafter costs throughput, never correctness.
     *
     * Same download contract as the model above (pinned `revision`, per-file
     * `sha256`), because it rides the same verified install path. Failing to
     * fetch it is NOT an install failure: the model is usable without it.
     */
    drafter: z
      .object({
        /** Hugging Face repo id, e.g. `Bendyline/Qwen3.8-27B-mtp-drafter-mlx-4bit`. */
        huggingfaceRepo: z.string().regex(/^[A-Za-z0-9_\-.]+\/[A-Za-z0-9_\-.]+$/),
        /** Commit SHA to fetch from. Pin it — `main` can be rewritten. */
        revision: z.string().optional(),
        /**
         * Drafter architecture. `mtp` is the model's own native
         * multi-token-prediction head; other kinds (eagle3, dflash) use
         * separately-trained heads and are not wired yet.
         */
        kind: z.enum(['mtp']).default('mtp'),
        /** Files to download, each with an LFS-derived sha256. */
        files: z
          .array(
            z.object({
              name: ContainedPosixModelPathSchema,
              sha256: z.string().regex(/^[a-f0-9]{64}$/),
              sizeBytes: z.number().int().positive(),
            }),
          )
          .min(1),
        /** Total on-disk size of the drafter. */
        approxSizeBytes: z.number().int().positive(),
        /**
         * Resident cost when speculation is active. The drafter is a second
         * model in memory, so this is added to the target's weights before
         * slot planning — an unpriced one is exactly the over-commit that
         * aborts the MLX process. Absent → the on-disk size is used.
         */
        residentBytes: z.number().int().positive().optional(),
      })
      .optional(),
    /**
     * Last-resort Jinja chat template to inject into `tokenizer_config.json`
     * when the downloaded tokenizer_config has no `chat_template` and no
     * `chat_template.jinja` sidecar is shipped alongside. Some MLX
     * uploads omit the template that the upstream model was trained
     * against — without it `mlx_lm.server` falls back to a generic
     * template that may not match, and responses degrade from subtly
     * off to fully incoherent. The install pipeline's recovery order is:
     *   1. `tokenizer_config.chat_template` (upstream ships it) — use as is.
     *   2. `chat_template.jinja` sidecar downloaded from the repo — merge
     *      into tokenizer_config.
     *   3. This field, if set — merge into tokenizer_config.
     *   4. None — mark `chatTemplatePresent: false` and warn.
     */
    chatTemplate: z.string().optional(),
    /**
     * Jinja chat template that REPLACES whatever the repo ships, rather
     * than filling a gap. `chatTemplate` above is a recovery path — it
     * fires only when the download carried no template at all — so it
     * cannot correct a template that is present but wrong. This field
     * can: the install writes it to the `chat_template.jinja` sidecar
     * (the file mlx_vlm loads natively) and overwrites any
     * `tokenizer_config.chat_template`, so both resolution paths agree.
     *
     * Reach for this when an upstream conversion froze a template the
     * model's authors have since fixed. The MLX gemma-4 line is the
     * motivating case: every community conversion — the mlx-community
     * `qat-*` builds, the `unsloth-*-qat-oQ4` rebuilds, the non-QAT
     * builds — was cut before Google published the 2026-07-09 canonical
     * template ("Fixed tool-calling loops, turn closures, and thinking
     * content-ordering"), and `mlx_lm.convert` copies whatever it finds,
     * so no repo choice fixes it. The llama.cpp GGUFs carry the
     * corrected template; that asymmetry is a standing suspect whenever
     * one engine loops on tool calls and the other does not.
     *
     * Pinning one means owning it — a template that drifts from the
     * weights is worse than a stale one. Re-check on version bumps.
     */
    chatTemplateOverride: z.string().optional(),
    /**
     * When set, this MLX build is KNOWN NOT TO LOAD/RUN and must be treated
     * as if the model had no MLX source — hidden from the MLX install picker,
     * refused by the install endpoint, and reported `mlx: false` by source
     * probes — even though the repo/sha pins are retained for the day an
     * upstream fix lands. The string is the human-readable reason (shown in
     * logs / advanced UI). Use this instead of DELETING the `mlx` block when
     * the incompatibility is expected to be temporary (an mlx-vlm arch/quant
     * gap), so the repo pin isn't lost.
     */
    disabledReason: z.string().optional(),
  })
  .superRefine((source, ctx) => {
    const seen = new Set<string>();
    source.files.forEach((file, index) => {
      if (seen.has(file.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['files', index, 'name'],
          message: `duplicate MLX install path: ${file.name}`,
        });
      }
      seen.add(file.name);
    });
  });
export type ChatModelMlxSource = z.infer<typeof ChatModelMlxSourceSchema>;
