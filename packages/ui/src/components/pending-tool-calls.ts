/**
 * Mid-stream tool-call detector for the streaming bubble.
 *
 * The salvage layer (service-side) only fires AFTER the model finishes
 * its iteration: it collects every recognized markup shape (Hermes
 * `<function=NAME>`, Anthropic `<invoke name="NAME">`, XML
 * self-closing `<tool_name attr="…" />`, JSON envelope
 * `{"tool":"NAME","args":{…}}`, etc.), promotes them to real tool
 * calls, and emits the resulting tool-activity events. During the
 * in-flight window (markup arriving token-by-token → iteration end
 * → salvage runs → tool actually executes), the user sees the
 * markup briefly, then the UI scrub hides it, then the cursor
 * blinks for 5-30 seconds with no signal that something is queueing.
 *
 * This helper closes that gap. It scans the streaming text for every
 * shape the salvage layer also handles, extracts each block (closed
 * or in-flight), and returns a normalized list the streaming bubble
 * renders as "queued" tool rows with a spinner. As soon as the
 * iteration ends and salvage fires, real `ToolActivity` rows
 * replace these — so the pending list is purely a "something is
 * coming" affordance.
 *
 * Shape coverage mirrors the salvage layer (see `local-tool-call-salvage.ts`):
 *
 *   1. Hermes (Qwen / MLX dominant):
 *        <function=NAME>
 *          <parameter=KEY>VALUE</parameter>
 *        </function>
 *
 *   2. Anthropic invoke (Claude-trained models, Qwen 3.6 mimicry):
 *        <invoke name="NAME">
 *          <parameter name="KEY">VALUE</parameter>
 *        </invoke>
 *      (optionally wrapped in `<function_calls>...</function_calls>`)
 *
 *   3. XML self-closing (Anthropic-style attributes):
 *        <browser_navigate url="https://example.com" />
 *        <write_artifact path="notes.md" content="..." />
 *      Restricted to snake_case-style names to avoid matching
 *      legitimate HTML in code blocks (`<div />`, `<br />`). camelCase
 *      tool names like `<readFile path="..." />` are NOT caught here
 *      since they're indistinguishable from custom JSX components
 *      without a tool registry; if a model emits these, they'll only
 *      appear after the iteration ends and salvage fires.
 *
 *   4. JSON envelope (Qwen 3.5/3.6, some smaller Llama variants):
 *        {"tool": "NAME", "args": {...}}
 *        {"name": "NAME", "arguments": {...}}
 *      Anchored on the distinctive `"tool"|"name"|"function"` key
 *      followed by `"args"|"arguments"|"parameters"|"input"`. Risk
 *      of false-positive on legitimate JSON in chat is real but
 *      bounded — the user sees the row briefly then it disappears
 *      if salvage didn't promote it.
 *
 * In-flight tolerance: each parser handles partial input so the row
 * appears as soon as the model's intent is detectable. A bare
 * `<function=writeFile>` or `<invoke name="readFile">` with no
 * params yet still shows up as `(streaming…)`.
 */

export interface PendingToolCall {
  /** Tool name extracted from the markup. */
  name: string;
  /** Parsed parameter values (lenient — values are trimmed strings). */
  params: Record<string, string>;
  /** True when the closing tag/brace has arrived. */
  complete: boolean;
  /** Source-position of the opener for ordering in the rendered list. */
  position: number;
}

// ── Hermes `<function=NAME>` ──────────────────────────────────────
const FUNCTION_OPEN_RE = /<function=([a-zA-Z_][a-zA-Z0-9_]*)\s*>/g;
const PARAMETER_PAIR_RE = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*?)<\/parameter\s*>/g;
const PARAMETER_OPEN_RE = /<parameter=([a-zA-Z_][a-zA-Z0-9_]*)\s*>([\s\S]*)$/;
const FUNCTION_CLOSE_RE = /<\/function\s*>/;

function parseHermesPending(text: string): PendingToolCall[] {
  if (!text.includes('<function=')) return [];
  const out: PendingToolCall[] = [];
  const opens: Array<{ name: string; openStart: number; bodyStart: number }> = [];
  for (const m of text.matchAll(FUNCTION_OPEN_RE)) {
    opens.push({ name: m[1]!, openStart: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < opens.length; i++) {
    const here = opens[i]!;
    const next = opens[i + 1];
    const segment = text.slice(here.bodyStart, next?.openStart ?? text.length);
    const closeMatch = segment.match(FUNCTION_CLOSE_RE);
    const body = closeMatch ? segment.slice(0, closeMatch.index!) : segment;
    const params = collectPairedParams(body, PARAMETER_PAIR_RE);
    const trailing = body.replace(PARAMETER_PAIR_RE, '').match(PARAMETER_OPEN_RE);
    if (trailing && !(trailing[1]! in params)) {
      params[trailing[1]!] = trailing[2]!.trim();
    }
    out.push({
      name: here.name,
      params,
      complete: closeMatch !== null,
      position: here.openStart,
    });
  }
  return out;
}

// ── Anthropic `<invoke name="NAME">` ──────────────────────────────
const INVOKE_OPEN_RE = /<invoke\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\s*>/g;
const INVOKE_PARAMETER_PAIR_RE =
  /<parameter\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\s*>([\s\S]*?)<\/parameter\s*>/g;
const INVOKE_PARAMETER_OPEN_RE = /<parameter\s+name="([a-zA-Z_][a-zA-Z0-9_]*)"\s*>([\s\S]*)$/;
const INVOKE_CLOSE_RE = /<\/invoke\s*>/;

function parseAnthropicInvokePending(text: string): PendingToolCall[] {
  if (!text.includes('<invoke')) return [];
  const out: PendingToolCall[] = [];
  const opens: Array<{ name: string; openStart: number; bodyStart: number }> = [];
  for (const m of text.matchAll(INVOKE_OPEN_RE)) {
    opens.push({ name: m[1]!, openStart: m.index, bodyStart: m.index + m[0].length });
  }
  for (let i = 0; i < opens.length; i++) {
    const here = opens[i]!;
    const next = opens[i + 1];
    const segment = text.slice(here.bodyStart, next?.openStart ?? text.length);
    const closeMatch = segment.match(INVOKE_CLOSE_RE);
    const body = closeMatch ? segment.slice(0, closeMatch.index!) : segment;
    const params = collectPairedParams(body, INVOKE_PARAMETER_PAIR_RE);
    const trailing = body.replace(INVOKE_PARAMETER_PAIR_RE, '').match(INVOKE_PARAMETER_OPEN_RE);
    if (trailing && !(trailing[1]! in params)) {
      params[trailing[1]!] = trailing[2]!.trim();
    }
    out.push({
      name: here.name,
      params,
      complete: closeMatch !== null,
      position: here.openStart,
    });
  }
  return out;
}

// ── XML self-closing `<browser_navigate url="..." />` ─────────────
// Tag-name filter: must contain an underscore (snake_case) AND be at
// least 4 chars. This catches real tool names (`browser_navigate`,
// `write_artifact`, `read_task_notes`) and rejects HTML / JSX
// (`<div />`, `<br />`, `<MyComponent />`, `<svg />`). camelCase
// tools (`readFile`, `readdir`) slip through this filter — that's
// acceptable; they show up after salvage fires.
const XML_SELF_CLOSING_RE =
  /<([a-z][a-z0-9_]*_[a-z0-9_]+)((?:\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*"[^"]*")*)\s*\/>/g;
const XML_OPEN_NO_CLOSE_RE =
  /<([a-z][a-z0-9_]*_[a-z0-9_]+)((?:\s+[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*"[^"]*")*)\s*>(?!.*<\/\1)/g;
const XML_ATTR_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*"([^"]*)"/g;

function parseXmlSelfClosingPending(text: string): PendingToolCall[] {
  // Quick reject — without `_` in any tag, there's nothing to match.
  if (!/<[a-z][a-z0-9_]*_/.test(text)) return [];
  const out: PendingToolCall[] = [];
  for (const m of text.matchAll(XML_SELF_CLOSING_RE)) {
    const name = m[1]!;
    const attrSegment = m[2] ?? '';
    const params = collectXmlAttrs(attrSegment);
    out.push({ name, params, complete: true, position: m.index });
  }
  return out;
}

// ── JSON envelope `{"tool":"NAME","args":{...}}` ──────────────────
// Anchored on the distinctive name+args key pair so legitimate JSON
// in code blocks (`{"foo": "bar"}`) doesn't trigger.
const JSON_ENVELOPE_RE =
  /\{\s*"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"\s*,\s*"(?:args|arguments|parameters|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;

function parseJsonEnvelopePending(text: string): PendingToolCall[] {
  if (!text.includes('"tool"') && !text.includes('"name"') && !text.includes('"function"')) {
    return [];
  }
  const out: PendingToolCall[] = [];
  for (const m of text.matchAll(JSON_ENVELOPE_RE)) {
    const name = m[1]!;
    const argsRaw = m[2] ?? '{}';
    const params: Record<string, string> = {};
    // Lazy JSON parse — if it's malformed (likely mid-stream), fall
    // back to a permissive key=value extraction so we still show
    // *something*. Don't throw.
    try {
      const parsed = JSON.parse(argsRaw);
      if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed)) {
          params[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
      }
    } catch {
      // Fall through with empty params — the row still shows the name.
    }
    out.push({ name, params, complete: true, position: m.index });
  }
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────
function collectPairedParams(body: string, regex: RegExp): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pm of body.matchAll(regex)) {
    params[pm[1]!] = pm[2]!.trim();
  }
  return params;
}

function collectXmlAttrs(attrSegment: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const am of attrSegment.matchAll(XML_ATTR_RE)) {
    params[am[1]!] = am[2] ?? '';
  }
  return params;
}

// ── Combined entry point ──────────────────────────────────────────
/**
 * Parse ALL pending tool-call shapes from streaming text, returning
 * them sorted by source position so the rendered list matches the
 * order the model emitted them. Each shape has its own micro-parser;
 * results combine here without overlap (the shapes are structurally
 * distinct enough that one shape's body never contains another).
 *
 * Note that the inner `<parameter name="X">` blocks inside an
 * Anthropic invoke would technically also match the inner-Hermes
 * `<parameter=X>` regex IF we used the same regex — but we don't:
 * Hermes uses `=` between name and value (`<parameter=KEY>`),
 * Anthropic uses ` name="KEY"`. The parsers stay isolated.
 */
export function parsePendingToolCalls(text: string): PendingToolCall[] {
  if (!text) return [];
  const all = [
    ...parseHermesPending(text),
    ...parseAnthropicInvokePending(text),
    ...parseXmlSelfClosingPending(text),
    ...parseJsonEnvelopePending(text),
  ];
  all.sort((a, b) => a.position - b.position);
  return all;
}

// Also exported for unit testing the individual parsers.
export const __testing = {
  parseHermesPending,
  parseAnthropicInvokePending,
  parseXmlSelfClosingPending,
  parseJsonEnvelopePending,
};

/**
 * Drop the first `executedCount` *complete* pendings — those have
 * already been promoted to real tool segments by the salvage layer
 * (which processes markup in source-position order). Everything left
 * is genuinely still queued: either a `complete: true` block that
 * arrived after the last salvage pass, or a `complete: false` block
 * still streaming. Streaming blocks are NEVER consumed even if
 * `executedCount` is high — salvage only fires on closed markup.
 *
 * The streaming bubble keeps the raw markup in `streamedText` (we
 * only `stripVisibleToolCallMarkup` for display), so re-parsing it
 * each render would otherwise resurrect "queued" rows for tools that
 * have already fired.
 */
export function dropExecutedPending(
  pending: PendingToolCall[],
  executedCount: number,
): PendingToolCall[] {
  if (executedCount <= 0) return pending;
  let consumed = 0;
  return pending.filter((p) => {
    if (p.complete && consumed < executedCount) {
      consumed++;
      return false;
    }
    return true;
  });
}

/**
 * One-line preview of the pending tool's params, formatted for the
 * row display. Picks the most-distinctive param (path / ref / url /
 * query) when present, otherwise the first param. Falls back to
 * empty when no params have arrived yet (just the bare opener).
 */
export function formatPendingArgsPreview(params: Record<string, string>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return '';
  // Prefer the param the user is most likely to recognize at a glance.
  const PRIORITY = ['path', 'ref', 'url', 'query', 'pattern', 'name', 'id', 'gezelId', 'projectId'];
  let pickedKey: string | null = null;
  for (const k of PRIORITY) {
    if (k in params) {
      pickedKey = k;
      break;
    }
  }
  if (pickedKey === null) pickedKey = keys[0]!;
  const value = params[pickedKey] ?? '';
  // Truncate long values (a writeFile content param could be the
  // whole file; the user just needs to know what's queueing).
  const truncated = value.length > 80 ? `${value.slice(0, 79)}…` : value;
  return `${pickedKey}: ${truncated}`;
}
