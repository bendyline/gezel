/**
 * Compatibility transforms for llama.cpp's JSON-Schema-to-GBNF converter.
 *
 * Keep these helpers independent from the provider session so the user-side
 * remote bridge can recover when it is talking to an older machine broker.
 */

/**
 * Normalize JSON Schema regexes before llama-server turns tool definitions
 * into a GBNF grammar.
 *
 * JavaScript's `RegExp#source` escapes forward slashes so the source can be
 * embedded in a `/.../` literal (`https:\/\/...`). That escape is
 * semantically identical to a plain `/` in an ECMA-262 pattern, but
 * llama.cpp's JSON-Schema-to-GBNF converter used to copy it into a quoted
 * GBNF terminal where `\/` is not a recognized escape. One otherwise-unused
 * tool could therefore reject the entire request with "failed to parse
 * grammar" before inference began.
 */
export function normalizeJsonSchemaForLlamaCpp(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const normalized = schema.map((entry) => {
      const next = normalizeJsonSchemaForLlamaCpp(entry);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? normalized : schema;
  }
  if (!schema || typeof schema !== 'object') return schema;

  const record = schema as Record<string, unknown>;
  let changed = false;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const next =
      key === 'pattern' && typeof value === 'string'
        ? value.replace(/\\\//g, '/')
        : normalizeJsonSchemaForLlamaCpp(value);
    normalized[key] = next;
    if (next !== value) changed = true;
  }
  return changed ? normalized : schema;
}

/** Last-resort recovery for a server build that still rejects a tool grammar. */
export function stripJsonSchemaPatternsForLlamaCpp(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    let changed = false;
    const stripped = schema.map((entry) => {
      const next = stripJsonSchemaPatternsForLlamaCpp(entry);
      if (next !== entry) changed = true;
      return next;
    });
    return changed ? stripped : schema;
  }
  if (!schema || typeof schema !== 'object') return schema;

  const record = schema as Record<string, unknown>;
  let changed = false;
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === 'pattern' && typeof value === 'string') {
      changed = true;
      continue;
    }
    const next = stripJsonSchemaPatternsForLlamaCpp(value);
    stripped[key] = next;
    if (next !== value) changed = true;
  }
  return changed ? stripped : schema;
}

/**
 * Reduce a tool parameter schema to the structural subset llama.cpp's
 * JSON-Schema-to-GBNF converter handles most reliably.
 *
 * This is a recovery path, not the normal wire shape. It preserves property
 * names, descriptions, primitive/object/array types, required fields, items,
 * and enums. Combinators and validation-only constraints are dropped; the
 * local MCP/Zod execution boundary remains authoritative.
 */
export function simplifyJsonSchemaForLlamaCpp(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => simplifyJsonSchemaForLlamaCpp(entry));
  }
  if (!schema || typeof schema !== 'object') return schema;

  const record = schema as Record<string, unknown>;
  const simplified: Record<string, unknown> = {};

  if (typeof record.type === 'string') simplified.type = record.type;
  if (typeof record.description === 'string') simplified.description = record.description;

  if (
    record.properties &&
    typeof record.properties === 'object' &&
    !Array.isArray(record.properties)
  ) {
    const properties: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(record.properties as Record<string, unknown>)) {
      properties[name] = simplifyJsonSchemaForLlamaCpp(value);
    }
    simplified.properties = properties;

    if (Array.isArray(record.required)) {
      const required = record.required.filter(
        (value): value is string => typeof value === 'string' && value in properties,
      );
      if (required.length > 0) simplified.required = required;
    }
  }

  if ('items' in record) {
    simplified.items = simplifyJsonSchemaForLlamaCpp(record.items);
  }

  if (
    Array.isArray(record.enum) &&
    record.enum.every(
      (value) =>
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean',
    )
  ) {
    simplified.enum = [...record.enum];
  }

  return simplified;
}

export function isLlamaCppGrammarParseError(text: string): boolean {
  return /failed to (?:initialize samplers:[^\r\n]*failed to )?parse grammar/i.test(text);
}

/**
 * Detect the sampler-init failure a server raises for a FORCED tool call
 * (`tool_choice: "required"`) on a model whose vocabulary the eager
 * tool-call grammar cannot be built against.
 *
 * Deliberately disjoint from {@link isLlamaCppGrammarParseError}: that one
 * matches a sampler-init failure whose stated cause is a grammar *parse*
 * error, which the schema-permissiveness ladder can climb out of by sending
 * simpler tool schemas. This one matches the bare form — llama.cpp surfaces
 * it as an untyped `std::exception` with no cause — which no amount of
 * schema simplification fixes, because the payload is not the problem. The
 * only recovery is to stop forcing the tool call, so keeping the two
 * predicates non-overlapping keeps each retry path honest.
 *
 * Wild-caught on Nanbeige4.2-3B: bisected to `tool_choice: "required"`
 * alone. A single-tool request fails while forty tools pass under
 * `"auto"`; a hand-written generic ChatML template fails identically, so it
 * is not the model's embedded template; and qwen3.5-2b on the same binary
 * and flags accepts the same forced request. Because forcing a tool call is
 * how the local-model rescue paths below recover a model that narrates
 * instead of acting, an unhandled rejection here means the *rescue* fails
 * and the turn burns its whole repair allowance — surfacing as a
 * capability verdict (`model-stuck`) for what is an engine-compat fault.
 */
export function isLlamaCppForcedToolChoiceError(text: string): boolean {
  if (isLlamaCppGrammarParseError(text)) return false;
  return /failed to initialize samplers/i.test(text);
}
