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

/**
 * A declared `default` the launcher may seed into its form, or `undefined`
 * when the server has to resolve it instead.
 *
 * A default that is itself a runtime template (`{{task.dir}}`) belongs to
 * the server: `TaskManager.create` expands it against the task's reserved
 * context, which only exists once the task has a number. Seeding it into
 * the form looks harmless — the field shows the same string the craftbook
 * declared — but the form renders its values back into the staged command,
 * the terminal parses them as EXPLICIT params, and an explicit param
 * deliberately bypasses default resolution. The literal `{{…}}` then rides
 * into every gate path built from it, where the unresolved-placeholder
 * guard correctly refuses to run the gate at all
 * (security-architecture-review's `workPath`, task gezel/7).
 *
 * Leaving it unseeded renders no token, which is exactly the "no override
 * supplied" case the server already handles.
 */
export function seedableParamDefault(def: { default?: unknown } | undefined): unknown {
  if (!def || def.default === undefined) return undefined;
  if (typeof def.default === 'string' && /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/.test(def.default)) {
    return undefined;
  }
  return def.default;
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
