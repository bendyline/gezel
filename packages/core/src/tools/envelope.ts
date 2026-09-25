/** Strict completion-only protocol for text engines. Never execute JSON embedded
 * in prose, code fences, quoted documents, partial streams, or truncated output. */
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
 * A completion that is nothing but one code fence around the exact envelope is
 * the same call as the bare object: with no surrounding prose it cannot be a
 * quoted example. Apple's system model fenced every call in its first native
 * eval (2026-09-24), so no tool ever ran. A fence inside prose still never executes.
 */
export function parseToolEnvelopeReply(text: string): ToolEnvelope | null {
  const exact = parseExactToolEnvelope(text);
  if (exact) return exact;
  const fenced = WHOLE_REPLY_FENCE.exec(text.trim());
  return fenced ? parseExactToolEnvelope(fenced[1]!) : null;
}
