import { describe, expect, it } from 'vitest';
import { classifyStartupLine, parseMemorySize, stripLogPrefix } from './stdout-parser.js';

describe('stripLogPrefix', () => {
  it('removes the supervisor log prefix', () => {
    expect(stripLogPrefix('[llama-server] main: something')).toBe('main: something');
  });

  it('trims whitespace', () => {
    expect(stripLogPrefix('[llama-server]    padded line   ')).toBe('padded line');
  });

  it('passes through unprefixed lines', () => {
    expect(stripLogPrefix('no prefix here')).toBe('no prefix here');
  });

  it('handles empty + whitespace-only', () => {
    expect(stripLogPrefix('')).toBe('');
    expect(stripLogPrefix('   ')).toBe('');
    expect(stripLogPrefix('[llama-server] ')).toBe('');
  });
});

describe('classifyStartupLine', () => {
  it('returns null on unknown lines', () => {
    expect(classifyStartupLine('some random noise')).toBeNull();
    expect(classifyStartupLine('')).toBeNull();
    expect(classifyStartupLine('[llama-server] ')).toBeNull();
  });

  it('recognizes the build banner', () => {
    const phase = classifyStartupLine('[llama-server] build: 4567 (abcd123)');
    expect(phase).toEqual({
      phase: 'starting',
      detail: 'llama build 4567 (abcd123)',
    });
  });

  it('recognizes system info as starting (no detail)', () => {
    const phase = classifyStartupLine('[llama-server] system info: n_threads = 8 | AVX = 1 | ...');
    expect(phase).toEqual({ phase: 'starting' });
  });

  it('recognizes Metal backend init', () => {
    const phase = classifyStartupLine(
      '[llama-server] ggml_metal_init: picking default device: Apple M2',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toContain('Metal');
  });

  it('recognizes Vulkan + CUDA backend init', () => {
    expect(classifyStartupLine('ggml_vulkan: found 1 Vulkan devices')?.phase).toBe('loading_model');
    expect(classifyStartupLine('ggml_cuda_init: found 1 CUDA devices')?.phase).toBe(
      'loading_model',
    );
  });

  it('recognizes the metadata header', () => {
    const phase = classifyStartupLine(
      '[llama-server] llama_model_loader: loaded meta data with 42 key-value pairs and 100 tensors from /x.gguf',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toContain('metadata');
  });

  it('extracts buffer sizes from load_tensors lines', () => {
    const phase = classifyStartupLine(
      '[llama-server] load_tensors:    Metal_Mapped model buffer size =  2356.44 MiB',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toBe('Loading model weights (2.3 GB)');
    // Also exposes the allocation in bytes so the provider can
    // accumulate a RAM total — see `onStdoutLine` in provider.ts.
    expect(phase?.bufferBytes).toBe(Math.round(2356.44 * 1024 * 1024));
  });

  it('extracts buffer sizes from llama_kv_cache_init lines', () => {
    const phase = classifyStartupLine(
      '[llama-server] llama_kv_cache_init: Metal KV buffer size =   256.00 MiB',
    );
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toContain('KV cache');
    expect(phase?.detail).toContain('256 MB');
    expect(phase?.bufferBytes).toBe(256 * 1024 * 1024);
  });

  it('extracts explicit percentages when present', () => {
    const phase = classifyStartupLine('[llama-server] loading weights into buffers 42%');
    expect(phase?.phase).toBe('loading_model');
    expect(phase?.detail).toBe('Loading model weights (42%)');
    expect(phase?.progress).toBeCloseTo(0.42);
  });

  it('ignores nonsensical percentages', () => {
    expect(classifyStartupLine('something 999% weird')?.progress).toBeUndefined();
  });

  it('recognizes KV cache + context params as near-ready', () => {
    expect(
      classifyStartupLine('[llama-server] llama_kv_cache_init: allocating 256 MiB')?.phase,
    ).toBe('loading_model');
    expect(classifyStartupLine('[llama-server] llama_context: n_ctx = 16384')?.phase).toBe(
      'loading_model',
    );
  });

  it('recognizes the listening line as ready', () => {
    const phase = classifyStartupLine(
      '[llama-server] main: server is listening on http://127.0.0.1:8080',
    );
    expect(phase).toEqual({ phase: 'ready', detail: 'Server ready' });
  });

  it('extracts prompt-processing progress during prefill', () => {
    const phase = classifyStartupLine(
      '[llama-server] slot update_slots: id  3 | task 0 | prompt processing progress, n_tokens = 2048, batch.n_tokens = 2048, progress = 0.146474',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.progress).toBeCloseTo(0.146474, 4);
    expect(phase?.detail).toContain('15%');
    expect(phase?.detail).toContain('2,048');
  });

  it('projects the total prompt size as "X / Y tokens" for the chip', () => {
    // The chat composer's progress chip extracts the *second* number
    // from "X / Y tokens" so it can show the magnitude of the prompt
    // being prefilled (the user-facing "where am I going") rather than
    // the running count (the bar already conveys "where am I now").
    // 2,048 tokens at 14.6474% → total ≈ 13,982. We round to int.
    const phase = classifyStartupLine(
      '[llama-server] slot update_slots: id  3 | task 0 | prompt processing progress, n_tokens = 2048, batch.n_tokens = 2048, progress = 0.146474',
    );
    expect(phase?.detail).toContain('2,048 / 13,982 tokens');
  });

  it('omits the projection on the very first batch (<1%) where it would be noisy', () => {
    // A 0.5% sample would project to a wildly variable total — better
    // to keep the running-only format until we have a reliable signal.
    const phase = classifyStartupLine(
      'slot update_slots: id  3 | task 0 | prompt processing progress, n_tokens = 64, batch.n_tokens = 64, progress = 0.005',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.detail).toContain('64 tokens');
    expect(phase?.detail).not.toContain('/');
  });

  it('handles late-prefill progress (≈90%)', () => {
    const phase = classifyStartupLine(
      'slot update_slots: id  3 | task 0 | prompt processing progress, n_tokens = 12580, batch.n_tokens = 2048, progress = 0.8996',
    );
    expect(phase?.phase).toBe('prefill');
    expect(phase?.detail).toContain('90%');
    expect(phase?.detail).toContain('12,580');
    // Same prompt as the 15% test (2,048 / 0.146474 ≈ 12,580 / 0.8996)
    // — the projection should resolve to the same total within rounding.
    expect(phase?.detail).toContain('/');
    expect(phase?.detail).toMatch(/12,580 \/ 13,98\d tokens/);
  });

  it('maps the slot-release line to ready', () => {
    const phase = classifyStartupLine(
      '[llama-server] slot release: id  3 | task 0 | stop processing: n_past = 128, truncated = false',
    );
    expect(phase?.phase).toBe('ready');
  });

  it('walks a realistic cold-start sequence end-to-end', () => {
    const lines = [
      '[llama-server] build: 4567 (abcd123) with Apple clang',
      '[llama-server] system info: n_threads = 8 | AVX = 1',
      '[llama-server] llama_model_loader: loaded meta data with 32 key-value pairs and 244 tensors',
      '[llama-server] ggml_metal_init: allocating',
      '[llama-server] load_tensors:    Metal_Mapped model buffer size =  2356.44 MiB',
      '[llama-server] load_tensors:   CPU_Mapped model buffer size =    45.21 MiB',
      '[llama-server] llama_kv_cache_init: Metal KV buffer size =   256.00 MiB',
      '[llama-server] llama_context: n_ctx = 16384',
      '[llama-server] main: server is listening on http://127.0.0.1:38721',
    ];
    const phases = lines.map(classifyStartupLine).filter(Boolean) as { phase: string }[];
    const order = phases.map((p) => p.phase);
    // Overall shape: one or more `starting`, then one or more
    // `loading_model`, then exactly one `ready` at the tail. Monotonic,
    // no going back.
    expect(order[0]).toBe('starting');
    expect(order[order.length - 1]).toBe('ready');
    let sawLoading = false;
    let sawReady = false;
    for (const p of order) {
      if (p === 'starting') expect(sawLoading || sawReady).toBe(false);
      if (p === 'loading_model') {
        sawLoading = true;
        expect(sawReady).toBe(false);
      }
      if (p === 'ready') sawReady = true;
    }
    expect(sawLoading).toBe(true);
    expect(sawReady).toBe(true);
  });

  // The structured-log (Vulkan / Windows) build prepends an
  // `<uptime> <level> <scope>` prefix and reshapes several tags. These
  // are verbatim lines from a Qwen 3.6 27B Vulkan run — the case where
  // the app sat on a static "Thinking it through" for 40+s while the
  // console clearly showed progress.
  describe('structured-log (Vulkan) build format', () => {
    it('parses per-batch prompt-processing progress from print_timing lines', () => {
      const phase = classifyStartupLine(
        '[llama-server] 0.15.754.222 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   4096, progress = 0.17, t =   5.22 s / 785.15 tokens per second',
      );
      expect(phase?.phase).toBe('prefill');
      expect(phase?.progress).toBeCloseTo(0.17, 2);
      expect(phase?.detail).toContain('17%');
      expect(phase?.detail).toContain('4,096');
      // 4,096 / 0.17 ≈ 24,094 — the projected prompt size for the chip.
      expect(phase?.detail).toMatch(/4,096 \/ 24,\d{3} tokens/);
    });

    it('parses the 100% completion batch without a projection', () => {
      const phase = classifyStartupLine(
        '[llama-server] 0.47.291.925 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =  24205, progress = 1.00, t =  36.75 s / 658.56 tokens per second',
      );
      expect(phase?.phase).toBe('prefill');
      expect(phase?.progress).toBeCloseTo(1.0, 2);
      expect(phase?.detail).toContain('100%');
      // At exactly 100% the projection is dropped (progress > 0.99).
      expect(phase?.detail).not.toContain('/');
    });

    it('does not treat the final timing summary as prompt-processing progress', () => {
      // These share the `print_timing` tag but carry `prompt eval time`,
      // not `prompt processing` + a `progress =` fraction.
      expect(
        classifyStartupLine(
          '[llama-server] 0.51.227.010 I slot print_timing: id  0 | task 0 | prompt eval time =   38837.08 ms / 24217 tokens (    1.60 ms per token,   623.55 tokens per second)',
        ),
      ).toBeNull();
    });

    it('surfaces the model-load window from srv load_model lines', () => {
      expect(
        classifyStartupLine(
          "[llama-server] 0.00.120.327 I srv    load_model: loading model 'C:\\Users\\x\\.gezel\\engines\\llama-cpp\\models\\q\\Qwen3.6-27B-Q4_K_M.gguf'",
        ),
      ).toEqual({ phase: 'loading_model', detail: 'Loading model into memory' });
      expect(
        classifyStartupLine(
          "[llama-server] 0.10.409.977 I srv    load_model: initializing, n_slots = 3, n_ctx_slot = 65536, kv_unified = 'false'",
        ),
      ).toEqual({ phase: 'loading_model', detail: 'Initializing engine' });
    });

    it('maps the padded release tag to ready', () => {
      const phase = classifyStartupLine(
        '[llama-server] 0.51.228.277 I slot      release: id  0 | task 0 | stop processing: n_tokens = 24270, truncated = 0',
      );
      expect(phase?.phase).toBe('ready');
    });

    it('walks the real Vulkan prefill arc and reports rising progress', () => {
      const lines = [
        "0.00.120.327 I srv    load_model: loading model 'x.gguf'",
        '0.10.409.977 I srv    load_model: initializing, n_slots = 3',
        '0.15.754.222 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =   4096, progress = 0.17, t =   5.22 s / 785.15 tokens per second',
        '0.30.730.830 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =  14336, progress = 0.59, t =  20.19 s / 709.93 tokens per second',
        '0.47.291.925 I slot print_timing: id  0 | task 0 | prompt processing, n_tokens =  24205, progress = 1.00, t =  36.75 s / 658.56 tokens per second',
      ].map((l) => `[llama-server] ${l}`);
      const phases = lines.map(classifyStartupLine);
      expect(phases[0]?.phase).toBe('loading_model');
      expect(phases[1]?.phase).toBe('loading_model');
      const prefill = phases.slice(2).map((p) => p?.progress ?? -1);
      // Strictly increasing — the user watches this climb instead of a
      // frozen label.
      expect(prefill[0]).toBeLessThan(prefill[1]!);
      expect(prefill[1]).toBeLessThan(prefill[2]!);
    });
  });
});

describe('parseMemorySize', () => {
  it('converts MiB + GiB to bytes', () => {
    expect(parseMemorySize('256.00', 'MiB')).toBe(256 * 1024 * 1024);
    expect(parseMemorySize('1.5', 'GiB')).toBe(Math.round(1.5 * 1024 * 1024 * 1024));
  });

  it('handles SI units too', () => {
    expect(parseMemorySize('1', 'MB')).toBe(1_000_000);
    expect(parseMemorySize('2', 'GB')).toBe(2_000_000_000);
  });

  it('returns null on unknown units', () => {
    expect(parseMemorySize('1', 'TB')).toBeNull();
    expect(parseMemorySize('1', 'weird')).toBeNull();
  });

  it('returns null on malformed numbers', () => {
    expect(parseMemorySize('NaN', 'MiB')).toBeNull();
    expect(parseMemorySize('-5', 'MiB')).toBeNull();
  });
});
