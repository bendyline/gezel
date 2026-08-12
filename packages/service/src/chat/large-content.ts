/**
 * Large-content completions: give a caller's instruction the WHOLE of a file
 * (or any content blob), and let this layer decide how it reaches the model —
 * one call when it fits the target's context budget (cloud/Night Shift
 * targets take whole files), or line-aligned overlapping windows merged by
 * the caller when it doesn't. Callers stop truncating; per-caller caps like
 * the review pass's old 6,000-char slice retire in favor of this.
 *
 * The budget is a conservative characters-of-content figure per provider
 * class, not a token count: local engines run with small configured contexts
 * (4-8k tokens typical) that instructions and output share, while cloud
 * targets comfortably take hundreds of thousands of characters. Override with
 * GEZEL_COMPLETION_BUDGET_CHARS when tuning a specific install; wiring real
 * per-model numCtx through here is a deliberate follow-up seam.
 */

const LOCAL_PROVIDERS = new Set(['llama-cpp', 'mlx', 'ollama']);

const DEFAULT_LOCAL_BUDGET_CHARS = 12_000;
const DEFAULT_CLOUD_BUDGET_CHARS = 400_000;

/**
 * Absolute refuse ceiling. Far above anything a model can use in one pass —
 * it exists so a pathological blob can't spin the window loop for hours, not
 * as a quality bound.
 */
export const LARGE_CONTENT_MAX_BYTES = 100 * 1024 * 1024;

/** Content-characters budget per completion for the resolved provider. */
export function completionBudgetChars(providerName?: string): number {
  const env = Number(process.env.GEZEL_COMPLETION_BUDGET_CHARS);
  if (Number.isFinite(env) && env > 0) return env;
  if (providerName && !LOCAL_PROVIDERS.has(providerName)) return DEFAULT_CLOUD_BUDGET_CHARS;
  return DEFAULT_LOCAL_BUDGET_CHARS;
}

export interface ContentWindow {
  /** Window body (whole lines). */
  text: string;
  index: number;
  count: number;
  /** 1-based line number of the window's first line within the full content. */
  lineStart: number;
  /** 1-based line number of the window's last line. */
  lineEnd: number;
  /** Total lines in the full content. */
  totalLines: number;
}

export interface LargeContentRun {
  replies: Array<{ window: ContentWindow; raw: string }>;
  /** Windows the content splits into (before the maxWindows cost bound). */
  totalWindows: number;
  /** True when maxWindows dropped tail windows — coverage was partial. */
  truncated: boolean;
  /** Set instead of replies when the content exceeds the absolute ceiling. */
  refused?: 'over-ceiling';
}

export interface LargeContentOptions {
  /** Content-chars budget per window (from {@link completionBudgetChars}). */
  budgetChars: number;
  /**
   * Cost bound on how many windows may run. Partial coverage is REPORTED
   * (`truncated`), never silent — the honest successor to a hidden slice.
   */
  maxWindows: number;
  /** Lines repeated between windows so boundary findings aren't lost. */
  overlapLines?: number;
}

/**
 * Split content into line-aligned windows under `budgetChars` each. A single
 * window means "fits — one call with everything". Line alignment keeps
 * callers' line references absolute: window prompts can number their lines
 * with real file line numbers.
 */
export function splitContentWindows(
  content: string,
  opts: Pick<LargeContentOptions, 'budgetChars' | 'overlapLines'>,
): ContentWindow[] {
  const lines = content.split('\n');
  const totalLines = lines.length;
  if (content.length <= opts.budgetChars) {
    return [{ text: content, index: 0, count: 1, lineStart: 1, lineEnd: totalLines, totalLines }];
  }
  const overlap = Math.max(0, opts.overlapLines ?? 0);
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < totalLines) {
    let size = 0;
    let end = start;
    while (end < totalLines) {
      const next = size + lines[end]!.length + 1;
      if (next > opts.budgetChars && end > start) break;
      size = next;
      end++;
    }
    spans.push({ start, end });
    if (end >= totalLines) break;
    start = Math.max(end - overlap, start + 1);
  }
  return spans.map((s, i) => ({
    text: lines.slice(s.start, s.end).join('\n'),
    index: i,
    count: spans.length,
    lineStart: s.start + 1,
    lineEnd: s.end,
    totalLines,
  }));
}

/**
 * A completion the provider refused on content-policy grounds ("Request
 * blocked."). Deterministic for a given prompt — retrying is pure waste, so
 * callers with retry budgets should treat it as a permanent failure for the
 * current content. Thrown by completion closures (e.g. the enrichment deps)
 * and deliberately NOT swallowed by {@link runLargeContentCompletion}.
 */
export class CompletionBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompletionBlockedError';
  }
}

/**
 * Run one completion per window, sequentially (the ambient/queue discipline
 * of the underlying completion is inherited — parallel windows would defeat
 * local-engine admission control). The caller merges the raw replies.
 */
export async function runLargeContentCompletion(
  complete: (prompt: string) => Promise<string>,
  content: string,
  buildPrompt: (window: ContentWindow) => string,
  opts: LargeContentOptions,
): Promise<LargeContentRun> {
  if (Buffer.byteLength(content, 'utf8') > LARGE_CONTENT_MAX_BYTES) {
    return { replies: [], totalWindows: 0, truncated: false, refused: 'over-ceiling' };
  }
  const windows = splitContentWindows(content, opts);
  const capped = windows.slice(0, Math.max(1, opts.maxWindows));
  const replies: LargeContentRun['replies'] = [];
  for (const window of capped) {
    let raw = '';
    try {
      raw = await complete(buildPrompt(window));
    } catch (err) {
      // A policy block is deterministic for this content — every remaining
      // window would fail the same way, and an all-empty run would read as
      // "engine down, retry later" to the caller. Let it propagate.
      if (err instanceof CompletionBlockedError) throw err;
      raw = '';
    }
    replies.push({ window, raw });
  }
  return {
    replies,
    totalWindows: windows.length,
    truncated: capped.length < windows.length,
  };
}
