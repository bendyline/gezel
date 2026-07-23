import { describe, expect, it } from 'vitest';
import { classifyMlxFatalErrorLine, classifyMlxStartupLine } from './stdout-parser.js';

describe('classifyMlxStartupLine', () => {
  it('recognizes process-start lines', () => {
    expect(classifyMlxStartupLine('INFO:     Started server process [12345]')?.phase).toBe(
      'starting',
    );
    expect(classifyMlxStartupLine('INFO:     Waiting for application startup.')?.phase).toBe(
      'starting',
    );
  });

  it('recognizes model-loading lines', () => {
    expect(classifyMlxStartupLine('Loading model: /path/to/gemma-3-4b-4bit')?.phase).toBe(
      'loading_model',
    );
    expect(classifyMlxStartupLine('Loading weights from shard 1/3')?.phase).toBe('loading_model');
    expect(classifyMlxStartupLine('Fetching tokenizer.json')?.phase).toBe('loading_model');
  });

  it('recognizes ready lines', () => {
    expect(classifyMlxStartupLine('INFO:     Application startup complete.')?.phase).toBe('ready');
    expect(
      classifyMlxStartupLine('INFO:     Uvicorn running on http://127.0.0.1:58123')?.phase,
    ).toBe('ready');
    expect(classifyMlxStartupLine('Model loaded in 4.2s')?.phase).toBe('ready');
  });

  it('returns null for unrelated lines', () => {
    expect(classifyMlxStartupLine('')).toBeNull();
    expect(classifyMlxStartupLine('POST /v1/chat/completions HTTP/1.1 200 OK')).toBeNull();
    expect(classifyMlxStartupLine('Random debug output about tensors')).toBeNull();
  });

  it('parses chunked-prefill tqdm progress lines', () => {
    const ev = classifyMlxStartupLine(
      'Prefill:  17%|██▍       | 4096/24726 [00:16<01:20, 257.25tok/s]',
    );
    expect(ev?.phase).toBe('prefill');
    expect(ev?.progress).toBeCloseTo(0.17, 2);
    expect(ev?.detail).toBe('4,096 / 24,726 tokens · 257 tok/s');
  });

  it('handles the supervisor-prefixed prefill line at 0% with no rate yet', () => {
    const ev = classifyMlxStartupLine(
      '[mlx_vlm.server] Prefill:   0%|          | 0/24726 [00:00<?, ?tok/s]',
    );
    expect(ev?.phase).toBe('prefill');
    expect(ev?.progress).toBe(0);
    expect(ev?.detail).toBe('0 / 24,726 tokens');
  });

  it('parses the terminal prefill line at 100%', () => {
    const ev = classifyMlxStartupLine(
      'Prefill: 100%|██████████| 24726/24726 [02:30<00:00, 164.84tok/s]',
    );
    expect(ev?.phase).toBe('prefill');
    expect(ev?.progress).toBe(1);
    expect(ev?.detail).toContain('24,726 / 24,726 tokens');
    expect(ev?.detail).toContain('165 tok/s');
  });

  it('formats sub-10 tok/s rates with one decimal', () => {
    const ev = classifyMlxStartupLine('Prefill:   1%|          | 64/4096 [00:30<25:00, 2.13tok/s]');
    expect(ev?.detail).toContain('2.1 tok/s');
  });

  it('parses the batched-path liveness marker (no tqdm bar / rate)', () => {
    // The BatchEngine emits this (gezel_mlx_server `_emit_prefill_liveness`)
    // because mlx_lm's BatchGenerator prints no prefill bar — without it the
    // watchdog saw silence through a long batched first-token wait.
    const ev = classifyMlxStartupLine('[mlx] Prefill:   0%|          | 0/31896 [batched]');
    expect(ev?.phase).toBe('prefill');
    expect(ev?.progress).toBe(0);
    expect(ev?.detail).toBe('0 / 31,896 tokens');
  });
});

describe('classifyMlxFatalErrorLine', () => {
  it('recognizes the model-arch mismatch from Unsloth-style Gemma 3n repacks', () => {
    const res = classifyMlxFatalErrorLine(
      '[mlx_vlm.server] ValueError: Received 126 parameters not in model: language_model.model.layers.24.self_attn.k_norm.weight,',
    );
    expect(res?.category).toBe('model-arch-mismatch');
    // Hint phrasing was generalised to "the on-device runtime" so the
    // copy doesn't leak the underlying mlx-vlm package name. Assert on
    // the recovery breadcrumb instead — that's what the user actually
    // needs to see.
    expect(res?.hint).toMatch(/Reset venv/i);
  });

  it('recognizes the arch-unsupported failure from a MISSING-parameters strict load (Gemma-4 E4B)', () => {
    const res = classifyMlxFatalErrorLine(
      '[mlx_vlm.server] ValueError: Missing 54 parameters: language_model.model.layers.0.altup.correction_coefs.weight,',
    );
    expect(res?.category).toBe('model-arch-unsupported');
    // Distinct from the extra-params case: the fix is a newer mlx-vlm or
    // running on llama, NOT a different quant.
    expect(res?.hint).toMatch(/via llama instead/i);
    expect(res?.hint).toMatch(/Reset venv/i);
    // Guard the boundary: an extra-params error must NOT match this branch.
    expect(
      classifyMlxFatalErrorLine('ValueError: Received 12 parameters not in model: x')?.category,
    ).toBe('model-arch-mismatch');
  });

  it('accepts both mlx_lm and mlx_vlm log prefixes', () => {
    const lm = classifyMlxFatalErrorLine(
      '[mlx_lm.server] ValueError: Received 5 parameters not in model',
    );
    const vlm = classifyMlxFatalErrorLine(
      '[mlx_vlm.server] ValueError: Received 5 parameters not in model',
    );
    const unprefixed = classifyMlxFatalErrorLine('ValueError: Received 5 parameters not in model');
    expect(lm?.category).toBe('model-arch-mismatch');
    expect(vlm?.category).toBe('model-arch-mismatch');
    expect(unprefixed?.category).toBe('model-arch-mismatch');
  });

  it('classifies import errors as missing-dependency', () => {
    const res = classifyMlxFatalErrorLine('ImportError: cannot import name SomeThing');
    expect(res?.category).toBe('missing-dependency');
    expect(res?.hint).toMatch(/reset venv/i);
  });

  it('accepts the supervisor `[mlx]` log prefix on error lines', () => {
    const res = classifyMlxFatalErrorLine('[mlx] ImportError: cannot import name X');
    expect(res?.category).toBe('missing-dependency');
  });

  it('catches the transformers `requires_backends` body line for Qwen3VLVideoProcessor', () => {
    const res = classifyMlxFatalErrorLine(
      '[mlx] Qwen3VLVideoProcessor requires the PyTorch library but it was not found in your environment.',
    );
    expect(res?.category).toBe('missing-dependency');
    expect(res?.message).toContain('Qwen3VLVideoProcessor');
    expect(res?.message).toContain('PyTorch');
    expect(res?.hint).toMatch(/different model|package spec/i);
  });

  it('does NOT mis-classify a bare `ImportError:` line with no message body when no body line is seen', () => {
    // The leaf exception line in transformers' raise is empty after
    // the colon; we still emit a missing-dependency event so the
    // engine doesn't keep accepting requests post-crash.
    const res = classifyMlxFatalErrorLine('[mlx] ImportError: ');
    expect(res?.category).toBe('missing-dependency');
    expect(res?.message).toContain('no detail emitted');
  });

  it('classifies memory errors', () => {
    const res = classifyMlxFatalErrorLine('RuntimeError: MPS backend out of memory');
    expect(res?.category).toBe('out-of-memory');
  });

  it('falls through to `other` for unrecognized exception classes', () => {
    const res = classifyMlxFatalErrorLine('RuntimeError: something weird went wrong');
    expect(res?.category).toBe('other');
    expect(res?.message).toContain('something weird');
  });

  it('returns null for non-error lines', () => {
    expect(classifyMlxFatalErrorLine('Loading model: /some/path')).toBeNull();
    expect(classifyMlxFatalErrorLine('')).toBeNull();
    expect(classifyMlxFatalErrorLine('[mlx_vlm.server] INFO: Starting httpd')).toBeNull();
    // Traceback frames are noise — only leaf exception lines count.
    expect(classifyMlxFatalErrorLine('  File "/path/to/lib.py", line 42, in foo')).toBeNull();
  });
});
