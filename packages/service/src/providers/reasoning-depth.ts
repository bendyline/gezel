/**
 * Constrained-turn reasoning suppression, shared by the local engines.
 *
 * A "constrained turn" is one where the harness needs a specific tool call
 * promptly (the immediate-file-write surface being the common case). Long
 * reasoning is actively harmful there: it consumes the same output budget the
 * tool call needs, so the call truncates mid-argument and has to be salvaged
 * from partial markup.
 *
 * Two dials matter and BOTH have to move:
 *
 *  - `enable_thinking` — the on/off switch.
 *  - `reasoning_effort` / `reasoning_strength` — the DEPTH, which several
 *    templates resolve independently of the switch. Qwen 3.8's HF template
 *    resolves `reasoning_effort|default('xhigh')` inside its thinking branch,
 *    so a turn that isn't fully suppressed runs at the most expensive setting
 *    the model has.
 *
 * Setting only the switch is what let MLX and llama-cpp diverge on the same
 * model: llama-cpp downgraded depth to `low`, MLX left it at the template
 * default. Measured 2026-08-16 over 30 paired trials of qwen3.8-27b-q4 —
 * MLX produced 7.4x the reasoning volume (334,776 vs 45,335 chars), took 5.4x
 * longer to its first artifact (435s vs 81s median, p=0.002), used 2.4x the
 * turn budget, and needed 19 tool-call salvages against llama-cpp's zero.
 *
 * Keep the two engines calling this one function rather than re-deriving the
 * key set; the whole failure mode was one engine knowing something the other
 * didn't.
 */

/**
 * Chat-template variables that name reasoning DEPTH rather than an on/off
 * switch. A template typically reads exactly one of these; we downgrade
 * whichever the model actually declared instead of keeping a per-model branch.
 */
export const REASONING_DEPTH_TEMPLATE_KWARGS: ReadonlySet<string> = new Set([
  'reasoning_effort',
  'reasoning_strength',
]);

/** The value every depth dial is pinned to for a constrained turn. */
export const CONSTRAINED_TURN_REASONING_DEPTH = 'low';

/**
 * Downgrade every declared reasoning-depth kwarg on `body` to `low`.
 *
 * Only rewrites keys the model already declared: writing a dial the template
 * does not read is at best inert and at worst raises inside the template (the
 * Qwen 3.8 jinja calls `raise_exception` on an unexpected effort value), so
 * inventing keys here would trade a silent divergence for a hard failure.
 *
 * Returns the keys it changed, so callers can log what actually moved rather
 * than asserting an effect they did not verify.
 */
export function downgradeReasoningDepthKwargs(body: Record<string, unknown>): string[] {
  const declared = body.chat_template_kwargs;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return [];
  const kwargs = declared as Record<string, unknown>;
  const changed: string[] = [];
  for (const key of Object.keys(kwargs)) {
    if (!REASONING_DEPTH_TEMPLATE_KWARGS.has(key)) continue;
    if (kwargs[key] === CONSTRAINED_TURN_REASONING_DEPTH) continue;
    kwargs[key] = CONSTRAINED_TURN_REASONING_DEPTH;
    changed.push(key);
  }
  return changed;
}
