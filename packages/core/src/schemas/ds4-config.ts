import { z } from 'zod';

export const Ds4ConfigSchema = z.object({
  /**
   * ds4-only: base URL of an already-running `ds4-server` to talk to
   * instead of supervising the bundled binary. Mirrors `llamaCppBaseUrl`
   * — the testable dev path (`ds4-server --model … --port 8000`). Env
   * override: `GEZEL_DS4_SERVER_URL`.
   */
  ds4BaseUrl: z.string().optional(),
  /**
   * ds4-only: explicit GGUF path passed to `ds4-server --model`. Only the
   * DeepSeek-V4 and GLM 5.2/5.3 checkpoints ds4 implements load (ds4 is not a
   * general GGUF runner). Env override: `GEZEL_DS4_MODEL`.
   */
  ds4ModelPath: z.string().optional(),
  /**
   * ds4-only: explicit model-matched vision encoder GGUF passed to
   * `ds4-server --vision`. Catalog installs resolve this automatically; this
   * override exists for explicit `ds4ModelPath` development setups. Env
   * override: `GEZEL_DS4_VISION_ENCODER`.
   */
  ds4VisionEncoderPath: z.string().optional(),
  /**
   * ds4-only: context window (tokens) `ds4-server` boots with (`--ctx`).
   * DeepSeek V4 supports up to 1M; the server offloads cold KV to SSD via
   * its own `--kv-disk-dir`. Unset → 128K on ordinary workstations and
   * 256K only on machines with at least 192 GiB of memory.
   */
  ds4NumCtx: z.number().int().positive().optional(),
  /**
   * ds4-only: stream MoE expert weights from SSD instead of full residency
   * (`--ssd-streaming`). Unset keeps the model resident when it fits a local
   * unified-memory target and streams otherwise. `true` always requests
   * streaming; unsafe `false` is ignored when the selected GGUF plus a fixed
   * runtime/OS reserve does not fit.
   */
  ds4SsdStreaming: z.boolean().optional(),
  /**
   * ds4-only: routed-expert SSD-streaming cache budget in GiB
   * (`--ssd-streaming-cache-experts NGB`). The working-set ceiling that
   * decouples ds4's resident footprint from the on-disk weight size — and
   * what the capacity broker bills for this engine. Unset → the selected
   * model's catalog recommendation. Manual values are clamped to preserve
   * runtime/OS headroom.
   */
  ds4CacheExpertsGb: z.number().positive().optional(),
  /**
   * ds4-only: DSpark speculative decoding (`--dspark --mtp-model <support.gguf>`).
   *
   * - `off`  — never draft.
   * - `on`   — draft whenever a support model resolves and the engine allows it.
   * - `auto` — draft only where it has been shown to pay: a CUDA host running
   *            a fully resident model. Default.
   *
   * `auto` deliberately excludes Metal. Measured 2026-08-26 on an M5 Max
   * (DeepSeek V4 Flash IQ2_XXS, full residency, seed-pinned A/B/C/A): baseline
   * 38.4 tok/s, opportunistic 38.5, exact 36.7, and ds4's own
   * `DS4_DSPARK_STATS` accounting reported net_saved of -1301 ms and -1038 ms
   * respectively. Verification of a 5-token block through a 284B MoE costs more
   * than the single-token decodes it skips. Apple Silicon reports
   * `gpuMemoryKind: 'unified'` exactly like GB10 does, so residency/unified
   * memory is NOT a sufficient predicate — the backend is.
   */
  ds4Dspark: z.enum(['off', 'on', 'auto']).optional(),
  /**
   * ds4-only: absolute path to a DSpark support GGUF, overriding whatever the
   * installed model carries. The escape hatch for evaluating DSpark on hardware
   * before any catalog entry declares a `draftModel` (which would make it a
   * mandatory download for every install of that entry).
   */
  ds4DsparkModelPath: z.string().optional(),
});
