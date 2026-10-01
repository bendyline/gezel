/**
 * Fraction of `numCtx` reserved for the running transcript + tool
 * outputs. The remaining 25% covers the assistant's response plus
 * a little slack for the next user message. Lower ratios risk
 * clipping mid-reply; higher ones feel fine until someone writes a
 * long answer and the provider returns a `finish_reason: length`.
 */
export const CONTEXT_WORKING_RATIO = 0.75;

/**
 * Compute how many chars of tool output can fit in the remaining
 * context budget for this turn. Inputs are in *tokens* for numCtx
 * (the provider-advertised window) and *chars* for the prompt so
 * far (cheap estimator that every session already exposes). Result
 * is in chars, clamped by the bridge's own floor/ceiling before
 * slicing.
 *
 *   usableTokens   = numCtx × 0.75
 *   transcriptTok  = promptChars / 3.2              (dense-leaning)
 *   remainingTok   = usableTokens − transcriptTok − 512 (reserve)
 *   budgetChars    = remainingTok × 2.8
 *
 * The two ratios are deliberately ASYMMETRIC and conservative. The old
 * symmetric `/4 … ×4` pair assumed 4 chars/token on both sides; dense
 * tool output (catalog JSON, listings) runs ~2.6–3.0 chars/token, so
 * the estimator under-counted the transcript AND over-sized the result
 * budget — the "truncated" payload then overflowed n_ctx by a few
 * hundred tokens and the send died with context-overflow (wild-caught
 * on 4 books in the 2026-07-24 craftbook matrix, overshoots of
 * 111–919 tokens on a 65,536 window). The fixed 512-token reserve
 * absorbs message framing and chat-template overhead the char
 * estimator never sees.
 *
 * Shared by llama-cpp and Ollama providers so they compute the cap
 * identically. Copilot / OpenAI manage history server- or SDK-side;
 * they rely on the fixed `MAX_TOOL_OUTPUT_CHARS` ceiling instead.
 */
export function computeToolBudgetChars(numCtx: number, promptChars: number): number {
  const usableTokens = Math.floor(numCtx * CONTEXT_WORKING_RATIO);
  const transcriptTokens = Math.ceil(promptChars / 3.2);
  const remainingTokens = Math.max(0, usableTokens - transcriptTokens - 512);
  return Math.floor(remainingTokens * 2.8);
}

/**
 * Hard cap on the size of a single tool-output text block fed back to the
 * model. ~80k chars ≈ 20k tokens at the 4-chars/token heuristic — generous
 * enough for any reasonable file read or search result, but a firm wall
 * against pathological cases like `fetch_url` on a modern web page dumping
 * hundreds of KB of inlined HTML/JS/CSS that would blow the context window
 * on a single tool-call iteration.
 *
 * We truncate at the character boundary and append a footer telling the
 * model what happened, so it can reason about the gap instead of assuming
 * it saw everything. Applied universally — providers without server-side
 * history management (Ollama, llama-cpp) would silently choke; providers
 * with it (OpenAI, Copilot) would just silently waste tokens.
 */
export const MAX_TOOL_OUTPUT_CHARS = 80_000;

/**
 * "Useful slice" floor — when the adaptive budget is at least this
 * many chars, callers get a normal truncation footer ("re-run with
 * a more specific request if you need the rest"). Below this, the
 * floor logic in {@link capToolOutput} switches to stronger guidance
 * to narrow or save the result because at sub-8K it is too clipped to
 * be the basis for normal follow-up work. It intentionally does not
 * speculate about overall context pressure: the runtime owns compaction.
 *
 * Used as a *threshold* for footer wording — NOT as an upward clamp.
 * The previous behavior clamped UP to this floor unconditionally,
 * which could push the transcript past `numCtx` on tight-context
 * sessions. See the absolute hard minimum
 * {@link CAP_TOOL_OUTPUT_HARD_FLOOR} for the actual lower bound.
 */
export const MIN_TOOL_OUTPUT_CHARS = 8_000;

/**
 * Absolute hard floor for {@link capToolOutput} — every tool result
 * delivers at least this many chars (~125 tokens) so the model has
 * something to react to. Below this we'd be better off returning a
 * structured "context exhausted, refine" sentinel instead of a
 * meaninglessly clipped output. 500 chars covers a small JSON
 * error payload or the first sentence of a longer response.
 *
 * Distinct from {@link MIN_TOOL_OUTPUT_CHARS} (the "useful slice"
 * threshold for footer wording).
 */
export const CAP_TOOL_OUTPUT_HARD_FLOOR = 500;

/**
 * Leading marker every script/exec tool stamps on a FAILED run — see the
 * `✗ <label> failed (exit N)` / `✗ <label> timed out` shape emitted by
 * gezel-mcp's run_nodejs_script / run_npx / npm_install / extract_archive.
 * On these, the diagnostic (stderr) sits at the END of the body, so
 * {@link capToolOutput} preserves the tail instead of head-only truncating.
 */
const EXECUTION_FAILURE_MARKER = /✗[^\n]*(?:failed \(exit|timed out)/;

/**
 * Truncate a tool output and append a footer describing the drop.
 * Returns the input unchanged when it fits.
 *
 * Bounds:
 *
 * - **Lower** — {@link CAP_TOOL_OUTPUT_HARD_FLOOR} (500 chars). When
 *   the caller's `maxChars` falls below this, we deliver 500 chars
 *   plus stronger result-specific guidance that tells the model to
 *   refine its request or save the output for chunked inspection.
 *   The previous floor (8K) clamped UP unconditionally, which could
 *   push the running transcript past `numCtx` on tight-context
 *   sessions — exactly the cliff a model hits when a chain of tool
 *   calls fills the working window.
 *
 * - **Upper** — {@link MAX_TOOL_OUTPUT_CHARS} (80K chars) absolute
 *   safety cap. When `numCtxTokens` is supplied, the upper bound
 *   tightens to `numCtxTokens × CONTEXT_WORKING_RATIO × 4` so the
 *   ceiling tracks the model's actual context window. A 4K-context
 *   model gets ~12K chars max regardless of what `maxChars` says;
 *   a 32K-context model still gets the 80K absolute. Without this,
 *   a caller bypassing {@link computeToolBudgetChars} on a small
 *   model would silently overflow.
 *
 * Exported for tests and for provider-side double-capping
 * (belt-and-braces for tool outputs that bypass the bridge).
 */
export function capToolOutput(
  text: string,
  maxChars: number = MAX_TOOL_OUTPUT_CHARS,
  opts?: { numCtxTokens?: number },
): string {
  const numCtxCeiling =
    opts?.numCtxTokens !== undefined && opts.numCtxTokens > 0
      ? Math.floor(opts.numCtxTokens * CONTEXT_WORKING_RATIO * 4)
      : MAX_TOOL_OUTPUT_CHARS;
  const ceiling = Math.min(MAX_TOOL_OUTPUT_CHARS, numCtxCeiling);
  const clamped = Math.min(Math.max(maxChars, CAP_TOOL_OUTPUT_HARD_FLOOR), ceiling);
  if (text.length <= clamped) return text;
  // Execution failures (`✗ … failed (exit N)` / `… timed out`, stamped by
  // run_nodejs_script / run_npx / npm_install / extract_archive) put the
  // exit code + stderr — the bytes the model needs to FIX the failure —
  // at the END of the body, after a possibly-huge stdout. A plain
  // head-keep truncation drops exactly those bytes, leaving the model to
  // blind-debug a failure it can't see (the data-wrangle eval loop). When
  // the output is failure-shaped, keep the head (exit line + stdout start)
  // AND the error tail, dropping the middle, within the same budget.
  if (EXECUTION_FAILURE_MARKER.test(text.slice(0, 200))) {
    const tailChars = Math.min(Math.floor(clamped * 0.45), 6000);
    const headChars = clamped - tailChars;
    if (headChars > 0 && tailChars > 0) {
      const head = text.slice(0, headChars);
      const tail = text.slice(text.length - tailChars);
      const middleDropped = text.length - headChars - tailChars;
      return `${head}\n\n…[middle truncated: ${middleDropped.toLocaleString('en-US')} chars dropped — the error tail below is preserved so you can diagnose the failure]…\n\n${tail}`;
    }
  }
  const dropped = text.length - clamped;
  // Footer wording bifurcates on whether this call received a sub-MIN
  // budget vs the normal "useful slice" case. Keep the explanation about
  // this result, not about global context pressure: a model-facing "window
  // nearly full" warning caused models to abandon otherwise recoverable
  // work even though the runtime can compact automatically.
  const isContextTight = maxChars < MIN_TOOL_OUTPUT_CHARS;
  const guidance = isContextTight
    ? 'only a small slice fit this tool call — re-run with a narrower request, or save the output and inspect it in smaller chunks'
    : 'tool output limit applied — re-run with a more specific request if you need the rest';
  return `${text.slice(0, clamped)}\n\n…[tool output truncated: ${dropped.toLocaleString('en-US')} additional chars dropped; ${guidance}]`;
}
