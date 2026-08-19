/**
 * Source-level guards for `chat_template_kwargs` reaching the MLX template.
 *
 * Wild-caught 2026-08-18 while decomposing the "MLX is 3x slower than
 * llama-cpp" gap on qwen3.8-27b-q4. The gap was mostly not slowness: MLX
 * generated 2.4x the output tokens for the same task (5,262 vs 2,145 on
 * tictactoe; 7,816 vs 3,389 on tankcombat), and only ~1.3x of the 3.2x
 * wall-clock ratio was genuine throughput.
 *
 * The extra tokens were reasoning. `MLX_TUNING_MAP` routes BOTH
 * `reasoning.enableThinking` and `reasoning.templateKwargs` through
 * `chat_template_kwargs`, and the constrained-turn path additionally writes
 * `enable_thinking: false` plus a `reasoning_effort` downgrade. All of it
 * was discarded on the wire: the sidecar's `ChatRequest` never declared the
 * field, pydantic drops unknown keys silently, and `_build_prompt` then
 * hardcoded `enable_thinking=True`. Every suppressed turn still rendered a
 * prompt ending in `<think>` — visible in the logs as
 * `[think-budget] armed budget=4096 opens_in_think=True` on 41 of 49 turns,
 * while the provider logged "thinking disabled" on 22 of them.
 *
 * The blast radius was wider than the constrained turn: no catalog-declared
 * reasoning setting could reach an MLX template at all.
 *
 * These are source-level assertions for the same reason as
 * think-budget-wiring.test.ts — the sidecar's behavioral suites need mlx_vlm
 * installed, which CI does not have.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { MLX_TUNING_MAP, applyTuning, resolveTuning } from '../../model-profile/tuning.js';
import { applyConstrainedTurnShape } from '../constrained-turn.js';
import { REASONING_DEPTH_TEMPLATE_KWARGS } from '../reasoning-depth.js';

const SERVER_SRC = readFileSync(
  fileURLToPath(new URL('./python/gezel_mlx_server.py', import.meta.url)),
  'utf8',
);

describe('MLX chat_template_kwargs wiring', () => {
  it('maps tuning.reasoning.enableThinking onto chat_template_kwargs', () => {
    const body: Record<string, unknown> = {};
    applyTuning(
      body,
      resolveTuning({ catalog: { reasoning: { enableThinking: false } } }),
      MLX_TUNING_MAP,
    );
    expect(body.chat_template_kwargs).toMatchObject({ enable_thinking: false });
  });

  it('constrained turns request suppression AND a depth downgrade', () => {
    const body: Record<string, unknown> = {
      chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'xhigh' },
    };
    const shaped = applyConstrainedTurnShape(body);
    expect(body.chat_template_kwargs).toMatchObject({
      enable_thinking: false,
      reasoning_effort: 'low',
    });
    expect(shaped.reasoningDepthDowngraded).toContain('reasoning_effort');
  });

  it('declares the request field so pydantic stops dropping it', () => {
    expect(SERVER_SRC).toMatch(/chat_template_kwargs:\s*Optional\[Dict\[str, Any\]\]/);
  });

  it('threads the field from the request into the prompt builder', () => {
    expect(SERVER_SRC).toMatch(/request\.chat_template_kwargs/);
    expect(SERVER_SRC).toMatch(
      /def _build_prompt\([^)]*chat_template_kwargs: Optional\[Dict\[str, Any\]\]/s,
    );
  });

  it('never hardcodes enable_thinking into apply_chat_template', () => {
    // The literal kwarg is what made every caller-supplied value unreachable.
    // A default living in a dict the caller can override is fine; a default
    // spelled at the call site is not.
    expect(SERVER_SRC).not.toMatch(/apply_chat_template\([^)]*enable_thinking\s*=/s);
    expect(SERVER_SRC).toMatch(/template_vars\.update\(chat_template_kwargs\)/);
  });

  it('keeps the depth-kwarg set in sync with the TS side', () => {
    const declared = SERVER_SRC.match(/_REASONING_DEPTH_KWARGS = frozenset\(\{([^}]*)\}\)/s);
    const body = declared?.[1];
    expect(body, 'sidecar must declare the depth-kwarg set').toBeTruthy();
    const pythonKeys = [...(body ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(pythonKeys).toEqual([...REASONING_DEPTH_TEMPLATE_KWARGS].sort());
  });

  it('degrades depth before the switch, and survives a raising template', () => {
    // Qwen 3.8's jinja raises on an unsupported effort. A depth value must
    // never cost us enable_thinking, and no template error may kill the turn.
    expect(SERVER_SRC).toMatch(/without_depth/);
    expect(SERVER_SRC).not.toMatch(/except \(TypeError, ValueError\) as exc_vars/);
    expect(SERVER_SRC).toMatch(/except Exception as exc_vars/);
  });

  it('keeps reasoning ON by default when the caller says nothing', () => {
    // Flipping this default would disable reasoning for ordinary turns,
    // which is a different regression in the opposite direction.
    expect(SERVER_SRC).toMatch(
      /template_vars:\s*Dict\[str, Any\]\s*=\s*\{"enable_thinking": True\}/,
    );
  });
});
