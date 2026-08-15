/**
 * Tool arguments arrive as fragments of one JSON object. These are the
 * write-like tools whose large text payload is useful to watch in the CLI.
 * Keeping the payload field explicit prevents `/show writes` from dumping
 * paths, task refs, match text, or other unrelated arguments.
 */
const WRITE_PAYLOAD_FIELDS = {
  save_memory: 'text',
  write_file: 'content',
  append_to_file: 'content',
  replace_in_file: 'replace',
  replace_lines: 'content',
  apply_patch: 'diff',
  insert_at_marker: 'content',
  write_artifact: 'content',
  write_document: 'content',
  write_task_note: 'text',
} as const;

type WriteToolName = keyof typeof WRITE_PAYLOAD_FIELDS;

export interface WriteStreamState {
  toolName: string;
  phase: 'seeking' | 'reading' | 'done';
  carry: string;
  escaped: boolean;
  unicodeEscape: string | null;
}

export function isStreamedWriteTool(name: string | null | undefined): boolean {
  return writePayloadField(name) !== undefined;
}

export function createWriteStreamState(toolName: string): WriteStreamState {
  return {
    toolName,
    phase: 'seeking',
    carry: '',
    escaped: false,
    unicodeEscape: null,
  };
}

/**
 * Decode only the selected JSON string value from the next argument chunk.
 * The tiny state machine avoids retaining or repeatedly parsing an entire
 * multi-thousand-token file body as it grows.
 */
export function appendWriteArgumentChunk(
  state: WriteStreamState,
  chunk: string,
): { state: WriteStreamState; text: string } {
  if (state.phase === 'done' || chunk.length === 0) return { state, text: '' };

  let next = { ...state };
  let input = chunk;
  if (next.phase === 'seeking') {
    const field = writePayloadField(next.toolName);
    if (!field) return { state: { ...next, phase: 'done', carry: '' }, text: '' };

    const combined = next.carry + chunk;
    const match = payloadStartPattern(field).exec(combined);
    if (!match || match.index === undefined) {
      // A field boundary can straddle chunks, but the key + punctuation is
      // tiny. Retaining this suffix is sufficient without keeping paths or
      // other argument values in memory.
      const carryChars = Math.max(64, field.length + 16);
      return {
        state: { ...next, carry: combined.slice(-carryChars) },
        text: '',
      };
    }

    input = combined.slice(match.index + match[0].length);
    next = { ...next, phase: 'reading', carry: '' };
  }

  let text = '';
  for (const char of input) {
    if (next.unicodeEscape !== null) {
      const unicodeEscape = next.unicodeEscape + char;
      if (unicodeEscape.length < 4) {
        next = { ...next, unicodeEscape };
        continue;
      }
      const code = Number.parseInt(unicodeEscape, 16);
      text += Number.isNaN(code) ? `\\u${unicodeEscape}` : String.fromCharCode(code);
      next = { ...next, unicodeEscape: null, escaped: false };
      continue;
    }

    if (next.escaped) {
      if (char === 'u') {
        next = { ...next, unicodeEscape: '' };
        continue;
      }
      text += decodeEscape(char);
      next = { ...next, escaped: false };
      continue;
    }

    if (char === '\\') {
      next = { ...next, escaped: true };
      continue;
    }
    if (char === '"') {
      next = { ...next, phase: 'done', carry: '' };
      break;
    }
    text += char;
  }

  return { state: next, text };
}

function writePayloadField(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const normalized = normalizeToolName(name);
  return WRITE_PAYLOAD_FIELDS[normalized as WriteToolName];
}

function normalizeToolName(name: string): string {
  return name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function payloadStartPattern(field: string): RegExp {
  return new RegExp(`"${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:\\s*"`);
}

function decodeEscape(char: string): string {
  switch (char) {
    case 'b':
      return '\b';
    case 'f':
      return '\f';
    case 'n':
      return '\n';
    case 'r':
      return '\r';
    case 't':
      return '\t';
    default:
      return char;
  }
}
