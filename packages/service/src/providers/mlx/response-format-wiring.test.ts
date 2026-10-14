/**
 * Source-level guards for MLX structured output. The python sidecar has no
 * pytest harness in CI (see response_format_test.py for the token-level
 * proof against a real tokenizer), so these pin the wiring. Motivation: the
 * MLX map sent `output.jsonSchema` nowhere and the sidecar's request model
 * had no `response_format` field, so on gezel's default Apple-silicon engine
 * every structured-output request — a workflow's `complete({ jsonSchema })`,
 * an app's `response_format` — came back as unconstrained text, silently.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MLX_TUNING_MAP,
  applyTuning,
  resolveTuning,
} from '@bendyline/gezel-inference/internal/model-profile/tuning';

function source(name: string): string {
  return readFileSync(
    fileURLToPath(
      new URL(`../../../../inference/src/providers/mlx/python/${name}`, import.meta.url),
    ),
    'utf8',
  );
}
const SERVER_SRC = source('gezel_mlx_server.py');
const SPEC_SRC = source('spec_decode.py');

describe('MLX structured-output wiring', () => {
  it('sends a JSON schema to the sidecar in the OpenAI shape', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const body: Record<string, unknown> = {};
    applyTuning(
      body,
      resolveTuning({ catalog: { output: { jsonSchema: schema } } }),
      MLX_TUNING_MAP,
    );
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { schema } });
  });

  it('declares the field, rejects what it cannot enforce, and constrains every path', () => {
    expect(SERVER_SRC).toMatch(/response_format:\s*Optional\[Dict\[str, Any\]\]/);
    // Compiled before generation; a bad schema or a tools clash is a 422, not free text.
    expect(SERVER_SRC).toMatch(/compile_response_grammar\(/);
    expect(SERVER_SRC).toMatch(/status_code=422, detail=str\(exc\)/);
    // Text paths (batch + serial) and the vision path all add the processor.
    expect(SERVER_SRC).toMatch(
      /tool_grammar_processor, think_budget_processor, response_processor/,
    );
    expect(SERVER_SRC).toMatch(/_vision_stream\(request, http_request, images, response_grammar\)/);
    // Exact JSON over speed: no assisted speculation under a response format.
    expect(SPEC_SRC).toMatch(/getattr\(request, "response_format", None\)/);
  });

  it('never hands BatchGenerator an empty processor list', () => {
    // mlx_lm's GenerationBatch.filter() trims logits_processors only
    // `if any(...)`: after an unconstrained request finished, the next one's
    // processors sat at the wrong index and never ran past the first token
    // (2026-10-13: a schema request right after a plain one returned prose).
    // Applies equally to tool grammars and think budgets.
    expect(SERVER_SRC).toMatch(
      /lps\.append\(self\._processors_for\(sub\.request, sub\.grammar\) or \[_pass_through_logits\]\)/,
    );
  });
});
