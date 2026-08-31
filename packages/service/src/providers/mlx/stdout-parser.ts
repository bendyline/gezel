/**
 * Classify lines from `mlx_vlm.server`'s stdout/stderr into structured
 * `EnginePhaseEvent`s so the UI surfaces "loading model N%" instead of
 * a silent spinner.
 *
 * `mlx_vlm.server` logs look like:
 *
 *   INFO:     Started server process [12345]
 *   INFO:     Waiting for application startup.
 *   INFO:     Application startup complete.
 *   INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
 *   INFO:     Loading model: /path/to/model
 *   INFO:     Model loaded
 *   INFO:     127.0.0.1:58420 - "POST /v1/chat/completions HTTP/1.1" 200 OK
 *
 * The format isn't guaranteed stable across mlx-vlm versions, so the
 * matchers are intentionally permissive: we look for substrings rather
 * than exact lines, and silently return null for anything we don't
 * recognize. Unknown lines still flow to the log file via the
 * supervisor's `onLog` — we just don't fan them out as phase events.
 */

import type { EnginePhaseEvent } from '../streaming-session.js';

export function classifyMlxStartupLine(line: string): EnginePhaseEvent | null {
  const lower = line.toLowerCase();

  // ── Process starting ──
  if (/started server process/i.test(line) || /waiting for application startup/i.test(line)) {
    // Phase `detail` is what the engine pill renders verbatim
    // (uppercased by CSS). Keep it human-readable — "Mac AI" beats
    // shipping "mlx_vlm.server" to the user even though that's the
    // literal binary name. The internal `provider: 'mlx'` discriminator
    // and the supervisor's log prefix are unchanged.
    return { provider: 'mlx', phase: 'starting', detail: 'Mac AI server starting' };
  }

  // ── Chunked prefill progress ──
  // mlx_vlm prints a tqdm bar to stdout once chunked prefill kicks in
  // for prompts longer than `--prefill-step-size`. The format is:
  //
  //   Prefill:   8%|██▍       | 2048/24726 [00:08<01:33, 242.65tok/s]
  //
  // Each batch flushes a fresh line because tqdm uses `\r` to overwrite
  // and the supervisor splits chunks on `\n` (not `\r`), so we see
  // every step. Surface this as a `prefill` phase event with `progress`
  // set so the UI can render a real percentage during the long silent
  // window before the first generated token. The 0% line ships with
  // `?tok/s` — handle the missing rate gracefully.
  const prefill = line.match(
    /^(?:\[[^\]]+\]\s+)?Prefill:\s*(\d+)%[^|]*\|[^|]*\|\s*(\d+)\/(\d+)\s*\[[^,\]]*(?:,\s*([\d.]+)tok\/s)?/i,
  );
  if (prefill) {
    const pct = Number.parseInt(prefill[1] ?? '0', 10);
    const cur = Number.parseInt(prefill[2] ?? '0', 10);
    const total = Number.parseInt(prefill[3] ?? '0', 10);
    const tps = prefill[4] ? Number.parseFloat(prefill[4]) : null;
    const detailParts: string[] = [
      `${cur.toLocaleString('en-US')} / ${total.toLocaleString('en-US')} tokens`,
    ];
    if (tps !== null && Number.isFinite(tps) && tps > 0) {
      detailParts.push(`${tps >= 10 ? tps.toFixed(0) : tps.toFixed(1)} tok/s`);
    }
    // `cache=<id>` names the sub this marker belongs to. Matched separately
    // from the tqdm shape above so the bar itself keeps parsing from engines
    // that don't emit the tag (older sidecars, the aggregate fallback path).
    const owner = line.match(/\bcache=(\S+)/);
    return {
      provider: 'mlx',
      phase: 'prefill',
      detail: detailParts.join(' · '),
      progress: Math.max(0, Math.min(1, pct / 100)),
      ...(owner?.[1] ? { cacheId: owner[1] } : {}),
    };
  }

  // ── Loading model ──
  // Match phrases seen in the wild: "Loading model", "Loading weights",
  // "Fetching", "Loading tokenizer". Don't try to parse percentages —
  // mlx-vlm doesn't emit them; UI just shows an indefinite "Loading".
  if (/loading model|loading weights|loading tokenizer|fetching/i.test(lower)) {
    return { provider: 'mlx', phase: 'loading_model', detail: 'Loading weights' };
  }

  // ── Ready ──
  // "Model loaded" (mlx-vlm), "Uvicorn running" (the HTTP server's own
  // readiness line), or "Application startup complete" — any is proof
  // the engine can accept traffic.
  if (
    /model loaded/i.test(line) ||
    /uvicorn running on/i.test(line) ||
    /application startup complete/i.test(line)
  ) {
    return { provider: 'mlx', phase: 'ready' };
  }

  // ── Cache events (Phase 2 wrapped server) ──
  // The wrapper logs `[cache] hit cache_id=... prior_tokens=N`,
  // `[cache] miss cache_id=...`, `[cache] saved cache_id=... tokens=N`,
  // `[cache] evicted cache_id=...`, `[cache] warmed cache_id=...`. We
  // surface hits and warms as `ready` phase events with a friendly
  // detail so the engine pill briefly flashes "Cache hit · 24K tokens
  // reused" instead of staying silent on near-instant turns. Saved /
  // evicted events are bookkeeping only — no UI signal needed.
  const hit = line.match(/\[cache\] hit cache_id=\S+ prior_tokens=(\d+)/);
  if (hit) {
    return {
      provider: 'mlx',
      phase: 'ready',
      detail: `Cache hit · reusing ${Number.parseInt(hit[1] ?? '0', 10).toLocaleString('en-US')} tokens`,
    };
  }
  const warmed = line.match(/\[cache\] warmed cache_id=\S+ tokens=(\d+)/);
  if (warmed) {
    return {
      provider: 'mlx',
      phase: 'ready',
      detail: `Cache warmed · ${Number.parseInt(warmed[1] ?? '0', 10).toLocaleString('en-US')} tokens ready`,
    };
  }

  return null;
}

/**
 * Detect fatal Python exceptions emitted by `mlx_vlm.server` — model
 * load failures, OOM, missing dependencies, tokenizer mismatches.
 * The server's httpd keeps running after the `_generate` worker
 * thread dies, so `/health` lies and chat requests hang — we need a
 * log-side signal to fail fast instead of trusting the health probe.
 *
 * Specifically catches the `NameError: ...` / `ValueError: ...` / etc.
 * leaf line of a traceback — they're one-liners that appear on every
 * Python exception, and the message after the colon is the most
 * useful bit to show a user. Returns null for lines that aren't the
 * leaf exception line, including ordinary warnings and info logs.
 *
 * Specific recognized hints turn into suggested recovery actions the
 * UI can surface inline. For anything we don't recognize we still
 * bubble the raw `<ErrorClass>: <message>` up so the user can copy
 * it into a search.
 */
export interface MlxFatalError {
  category:
    | 'model-arch-mismatch'
    | 'model-arch-unsupported'
    | 'missing-dependency'
    | 'out-of-memory'
    | 'tokenizer-mismatch'
    | 'other';
  message: string;
  /** Short human-readable hint on how to recover, when we recognize the pattern. */
  hint?: string;
}

export function classifyMlxFatalErrorLine(line: string): MlxFatalError | null {
  // ── "X requires the Y library" body line ──
  // transformers' `requires_backends` raises ImportError with the leaf
  // class name on one line ("ImportError:") and the actual hint on
  // following lines: "Qwen3VLVideoProcessor requires the PyTorch
  // library but it was not found in your environment." We match the
  // body line directly because the leaf line is empty after the colon
  // and the classifier needs a single-line signal — there's no
  // multi-line state in the supervisor's per-line dispatch loop. This
  // catches the most common "model X needs torch/torchvision" path
  // even when the bare `ImportError:` line is empty.
  const requiresBackend = line.match(
    /^(?:\[(?:mlx|mlx_v?lm\.server)\]\s+)?(\S+) requires the (\S+) library but it was not found/,
  );
  if (requiresBackend) {
    const className = requiresBackend[1] ?? '';
    const backend = requiresBackend[2] ?? '';
    return {
      category: 'missing-dependency',
      message: `ImportError: ${className} requires the ${backend} library but it was not found`,
      hint: `This model needs the ${backend} backend, which isn't in the on-device venv. Pick a different model from the catalog (the recommended ones don't need ${backend}), or open Settings → This Mac → Advanced and add ${backend.toLowerCase()} to the package spec then Reset venv.`,
    };
  }

  // Match the leaf exception line: optional supervisor `[mlx]` prefix
  // OR mlx-vlm's own `[mlx_lm.server]` / `[mlx_vlm.server]` prefix
  // (depending on whether the supervisor or mlx-vlm tagged the line)
  // then `<ClassName>Error: <message>`. The supervisor's `[mlx]`
  // prefix is the common case in production; the mlx-vlm prefixes
  // appear when the inner process logs through its own logger.
  const match = line.match(/^(?:\[(?:mlx|mlx_v?lm\.server)\]\s+)?([A-Z][A-Za-z]+Error):\s+(.*)$/);
  if (!match) return null;
  const errorClass = match[1] ?? '';
  const message = (match[2] ?? '').trim();
  if (!errorClass) return null;
  // Empty-message ImportError is a real signal (transformers'
  // `requires_backends` produces this) — surface it so we don't keep
  // accepting requests against a dead engine. The followup "X requires
  // the Y library" line above gives a more specific message; this
  // branch is a fallback for cases where that pattern doesn't appear
  // (or arrives after we've already locked in this generic message).
  if (!message) {
    if (errorClass === 'ImportError' || errorClass === 'ModuleNotFoundError') {
      return {
        category: 'missing-dependency',
        message: `${errorClass} (no detail emitted)`,
        hint: 'The on-device runtime is missing a required Python module. Try a different model from the catalog, or Settings → This Mac → Advanced → Reset venv.',
      };
    }
    return null;
  }

  // ── Model architecture mismatch ──
  // Two distinct flavors hit this branch, both surfaced as the same
  // strict-load `ValueError` with a list of unrecognized tensors:
  //   1. Older mlx-vlm builds that don't know a brand-new model
  //      class at all (the original Gemma 3n / `gemma3n` case).
  //   2. A specific quant repacker (e.g. lmstudio-community's Gemma 4
  //      MLX-4bit) chose to quantize a layer that mlx-vlm's model
  //      defines as a custom non-quantizable class — so the weights
  //      ship `<layer>.scales` / `<layer>.biases` that mlx_vlm has
  //      no slot for. The fix in that case is to switch to a quant
  //      that left the custom layer alone, not to bump the package.
  // The hint covers both paths — bump mlx-vlm first, then if still
  // broken delete the install and pick a different catalog entry.
  if (errorClass === 'ValueError' && /Received \d+ parameters not in model/i.test(message)) {
    return {
      category: 'model-arch-mismatch',
      message: `${errorClass}: ${message}`,
      hint: "The on-device runtime doesn't recognize this model's architecture (or this quant's layer layout). Try, in order:\n  1. Settings → This Mac → Advanced: leave the package spec blank for the latest release, then Reset venv.\n  2. If the error persists, the model file layout itself isn't compatible — delete the local model and pick a different catalog entry.",
    };
  }

  // ── Model architecture unsupported (checkpoint MISSING params) ──
  // The mirror of the branch above: `ValueError: Missing N parameters`
  // means mlx-vlm built a model graph with slots the checkpoint doesn't
  // fill — i.e. the loader's model class can't fully represent this
  // architecture yet, so no quant of it will load. Distinct hint from the
  // extra-params case: the fix is an mlx-vlm that adds the architecture,
  // not a different quant — and until then the model is llama.cpp-only.
  if (errorClass === 'ValueError' && /Missing \d+ parameters?/i.test(message)) {
    return {
      category: 'model-arch-unsupported',
      message: `${errorClass}: ${message}`,
      hint: "The on-device runtime (mlx-vlm) can't fully build this model's architecture — the loader expects parameters this checkpoint doesn't provide, so no quant of it will load on MLX yet. Try, in order:\n  1. Settings → This Mac → Advanced: blank the package spec for the latest mlx-vlm, then Reset venv (a newer release may add support).\n  2. If it persists, run this model via llama instead — same weights, different engine — or pick a different catalog entry.",
    };
  }

  // ── Missing Python dependency ──
  if (errorClass === 'ImportError' || errorClass === 'ModuleNotFoundError') {
    return {
      category: 'missing-dependency',
      message: `${errorClass}: ${message}`,
      hint: 'The on-device runtime is missing a required component. Reset venv from Settings → This Mac → Advanced to re-provision it.',
    };
  }

  // ── Out of memory ──
  if (errorClass === 'MemoryError' || /out of memory|mps backend out of memory/i.test(message)) {
    return {
      category: 'out-of-memory',
      message: `${errorClass}: ${message}`,
      hint: 'Not enough unified memory for this model. Try a smaller variant (E2B instead of E4B) or close other memory-heavy apps.',
    };
  }

  // ── Tokenizer / chat-template mismatch ──
  if (/tokenizer|chat.?template/i.test(message)) {
    return {
      category: 'tokenizer-mismatch',
      message: `${errorClass}: ${message}`,
      hint: 'The tokenizer_config is malformed or missing the expected chat template. Try deleting the local model and downloading it again from Settings → This Mac.',
    };
  }

  return {
    category: 'other',
    message: `${errorClass}: ${message}`,
  };
}
