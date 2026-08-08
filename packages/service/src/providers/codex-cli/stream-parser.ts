/**
 * Parser for `codex exec --json` lines.
 *
 * The CLI emits one JSON object per line on stdout. The shapes we care
 * about:
 *
 *   - `{"type":"thread.started","thread_id":"…"}`
 *   - `{"type":"turn.started"}`
 *   - `{"type":"item.started","item":{id,type,…}}`
 *   - `{"type":"item.updated","item":{id,type,text?,…}}`
 *   - `{"type":"item.completed","item":{id,type,text?,name?,…}}`
 *   - `{"type":"turn.completed","usage":{input_tokens,cached_input_tokens,output_tokens}}`
 *   - `{"type":"turn.failed","error":{…}}`
 *   - `{"type":"error","message":"…"}`
 *
 * Item `type` values we recognize: `agent_message`, `reasoning`,
 * `command_execution`, `mcp_tool_call`, `file_change`, `web_search`,
 * `plan_update`. Other shapes surface as `{kind:'unknown'}` so the caller
 * can debug-log them; malformed lines surface as `{kind:'malformed'}`.
 *
 * Codex emits an `item.updated` event for the same item id multiple
 * times during streaming (the `text` field grows). Callers that want
 * token-granularity deltas track `lastTextByItem[id]` and emit the
 * diff. The parser is stateless — the caller owns that bookkeeping.
 */

export type CodexItemType =
  | 'agent_message'
  | 'reasoning'
  | 'command_execution'
  | 'mcp_tool_call'
  | 'file_change'
  | 'web_search'
  | 'plan_update';

export type CodexStreamEvent =
  | { kind: 'thread-started'; threadId: string }
  | { kind: 'turn-started' }
  | {
      kind: 'item-started';
      itemId: string;
      itemType: CodexItemType | 'unknown';
      raw: Record<string, unknown>;
    }
  | {
      kind: 'item-updated';
      itemId: string;
      itemType: CodexItemType | 'unknown';
      text: string;
      raw: Record<string, unknown>;
    }
  | {
      kind: 'item-completed';
      itemId: string;
      itemType: CodexItemType | 'unknown';
      text: string;
      raw: Record<string, unknown>;
    }
  | {
      kind: 'turn-completed';
      inputTokens: number;
      cachedInputTokens: number;
      outputTokens: number;
    }
  | { kind: 'turn-failed'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'unknown'; type: string }
  | { kind: 'malformed'; line: string; error: string };

const KNOWN_ITEM_TYPES: ReadonlySet<string> = new Set<CodexItemType>([
  'agent_message',
  'reasoning',
  'command_execution',
  'mcp_tool_call',
  'file_change',
  'web_search',
  'plan_update',
]);

/**
 * Parse a single line of `codex exec --json` output into a typed event.
 * Empty lines resolve to `null` so the caller can ignore them.
 */
export function parseCodexLine(line: string): CodexStreamEvent | null {
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
    case 'thread.started':
      return parseThreadStarted(raw);
    case 'turn.started':
      return { kind: 'turn-started' };
    case 'item.started':
      return parseItemEvent(raw, 'item-started');
    case 'item.updated':
      return parseItemEvent(raw, 'item-updated');
    case 'item.completed':
      return parseItemEvent(raw, 'item-completed');
    case 'turn.completed':
      return parseTurnCompleted(raw);
    case 'turn.failed':
      return { kind: 'turn-failed', message: extractErrorMessage(raw) };
    case 'error':
      return { kind: 'error', message: extractErrorMessage(raw) };
    default:
      return { kind: 'unknown', type };
  }
}

/**
 * Convenience for callers with a buffer of completed lines — map each
 * line independently and drop the nulls. Preserves order.
 */
export function parseCodexLines(lines: readonly string[]): CodexStreamEvent[] {
  const events: CodexStreamEvent[] = [];
  for (const line of lines) {
    const ev = parseCodexLine(line);
    if (ev) events.push(ev);
  }
  return events;
}

function parseThreadStarted(raw: Record<string, unknown>): CodexStreamEvent {
  const threadId =
    typeof raw.thread_id === 'string'
      ? raw.thread_id
      : typeof raw.threadId === 'string'
        ? raw.threadId
        : '';
  if (!threadId) {
    return {
      kind: 'malformed',
      line: JSON.stringify(raw),
      error: 'thread.started missing thread_id',
    };
  }
  return { kind: 'thread-started', threadId };
}

function parseItemEvent(
  raw: Record<string, unknown>,
  kind: 'item-started' | 'item-updated' | 'item-completed',
): CodexStreamEvent {
  const item = isObject(raw.item) ? raw.item : null;
  if (!item) {
    return { kind: 'malformed', line: JSON.stringify(raw), error: `${kind} missing item` };
  }
  const itemId = typeof item.id === 'string' ? item.id : '';
  const itemTypeRaw = typeof item.type === 'string' ? item.type : '';
  const itemType: CodexItemType | 'unknown' = KNOWN_ITEM_TYPES.has(itemTypeRaw)
    ? (itemTypeRaw as CodexItemType)
    : 'unknown';
  if (kind === 'item-started') {
    return { kind, itemId, itemType, raw: item };
  }
  const text = extractItemText(item);
  return { kind, itemId, itemType, text, raw: item };
}

/**
 * Pull the human-readable text out of a Codex item. Different item types
 * carry the prose under different keys: `agent_message` and `reasoning`
 * use `text`; `command_execution` exposes `command` and (when complete)
 * `output`; `mcp_tool_call` has `tool` (or `name` in older versions);
 * `web_search` has `query`. We
 * coalesce all of them down to a single `text` field for the caller —
 * the original item is kept on `raw` for callers that want richer
 * extraction.
 */
function extractItemText(item: Record<string, unknown>): string {
  if (typeof item.text === 'string') return item.text;
  if (typeof item.output === 'string') return item.output;
  if (typeof item.command === 'string') return item.command;
  if (typeof item.tool === 'string') return item.tool;
  if (typeof item.name === 'string') return item.name;
  if (typeof item.query === 'string') return item.query;
  return '';
}

function parseTurnCompleted(raw: Record<string, unknown>): CodexStreamEvent {
  const usage = isObject(raw.usage) ? raw.usage : {};
  return {
    kind: 'turn-completed',
    inputTokens: numField(usage, 'input_tokens'),
    cachedInputTokens: numField(usage, 'cached_input_tokens'),
    outputTokens: numField(usage, 'output_tokens'),
  };
}

function extractErrorMessage(raw: Record<string, unknown>): string {
  if (typeof raw.message === 'string') return raw.message;
  const err = isObject(raw.error) ? raw.error : null;
  if (err) {
    if (typeof err.message === 'string') return err.message;
    if (typeof err.code === 'string') return err.code;
  }
  return '';
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === 'number' ? v : 0;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
