/**
 * Parser for `claude --output-format stream-json` lines.
 *
 * The CLI emits one JSON object per line. The shapes we care about:
 *
 *   - `{"type":"system","subtype":"init","session_id":"…","model":"…",…}`
 *   - `{"type":"assistant","message":{role:"assistant",content:[{type:"text",text:"…"}|{type:"tool_use",id,name,input}|{type:"thinking",thinking:"…"}]}}`
 *   - `{"type":"user","message":{role:"user",content:[{type:"tool_result",tool_use_id,content,is_error}]}}`
 *   - `{"type":"result","subtype":"success"|"error_during_execution"|"error_max_turns",
 *        result?:string, is_error:boolean, duration_ms:number,
 *        usage:{input_tokens,output_tokens,cache_creation_input_tokens?,cache_read_input_tokens?},
 *        total_cost_usd:number,session_id:string,...}`
 *
 * Older / future events are tolerated — we surface them as `{kind:'unknown'}`
 * so the caller can debug-log them without throwing. Malformed lines (non-
 * JSON, JSON of an unexpected shape) are surfaced as `{kind:'malformed'}`.
 */

export type StreamEvent =
  | {
      kind: 'session-init';
      sessionId: string;
      model?: string;
      tools?: string[];
      mcpServers?: Array<{ name: string; status: string }>;
    }
  /**
   * Block-granularity text. Fires once per text block when the block
   * completes (one per `assistant` snapshot event). Carries the FULL
   * text of that block. Used as the streaming source when
   * `--include-partial-messages` is NOT in effect.
   */
  | { kind: 'text-delta'; text: string }
  /** Block-granularity thinking. Same shape as `text-delta`. */
  | { kind: 'thinking-delta'; text: string }
  /**
   * Token-granularity text delta. Fires for each `content_block_delta`
   * inside a `stream_event`, when `--include-partial-messages` is
   * enabled. Carries one chunk of text. Real-time streaming source.
   */
  | { kind: 'partial-text-delta'; text: string }
  /** Token-granularity thinking delta. Same shape as `partial-text-delta`. */
  | { kind: 'partial-thinking-delta'; text: string }
  | { kind: 'tool-use'; id: string; name: string; input: Record<string, unknown> }
  | {
      kind: 'tool-result';
      toolUseId: string;
      isError: boolean;
      text: string;
      images: Array<{ mimeType: string; base64: string }>;
    }
  | {
      kind: 'result';
      success: boolean;
      finalText: string | undefined;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      costUsd: number | undefined;
    }
  | { kind: 'unknown'; type: string }
  | { kind: 'malformed'; line: string; error: string };

/**
 * Parse a single line of stream-json output into a typed event. Empty lines
 * resolve to `null` so the caller can ignore them in its loop.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch (err) {
    return {
      kind: 'malformed',
      line: trimmed,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!isObject(raw)) {
    return { kind: 'malformed', line: trimmed, error: 'top-level value is not an object' };
  }
  const type = typeof raw.type === 'string' ? raw.type : 'unknown';
  switch (type) {
    case 'system':
      return parseSystem(raw);
    case 'assistant':
      return parseAssistant(raw);
    case 'user':
      return parseUser(raw);
    case 'result':
      return parseResult(raw);
    case 'stream_event':
      return parseStreamEvent(raw);
    default:
      return { kind: 'unknown', type };
  }
}

/**
 * `stream_event` wraps a raw Anthropic API streaming event when the CLI is
 * launched with `--include-partial-messages`. The inner `event` is one of
 * `message_start`, `content_block_start`, `content_block_delta`,
 * `content_block_stop`, `message_delta`, `message_stop`. The only ones we
 * surface as deltas today are the `*_delta` text/thinking variants — the
 * lifecycle events are inferred from the surrounding `assistant` and
 * `result` events.
 */
function parseStreamEvent(raw: Record<string, unknown>): StreamEvent {
  const inner = isObject(raw.event) ? raw.event : null;
  if (!inner) return { kind: 'unknown', type: 'stream_event' };
  const innerType = typeof inner.type === 'string' ? inner.type : 'unknown';
  if (innerType !== 'content_block_delta') {
    return { kind: 'unknown', type: `stream_event:${innerType}` };
  }
  const delta = isObject(inner.delta) ? inner.delta : null;
  if (!delta) return { kind: 'unknown', type: 'stream_event:content_block_delta' };
  const deltaType = typeof delta.type === 'string' ? delta.type : 'unknown';
  if (deltaType === 'text_delta' && typeof delta.text === 'string') {
    return { kind: 'partial-text-delta', text: delta.text };
  }
  if (deltaType === 'thinking_delta' && typeof delta.thinking === 'string') {
    return { kind: 'partial-thinking-delta', text: delta.thinking };
  }
  // input_json_delta carries tool_use input fragments. We currently get
  // the parsed input from the `assistant` snapshot event when the block
  // closes; reassembling partial JSON here is unnecessary.
  return { kind: 'unknown', type: `stream_event:content_block_delta:${deltaType}` };
}

/**
 * Convenience for callers that already have a buffer of completed lines —
 * map each line independently and drop the nulls. Preserves order.
 */
export function parseStreamLines(lines: readonly string[]): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of lines) {
    const ev = parseStreamLine(line);
    if (ev) events.push(ev);
  }
  return events;
}

function parseSystem(raw: Record<string, unknown>): StreamEvent {
  if (raw.subtype !== 'init') {
    return { kind: 'unknown', type: `system:${String(raw.subtype ?? 'unknown')}` };
  }
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
  if (!sessionId) {
    return {
      kind: 'malformed',
      line: JSON.stringify(raw),
      error: 'system.init missing session_id',
    };
  }
  const event: Extract<StreamEvent, { kind: 'session-init' }> = {
    kind: 'session-init',
    sessionId,
  };
  if (typeof raw.model === 'string') event.model = raw.model;
  if (Array.isArray(raw.tools)) {
    const tools = raw.tools.filter((t): t is string => typeof t === 'string');
    if (tools.length > 0) event.tools = tools;
  }
  if (Array.isArray(raw.mcp_servers)) {
    const mcpServers: Array<{ name: string; status: string }> = [];
    for (const s of raw.mcp_servers) {
      if (isObject(s) && typeof s.name === 'string' && typeof s.status === 'string') {
        mcpServers.push({ name: s.name, status: s.status });
      }
    }
    if (mcpServers.length > 0) event.mcpServers = mcpServers;
  }
  return event;
}

function parseAssistant(raw: Record<string, unknown>): StreamEvent {
  const message = isObject(raw.message) ? raw.message : null;
  if (!message) return { kind: 'unknown', type: 'assistant' };
  const content = Array.isArray(message.content) ? message.content : null;
  if (!content) return { kind: 'unknown', type: 'assistant' };
  // The CLI emits one `assistant` event per content block (rather than per
  // delta). Extract the first interesting block — text/thinking/tool_use.
  // If the message somehow carries multiple blocks, we still surface only
  // the first event from this line; subsequent blocks come on later lines.
  for (const block of content) {
    if (!isObject(block)) continue;
    const blockType = typeof block.type === 'string' ? block.type : '';
    if (blockType === 'text' && typeof block.text === 'string') {
      return { kind: 'text-delta', text: block.text };
    }
    if (blockType === 'thinking' && typeof block.thinking === 'string') {
      return { kind: 'thinking-delta', text: block.thinking };
    }
    if (blockType === 'tool_use') {
      const id = typeof block.id === 'string' ? block.id : '';
      const name = typeof block.name === 'string' ? block.name : '';
      const input = isObject(block.input) ? (block.input as Record<string, unknown>) : {};
      if (id && name) return { kind: 'tool-use', id, name, input };
    }
  }
  return { kind: 'unknown', type: 'assistant' };
}

function parseUser(raw: Record<string, unknown>): StreamEvent {
  const message = isObject(raw.message) ? raw.message : null;
  if (!message) return { kind: 'unknown', type: 'user' };
  const content = Array.isArray(message.content) ? message.content : null;
  if (!content) return { kind: 'unknown', type: 'user' };
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type !== 'tool_result') continue;
    const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
    if (!toolUseId) continue;
    const isError = block.is_error === true;
    const { text, images } = collectToolResultBody(block.content);
    return { kind: 'tool-result', toolUseId, isError, text, images };
  }
  return { kind: 'unknown', type: 'user' };
}

function collectToolResultBody(content: unknown): {
  text: string;
  images: Array<{ mimeType: string; base64: string }>;
} {
  if (typeof content === 'string') return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: '', images: [] };
  const textParts: string[] = [];
  const images: Array<{ mimeType: string; base64: string }> = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'image' && isObject(block.source)) {
      const src = block.source;
      if (
        src.type === 'base64' &&
        typeof src.media_type === 'string' &&
        typeof src.data === 'string'
      ) {
        images.push({ mimeType: src.media_type, base64: src.data });
      }
    }
  }
  return { text: textParts.join(''), images };
}

function parseResult(raw: Record<string, unknown>): StreamEvent {
  const isError =
    raw.is_error === true || (typeof raw.subtype === 'string' && raw.subtype !== 'success');
  const success = !isError;
  const usage = isObject(raw.usage) ? raw.usage : {};
  return {
    kind: 'result',
    success,
    finalText: typeof raw.result === 'string' ? raw.result : undefined,
    durationMs: typeof raw.duration_ms === 'number' ? raw.duration_ms : 0,
    inputTokens: numField(usage, 'input_tokens'),
    outputTokens: numField(usage, 'output_tokens'),
    cacheReadTokens: numField(usage, 'cache_read_input_tokens'),
    cacheCreationTokens: numField(usage, 'cache_creation_input_tokens'),
    costUsd: typeof raw.total_cost_usd === 'number' ? raw.total_cost_usd : undefined,
  };
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
