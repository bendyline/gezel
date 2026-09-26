/** Strict completion-only protocol for text engines. Never execute JSON embedded
 * in prose, fenced examples, quoted documents, partial streams, or output cut off
 * by its token limit. */
export interface ToolEnvelope {
  name: string;
  arguments: Record<string, unknown>;
}
export function parseExactToolEnvelope(text: string): ToolEnvelope | null {
  if (text.length > 128_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    typeof record.name !== 'string' ||
    !/^[a-z][a-z0-9_]{0,79}$/.test(record.name) ||
    !record.arguments ||
    typeof record.arguments !== 'object' ||
    Array.isArray(record.arguments)
  )
    return null;
  return { name: record.name, arguments: record.arguments as Record<string, unknown> };
}

const WHOLE_REPLY_FENCE = /^```[A-Za-z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/;

/**
 * Closes at most two objects or arrays a completion left open at its end.
 * Qwen 3.5 2B on a phone ended a correct `write_file` call with `}` for its
 * arguments and none for the call itself (2026-09-26). Only a completion that
 * stopped on its own reaches this; one cut off by its token limit never does.
 */
function closeUnbalanced(text: string): string | null {
  const open: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '\\') index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') {
      if (open.pop() !== char) return null;
    }
  }
  if (quoted || open.length === 0 || open.length > 2) return null;
  return text + open.reverse().join('');
}

function parseWholeEnvelope(text: string): ToolEnvelope | null {
  const exact = parseExactToolEnvelope(text);
  if (exact) return exact;
  const closed = closeUnbalanced(text.trim());
  return closed ? parseExactToolEnvelope(closed) : null;
}

/**
 * A completion that is nothing but one code fence around the envelope is the
 * same call as the bare object. Small models fence their calls habitually:
 * Apple's on-device model fenced every one, and so did Qwen 3.5 2B on a phone
 * (2026-09). A fence inside prose is an example, and still never executes.
 */
export function parseToolEnvelopeReply(text: string): ToolEnvelope | null {
  const bare = parseWholeEnvelope(text);
  if (bare) return bare;
  const fenced = WHOLE_REPLY_FENCE.exec(text.trim());
  return fenced ? parseWholeEnvelope(fenced[1]!) : null;
}
