/**
 * Schema-aware repair of tool arguments whose structural values arrived
 * flattened into strings.
 *
 * Why this exists: local models on the MLX/llama.cpp textual path rarely
 * emit a native `tool_calls` event. They emit markup — Hermes
 * `<function=NAME><parameter=KEY>value</parameter>`, Claude
 * `<invoke>/<parameter>`, GLM `<arg_key>/<arg_value>`, XML attributes —
 * and the salvage layer in `local-tool-call-salvage.ts` reconstructs a
 * call from it. Every one of those shapes is a flat KEY→text map: the
 * markup has no way to express a nested object or array, so a parameter
 * whose schema wants `{...}` or `[...]` arrives as the *string*
 * `'{"kind":"file",...}'`.
 *
 * That was invisible while every wired tool took flat scalars (`path`,
 * `content`, `url`). The first toolset with non-scalar top-level
 * arguments (DocBlocks: `convert_document.source`/`targets`,
 * `save_artifact.destination`, `preview_document.source`) turned it into
 * an unrecoverable loop — the validator rejects `got string, expected
 * object`, the model re-emits the identical correct-looking JSON, and the
 * markup flattens it again. Observed: 19 consecutive failed attempts on
 * one craftbook step, the model correctly insisting it was passing the
 * right types.
 *
 * The repair is deliberately gated on the DECLARED type. A string is
 * only reinterpreted when the schema does not accept a string at that
 * position, which makes the dangerous case unrepresentable: a genuine
 * string argument that happens to contain JSON — `write_file({ path:
 * "tsconfig.json", content: "{...}" })` — is never touched, because
 * `content` is declared `string`. Blind "parse anything that starts with
 * a brace" would corrupt exactly that call.
 */

/** JSON Schema fragment. Untyped on purpose — this walks arbitrary MCP schemas. */
export type JsonSchema = Record<string, unknown>;

export interface ToolArgCoercionResult {
  args: Record<string, unknown>;
  /**
   * Dotted paths that were reinterpreted (`targets`, `source.rootId`,
   * `targets.0.format`). Empty when nothing changed — callers use
   * emptiness to skip logging rather than comparing objects.
   */
  repaired: string[];
}

/**
 * Depth ceiling for the structural walk. Schemas this deep don't occur
 * in practice; the bound exists so a self-referential `$ref` chain that
 * escapes the seen-set can't spin.
 */
const MAX_DEPTH = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Resolve a local `#/...` JSON pointer against the root schema.
 * `zod.toJSONSchema` hoists reused shapes into `$defs` and references
 * them, so without this the walk stops at the first shared sub-schema.
 * Remote refs (anything not starting `#/`) are not resolved — we return
 * undefined and simply don't coerce there.
 */
function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSeg of ref.slice(2).split('/')) {
    const seg = rawSeg.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isPlainObject(node)) return undefined;
    node = node[seg];
  }
  return isPlainObject(node) ? node : undefined;
}

/**
 * Follow `$ref` chains to the concrete schema node. Exported because the
 * error-message shape describer in `mcp-wrappers/schema-shape-hint.ts`
 * walks the same schemas and must resolve refs identically — two
 * resolvers over one schema dialect drift, and the drift shows up as a
 * hint that contradicts the coercion.
 */
export function deref(
  schema: JsonSchema | undefined,
  root: JsonSchema,
  seen: Set<string> = new Set(),
): JsonSchema | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  return deref(resolveRef(root, ref), root, seen);
}

/**
 * Every JSON type this position accepts, flattened across `type`,
 * `anyOf`, `oneOf`, and `allOf`. An empty set means "schema declares
 * nothing we can act on" — the caller then leaves the value alone.
 *
 * `enum` / `const` count as declaring their own value types: an enum of
 * strings must report `string` so a stringly enum value is never parsed
 * into something else.
 */
function allowedTypes(schema: JsonSchema | undefined, root: JsonSchema, depth = 0): Set<string> {
  const out = new Set<string>();
  if (!schema || depth > MAX_DEPTH) return out;
  const resolved = deref(schema, root, new Set());
  if (!resolved) return out;

  const t = resolved.type;
  if (typeof t === 'string') out.add(t);
  else if (Array.isArray(t)) for (const x of t) if (typeof x === 'string') out.add(x);

  if ('const' in resolved) out.add(jsonTypeOf(resolved.const));
  if (Array.isArray(resolved.enum)) for (const v of resolved.enum) out.add(jsonTypeOf(v));

  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = resolved[key];
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      if (!isPlainObject(branch)) continue;
      for (const bt of allowedTypes(branch, root, depth + 1)) out.add(bt);
    }
  }
  return out;
}

function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * Reinterpret a string that the schema says cannot be a string.
 * Returns `undefined` when the value should be left exactly as-is —
 * which is the answer for every ambiguous case.
 */
function reinterpretString(value: string, types: ReadonlySet<string>): unknown | undefined {
  // The load-bearing guard: if a string is legal here, the model meant a
  // string. Never second-guess it.
  if (types.size === 0 || types.has('string')) return undefined;

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  const wantsStructural =
    (types.has('object') && trimmed.startsWith('{')) ||
    (types.has('array') && trimmed.startsWith('['));
  if (wantsStructural) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (types.has(jsonTypeOf(parsed))) return parsed;
    } catch {
      // Not JSON after all — a prose value in a structural slot is a
      // genuine model error, and the validator's message about it is
      // more useful than anything we could invent here.
    }
    return undefined;
  }

  if (types.has('boolean')) {
    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
  }
  if ((types.has('number') || types.has('integer')) && /^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    const n = Number(trimmed);
    const integerOnly = types.has('integer') && !types.has('number');
    if (Number.isFinite(n) && (!integerOnly || Number.isInteger(n))) return n;
  }
  if (types.has('null') && trimmed === 'null') return null;
  return undefined;
}

function coerceValue(
  value: unknown,
  schema: JsonSchema | undefined,
  root: JsonSchema,
  path: string,
  repaired: string[],
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) return value;
  const resolved = deref(schema, root, new Set());

  if (typeof value === 'string') {
    const next = reinterpretString(value, allowedTypes(resolved, root));
    if (next === undefined) return value;
    repaired.push(path);
    // Recurse into what we just parsed: markup-flattened calls often
    // nest the same failure (a stringified object inside a stringified
    // array), and the model shouldn't have to survive two round trips.
    return coerceValue(next, resolved, root, path, repaired, depth + 1);
  }

  if (!resolved) return value;

  if (Array.isArray(value)) {
    const items = resolved.items;
    return value.map((el, i) => {
      const elSchema = Array.isArray(items)
        ? isPlainObject(items[i])
          ? (items[i] as JsonSchema)
          : undefined
        : isPlainObject(items)
          ? items
          : undefined;
      return coerceValue(el, elSchema, root, `${path}.${i}`, repaired, depth + 1);
    });
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(resolved.properties) ? resolved.properties : undefined;
    const addl = isPlainObject(resolved.additionalProperties)
      ? (resolved.additionalProperties as JsonSchema)
      : undefined;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const declared = props && isPlainObject(props[k]) ? (props[k] as JsonSchema) : undefined;
      out[k] = coerceValue(
        v,
        declared ?? addl,
        root,
        path ? `${path}.${k}` : k,
        repaired,
        depth + 1,
      );
    }
    return out;
  }

  return value;
}

/**
 * Repair a tool-call argument object against the tool's declared input
 * schema. Pure and allocation-light: when nothing needs repair the
 * returned `args` is the input object itself, so callers can skip work
 * by checking `repaired.length`.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  schema: JsonSchema | undefined,
): ToolArgCoercionResult {
  if (!schema || !isPlainObject(args)) return { args, repaired: [] };
  const repaired: string[] = [];
  const out = coerceValue(args, schema, schema, '', repaired, 0);
  if (repaired.length === 0) return { args, repaired: [] };
  return { args: isPlainObject(out) ? out : args, repaired };
}

/**
 * Same repair against the JSON-string `function.arguments` carried on an
 * OpenAI-shaped tool call. Unparseable JSON is returned untouched — the
 * salvage layer's own repair passes own that failure mode.
 */
export function coerceArgumentsJson(
  argumentsJson: string,
  schema: JsonSchema | undefined,
): { argumentsJson: string; repaired: string[] } {
  if (!schema) return { argumentsJson, repaired: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return { argumentsJson, repaired: [] };
  }
  if (!isPlainObject(parsed)) return { argumentsJson, repaired: [] };
  const result = coerceArgsToSchema(parsed, schema);
  if (result.repaired.length === 0) return { argumentsJson, repaired: [] };
  return { argumentsJson: JSON.stringify(result.args), repaired: result.repaired };
}

/** Minimal shape of an OpenAI-style tool call this module can repair. */
export interface CoercibleToolCall {
  function: { name: string; arguments: string };
}

/**
 * Repair a whole turn's salvaged tool calls in place of the caller
 * hand-rolling the parse/coerce/stringify dance.
 *
 * Providers apply this at the point where the salvage passes merge, so
 * the repaired shape is what gets logged, recorded in history, shown in
 * the UI, and inspected by provider-side heuristics — not just what the
 * bridge happens to send on the wire. The bridge repairs again on the
 * way out; the operation is idempotent.
 *
 * Returns the same array instance when nothing changed.
 */
export function coerceToolCallArgs<T extends CoercibleToolCall>(
  calls: readonly T[],
  schemaFor: (toolName: string) => JsonSchema | undefined,
): { calls: readonly T[]; repaired: Array<{ name: string; paths: string[] }> } {
  const repaired: Array<{ name: string; paths: string[] }> = [];
  if (calls.length === 0) return { calls, repaired };
  const out = calls.map((call) => {
    let result: { argumentsJson: string; repaired: string[] };
    try {
      result = coerceArgumentsJson(call.function.arguments, schemaFor(call.function.name));
    } catch {
      return call;
    }
    if (result.repaired.length === 0) return call;
    repaired.push({ name: call.function.name, paths: result.repaired });
    return {
      ...call,
      function: { ...call.function, arguments: result.argumentsJson },
    };
  });
  return repaired.length === 0 ? { calls, repaired } : { calls: out, repaired };
}

/**
 * True when a validation failure looks like this bug rather than a model
 * mistake: the schema wanted an object/array at `path` and the argument
 * that arrived is a string holding exactly that JSON. Drives the
 * error-message wording so the model is not told to "retry with
 * corrected args" for a call it already got right.
 */
export function looksLikeFlattenedStructuralArg(
  args: Record<string, unknown>,
  path: ReadonlyArray<string | number> | undefined,
  expected: string | undefined,
): boolean {
  if (!path || path.length === 0) return false;
  if (expected !== 'object' && expected !== 'array') return false;
  let node: unknown = args;
  for (const seg of path) {
    if (isPlainObject(node)) node = node[String(seg)];
    else if (Array.isArray(node) && typeof seg === 'number') node = node[seg];
    else return false;
  }
  if (typeof node !== 'string') return false;
  const trimmed = node.trim();
  const opener = expected === 'object' ? '{' : '[';
  if (!trimmed.startsWith(opener)) return false;
  try {
    return jsonTypeOf(JSON.parse(trimmed)) === expected;
  } catch {
    return false;
  }
}
