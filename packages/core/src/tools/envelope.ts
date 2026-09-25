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
