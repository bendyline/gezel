/**
 * Source-level guards for MLX thinking-budget enforcement (llama parity
 * with `--reasoning-budget`). The python sidecar has no pytest harness in
 * CI — same shape as prompt-tool-linkage.test.ts. Wild-caught motivation:
 * `'reasoning.thinkingBudget': null` in the MLX map let qwen3.6-27b think
 * 44K chars (~11K tokens, 70 hesitation markers) in ONE block against a
 * configured budget of 4,096 — the "wait... wait..." rumination pathology.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MLX_TUNING_MAP, applyTuning, resolveTuning } from '../../model-profile/tuning.js';

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL('./python/gezel_mlx_server.py', import.meta.url)),
  'utf8',
);
const BUDGET_SRC = readFileSync(
  fileURLToPath(new URL('./python/think_budget.py', import.meta.url)),
  'utf8',
);

describe('MLX thinking-budget wiring', () => {
  it('maps tuning.reasoning.thinkingBudget onto the wire', () => {
    const body: Record<string, unknown> = {};
    applyTuning(
      body,
      resolveTuning({
        catalog: { reasoning: { enableThinking: true, thinkingBudget: 4096 } },
      }),
      MLX_TUNING_MAP,
    );
    expect(body.max_thinking_tokens).toBe(4096);
  });

  it('declares the request field and builds the processor on both paths', () => {
    expect(SERVER_SRC).toMatch(/max_thinking_tokens:\s*Optional\[int\]/);
    expect(SERVER_SRC).toMatch(/build_think_budget_processor\(/);
    // Serial path combines grammar + budget into logits_processors...
    expect(SERVER_SRC).toMatch(/tool_grammar_processor, think_budget_processor/);
    // ...and the batch path carries the same pair through the sub's slot.
    expect(SERVER_SRC).toMatch(/isinstance\(grammar, list\)/);
  });

  it('forces </think> at budget and degrades safely on error', () => {
    expect(BUDGET_SRC).toMatch(/forcing <\/think>/);
    expect(BUDGET_SRC).toMatch(/self\.disabled = True/);
    // Single-token tag resolution is the applicability gate — models
    // without single-token think tags (gemma channel format) get None.
    expect(BUDGET_SRC).toMatch(/len\(open_ids\) != 1 or len\(close_ids\) != 1/);
  });
});
