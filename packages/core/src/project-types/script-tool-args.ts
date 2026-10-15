/**
 * A project type's tool arguments as its script should receive them, on the
 * desktop and the phone alike.
 *
 * Small models sometimes escape a line break twice inside a JSON tool call,
 * so a day's plan arrived as "Belém Tower.\nLunch at a pastelaria" with a
 * literal backslash-n, and the trip board printed it (Gemma 4 12B,
 * 2026-10-12). A text argument holding escaped line breaks and no real ones
 * gets real ones; every other value passes through untouched.
 */

const ESCAPED_BREAK = /\\r\\n|\\n|\\r/g;
const ESCAPED_TAB = /\\t/g;

function repairText(value: string): string {
  if (value.includes('\n') || !/\\[nr]/.test(value)) return value;
  return value.replace(ESCAPED_BREAK, '\n').replace(ESCAPED_TAB, '\t');
}

function declaredType(inputs: Record<string, unknown> | undefined, key: string): unknown {
  const properties = (inputs as { properties?: Record<string, { type?: unknown }> } | undefined)
    ?.properties;
  return properties?.[key]?.type;
}

export function scriptToolArgs(
  args: Record<string, unknown>,
  inputs?: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const type = declaredType(inputs, key);
    if (typeof value === 'string' && (type === undefined || type === 'string')) {
      out[key] = repairText(value);
    } else if (Array.isArray(value) && (type === undefined || type === 'array')) {
      out[key] = value.map((item) => (typeof item === 'string' ? repairText(item) : item));
    } else {
      out[key] = value;
    }
  }
  return out;
}
