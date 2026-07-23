/**
 * Classify a single line of llama-server stdout/stderr into a lifecycle
 * phase + human-readable detail. Used by the supervisor's onLog pipe to
 * surface engine state in the UI instead of a bare "thinking" spinner.
 *
 * Deliberately small and tolerant: matching patterns are well-known
 * upstream log lines that have been stable across recent llama.cpp
 * versions, but we never crash on an unrecognized line — we just return
 * null and the line continues to the raw log file. A format change
 * degrades us to "no phase detail" rather than broken UX.
 *
 * Phase mapping:
 *   - `starting`       : process has spawned but hasn't started loading
 *                        weights yet (version banner, system info).
 *   - `loading_model`  : mapping GGUF into memory, compiling GPU
 *                        shaders, initializing KV cache.
 *   - `prefill`        : mid-turn prompt evaluation — the model is
 *                        consuming the input context in batches. Long
 *                        histories (10k+ tokens) can sit here for
 *                        tens of seconds before the first output
 *                        token arrives; exposing batch progress is
 *                        the biggest user-facing win.
 *   - `ready`          : HTTP listener bound; server can accept
 *                        requests. The supervisor's `/health` probe
 *                        corroborates this.
 *
 * `progress` is emitted only when the line carries an explicit
 * percentage we can trust. We err on the side of omitting it —
 * guessing progress from per-line milestones would feel stuttery.
 */
export interface StartupPhase {
  phase: 'starting' | 'loading_model' | 'prefill' | 'generating' | 'ready';
  detail?: string;
  progress?: number;
  /**
   * Bytes allocated for this line's memory region (model buffer, KV
   * cache, etc.). Set only on lines that carry an explicit size;
   * the caller accumulates these to produce a total engine-memory
   * number for the UI. Absent on all other phase events.
   */
  bufferBytes?: number;
}

/**
 * Strip out any leading log prefix (the supervisor prepends
 * `[llama-server] `) + trim. Exposed so callers can share the same
 * normalization — both the real supervisor and the test fixture.
 */
export function stripLogPrefix(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, '').trim();
}

/**
 * Pure classifier. Returns a phase descriptor when the line matches a
 * known pattern, null otherwise. Caller decides whether to publish on
 * null (typically no) and whether to dedupe repeated identical phases
 * (typically yes — a burst of `load_tensors:` lines shouldn't flood
 * the event bus).
 */
export function classifyStartupLine(rawLine: string): StartupPhase | null {
  const line = stripLogPrefix(rawLine);
  if (!line) return null;

  // Server is up and listening — move to ready. This is the authoritative
  // "can accept requests" signal; the /health 200 that follows confirms.
  if (/^main:\s+server is listening/.test(line)) {
    return { phase: 'ready', detail: 'Server ready' };
  }

  // Runtime: prompt processing progress. Fires per batch as llama-server
  // consumes the input prompt before generation starts. For a long
  // history this can be 5-40 seconds of otherwise-silent work — the
  // single biggest user-facing win. Two log shapes across builds:
  //   older/Metal: `slot update_slots: id 3 | task 0 | prompt processing
  //                 progress, n_tokens = 2048, batch.n_tokens = 2048,
  //                 progress = 0.146474`
  //   newer/Vulkan: `... I slot print_timing: id 0 | task 0 | prompt
  //                 processing, n_tokens = 4096, progress = 0.17, t =
  //                 5.22 s / 785.15 tokens per second`
  // The newer build drops the word "progress" from the phrase (it's a
  // plain comma) and carries the fraction as a later `progress =` key.
  // Match both: "prompt processing" optionally followed by " progress",
  // then the running `n_tokens` count and the `progress =` fraction that
  // appears anywhere after it. Non-anchored on purpose — the structured
  // build prepends an `<uptime> <level> <scope>` prefix we don't strip.
  const promptProgressMatch = line.match(
    /prompt processing(?:\s+progress)?\b.*?n_tokens\s*=\s*(\d+).*?\bprogress\s*=\s*([\d.]+)/,
  );
  if (promptProgressMatch) {
    const nTokens = Number.parseInt(promptProgressMatch[1]!, 10);
    const progress = Number.parseFloat(promptProgressMatch[2]!);
    if (!Number.isNaN(progress) && progress >= 0 && progress <= 1) {
      // Project the total prompt size from `nTokens / progress`. This is
      // exact (modulo float rounding) because llama.cpp emits both
      // values from the same point in the same loop. We surface the
      // total as "X / Y tokens" so the chat composer's progress chip
      // shows the magnitude of the prompt being prefilled (the user-
      // facing "where am I going") rather than the current running
      // count (the "where am I now" the bar already conveys). When
      // progress is too small to project meaningfully (first batch,
      // <1%), keep the running-only format — a "2,048 / 200,000 tokens"
      // estimate from a 1% sample is mostly noise.
      const canProject = progress >= 0.01 && progress <= 0.99;
      const projectedTotal = canProject ? Math.round(nTokens / progress) : null;
      const tokenText =
        projectedTotal !== null
          ? `${nTokens.toLocaleString('en-US')} / ${projectedTotal.toLocaleString('en-US')} tokens`
          : `${nTokens.toLocaleString('en-US')} tokens`;
      return {
        phase: 'prefill',
        detail: `Processing prompt (${Math.round(progress * 100)}% · ${tokenText})`,
        progress,
      };
    }
  }
  // Slot-release line fires when generation completes a slot — useful
  // as a "phase ended" signal we map back to ready. The structured
  // build right-pads the tag to align colons (`slot      release:`),
  // so key off the `release:` tag alone rather than a fixed `slot `
  // spacing.
  if (/\brelease:.*stop processing/.test(line)) {
    return { phase: 'ready', detail: 'Turn complete' };
  }

  // Version banner + system info — pre-model-load. Useful detail to
  // surface on the first-ever launch so the user sees something
  // happened (the process booted).
  const buildMatch = line.match(/^build:\s+(\d+)\s*\(([^)]+)\)/);
  if (buildMatch) {
    return {
      phase: 'starting',
      detail: `llama build ${buildMatch[1]} (${buildMatch[2]})`,
    };
  }
  if (/^system info:/.test(line)) {
    // Skip most of the system-info text — it's 500+ chars of capability
    // flags. Just acknowledge the phase without a detail.
    return { phase: 'starting' };
  }

  // Metal / Vulkan / CUDA backend init. These are the "compiling
  // shaders" / "mapping to GPU" moments that account for a big chunk
  // of cold-start wall-clock on the first ever run.
  if (/^ggml_metal_init:/.test(line)) {
    return { phase: 'loading_model', detail: 'Initializing Metal backend' };
  }
  if (/^ggml_vulkan:/.test(line) || /^ggml_cuda_init:/.test(line)) {
    return { phase: 'loading_model', detail: 'Initializing GPU backend' };
  }

  // GGUF header parse / model metadata read.
  if (/^llama_model_loader:\s+loaded meta data/.test(line)) {
    return { phase: 'loading_model', detail: 'Reading model metadata' };
  }

  // Tensor buffer allocation — each line names a buffer and its size.
  // The bulk of the "silent" wait on a cold start happens here. Parse
  // the size into bytes so the provider can accumulate a RAM total
  // across all the buffer lines.
  const tensorsMatch = line.match(
    /^load_tensors:\s+\S+\s+model buffer size\s*=\s*([\d.]+)\s+(\w+)/,
  );
  if (tensorsMatch) {
    const bytes = parseMemorySize(tensorsMatch[1]!, tensorsMatch[2]!);
    return {
      phase: 'loading_model',
      detail: `Loading model weights (${tensorsMatch[1]} ${tensorsMatch[2]})`,
      ...(bytes !== null ? { bufferBytes: bytes } : {}),
    };
  }

  // Some older / verbose builds emit a literal percentage when loading.
  const percentMatch = line.match(/loading[^0-9]{0,40}(\d{1,3})%/i);
  if (percentMatch) {
    const pct = Number.parseInt(percentMatch[1]!, 10);
    if (!Number.isNaN(pct) && pct >= 0 && pct <= 100) {
      return {
        phase: 'loading_model',
        detail: `Loading model weights (${pct}%)`,
        progress: pct / 100,
      };
    }
  }

  // KV cache allocation — runs after the model is mapped. Close to
  // ready. Parse the buffer size when the line carries one so the
  // total RAM footprint includes KV cache, not just weights.
  // Format example: `llama_kv_cache_init: Metal KV buffer size = 256.00 MiB`
  const kvMatch = line.match(/^llama_kv_cache_init:.*?KV buffer size\s*=\s*([\d.]+)\s+(\w+)/);
  if (kvMatch) {
    const bytes = parseMemorySize(kvMatch[1]!, kvMatch[2]!);
    return {
      phase: 'loading_model',
      detail: `Allocating KV cache (${kvMatch[1]} ${kvMatch[2]})`,
      ...(bytes !== null ? { bufferBytes: bytes } : {}),
    };
  }
  if (/^llama_kv_cache_init:/.test(line)) {
    return { phase: 'loading_model', detail: 'Allocating KV cache' };
  }

  // Context params summary — right before serving. Signals "almost ready."
  if (/^llama_context:/.test(line)) {
    return { phase: 'loading_model', detail: 'Finalizing context' };
  }

  // Model load into memory (structured / Vulkan build). These `srv`-scope
  // lines are the ONLY signal during the load window on builds that don't
  // log per-tensor `load_tensors:` allocation — for a 27B GGUF off a cold
  // disk that's 10+ seconds of otherwise-silent wait. Matched un-anchored
  // because the line carries an `<uptime> <level> srv` prefix.
  //   `... srv load_model: loading model '/path/Model-Q4_K_M.gguf'`
  //   `... srv load_model: initializing, n_slots = 3, n_ctx_slot = 65536`
  if (/\bload_model:\s*loading model\b/.test(line)) {
    return { phase: 'loading_model', detail: 'Loading model into memory' };
  }
  if (/\bload_model:\s*initializing\b/.test(line)) {
    return { phase: 'loading_model', detail: 'Initializing engine' };
  }

  return null;
}

/**
 * Convert a `"2356.44 MiB"` pair into bytes. Returns null for units
 * we don't recognize — defensive against format drift. Accepts the
 * SI + binary unit suffixes llama.cpp actually emits.
 */
export function parseMemorySize(valueStr: string, unit: string): number | null {
  const value = Number.parseFloat(valueStr);
  if (!Number.isFinite(value) || value < 0) return null;
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_024 * 1_024,
    GB: 1_000_000_000,
    GiB: 1_024 * 1_024 * 1_024,
  };
  const mult = multipliers[unit];
  if (mult === undefined) return null;
  return Math.round(value * mult);
}
