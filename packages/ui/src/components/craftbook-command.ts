import type { CraftbookTemplateManifest } from '@bendyline/gezel';

/**
 * The bits of a craftbook manifest the launcher needs to render its
 * command. `paramSchema` is a squisq/JSON-Schema object whose top-level
 * `properties` are the (scalar) params, in declaration order.
 */
export type CraftbookCommandManifest = Pick<
  CraftbookTemplateManifest,
  'id' | 'command' | 'paramSchema'
>;

/**
 * The CLI token the launcher stages and the terminal recognizes. Mirrors
 * the server rule (`command ?? id`) — keep in lockstep with
 * `resolveTerminalInput`'s craftbook matcher in the service.
 */
export function craftbookCommandName(m: CraftbookCommandManifest): string {
  const c = m.command?.trim();
  return c && c.length > 0 ? c : m.id;
}

/** Ordered scalar param keys + their declared types, read structurally. */
function paramEntries(m: CraftbookCommandManifest): Array<{ key: string; type: string }> {
  const schema = m.paramSchema as
    | { properties?: Record<string, { type?: unknown } | undefined> }
    | undefined;
  const props = schema?.properties;
  if (!props) return [];
  return Object.keys(props).map((key) => {
    const t = props[key]?.type;
    return { key, type: typeof t === 'string' ? t : 'string' };
  });
}

/** Quote a token iff it contains whitespace or quotes (else leave bare). */
function tokenize(value: string): string {
  if (value === '') return '""';
  if (/[\s"'\\]/.test(value)) return `"${value.replace(/(["\\])/g, '\\$1')}"`;
  return value;
}

/**
 * Render the staged command: the command token followed by param tokens
 * in `paramSchema.properties` declaration order.
 *
 * Provided params render as positional tokens for as long as they form a
 * contiguous prefix (`code-review security high`). Once an earlier
 * optional param is empty, the alignment would be ambiguous, so every
 * subsequent provided param switches to `key=value` form
 * (`code-review intensity=high`). Booleans render as `true` (positional)
 * or `key=true` (keyed) when set, and are omitted when false.
 *
 * Coordinated with the server's `parseCraftbookArgs`, which accepts both
 * positional and `key=value` tokens.
 */
export function renderCraftbookCommand(
  m: CraftbookCommandManifest,
  values: Record<string, string>,
): string {
  const head = craftbookCommandName(m);
  const tokens: string[] = [];
  let contiguous = true;
  for (const { key, type } of paramEntries(m)) {
    const raw = values[key] ?? '';
    const provided = type === 'boolean' ? raw === 'true' : raw !== '';
    if (!provided) {
      contiguous = false;
      continue;
    }
    const valueToken = type === 'boolean' ? 'true' : raw;
    tokens.push(contiguous ? tokenize(valueToken) : `${key}=${tokenize(valueToken)}`);
  }
  return [head, ...tokens].join(' ');
}
