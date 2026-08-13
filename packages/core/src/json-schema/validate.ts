/**
 * Minimal JSON-Schema subset validator.
 *
 * Purpose-built for validating declared tool inputs (project-type
 * `tools[].inputs`, page-invoke bodies) without pulling a schema library
 * into the workspace. Deliberately permissive: keywords outside the
 * supported subset are ignored, so an authored schema can only *narrow*
 * over time. The supported subset:
 *
 *   type (string|number|integer|boolean|object|array|null, or array of),
 *   properties, required, additionalProperties (boolean only),
 *   enum, const, items (single schema),
 *   minimum, maximum, exclusiveMinimum, exclusiveMaximum,
 *   minLength, maxLength, pattern, minItems, maxItems
 *
 * Mirrors the schema-walking (not schema-compiling) approach of
 * providers/tool-arg-schema-coercion.ts on the service side.
 */

export interface JsonSchemaViolation {
  /** JSON-pointer-ish path to the offending value ('' = root). */
  path: string;
  message: string;
}

type Schema = Record<string, unknown>;

const TYPE_NAMES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, t: string): boolean {
  switch (t) {
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeOf(value) === 'object';
    default:
      return typeOf(value) === t;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeOf(a) === 'object' && a && b) {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function describe(value: unknown): string {
  const t = typeOf(value);
  if (t === 'string') {
    const s = value as string;
    return `string ${JSON.stringify(s.length > 24 ? `${s.slice(0, 24)}…` : s)}`;
  }
  return t;
}

function validateAt(
  value: unknown,
  schema: unknown,
  path: string,
  out: JsonSchemaViolation[],
  depth: number,
): void {
  // Depth fence: authored schemas are shallow; a cyclic/hostile one must not recurse away.
  if (depth > 32) return;
  if (schema === true || schema == null) return;
  if (schema === false) {
    out.push({ path, message: 'no value permitted (schema is false)' });
    return;
  }
  if (typeOf(schema) !== 'object') return;
  const s = schema as Schema;

  const declaredType = s.type;
  if (typeof declaredType === 'string' || Array.isArray(declaredType)) {
    const candidates = (Array.isArray(declaredType) ? declaredType : [declaredType]).filter(
      (t): t is string => typeof t === 'string' && TYPE_NAMES.has(t),
    );
    if (candidates.length > 0 && !candidates.some((t) => matchesType(value, t))) {
      out.push({
        path,
        message: `expected ${candidates.join(' | ')}, got ${describe(value)}`,
      });
      return; // type mismatch makes the remaining keyword checks noise
    }
  }

  if (Array.isArray(s.enum) && s.enum.length > 0) {
    if (!s.enum.some((candidate) => deepEqual(candidate, value))) {
      out.push({
        path,
        message: `expected one of ${s.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      });
      return;
    }
  }
  if ('const' in s && !deepEqual(s.const, value)) {
    out.push({ path, message: `expected ${JSON.stringify(s.const)}` });
    return;
  }

  if (typeof value === 'string') {
    if (typeof s.minLength === 'number' && value.length < s.minLength) {
      out.push({ path, message: `shorter than minLength ${s.minLength}` });
    }
    if (typeof s.maxLength === 'number' && value.length > s.maxLength) {
      out.push({ path, message: `longer than maxLength ${s.maxLength}` });
    }
    if (typeof s.pattern === 'string') {
      try {
        if (!new RegExp(s.pattern).test(value)) {
          out.push({ path, message: `does not match pattern ${s.pattern}` });
        }
      } catch {
        // Malformed authored pattern: ignore, never reject on our own bug.
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof s.minimum === 'number' && value < s.minimum) {
      out.push({ path, message: `below minimum ${s.minimum}` });
    }
    if (typeof s.maximum === 'number' && value > s.maximum) {
      out.push({ path, message: `above maximum ${s.maximum}` });
    }
    if (typeof s.exclusiveMinimum === 'number' && value <= s.exclusiveMinimum) {
      out.push({ path, message: `not above exclusiveMinimum ${s.exclusiveMinimum}` });
    }
    if (typeof s.exclusiveMaximum === 'number' && value >= s.exclusiveMaximum) {
      out.push({ path, message: `not below exclusiveMaximum ${s.exclusiveMaximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof s.minItems === 'number' && value.length < s.minItems) {
      out.push({ path, message: `fewer than minItems ${s.minItems}` });
    }
    if (typeof s.maxItems === 'number' && value.length > s.maxItems) {
      out.push({ path, message: `more than maxItems ${s.maxItems}` });
    }
    if (s.items != null && !Array.isArray(s.items)) {
      value.forEach((item, i) => validateAt(item, s.items, `${path}/${i}`, out, depth + 1));
    }
  }

  if (typeOf(value) === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const properties =
      typeOf(s.properties) === 'object' ? (s.properties as Record<string, unknown>) : undefined;

    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === 'string' && !(key in record)) {
          out.push({ path, message: `missing required property '${key}'` });
        }
      }
    }
    if (properties) {
      for (const [key, propSchema] of Object.entries(properties)) {
        if (key in record) {
          validateAt(record[key], propSchema, `${path}/${key}`, out, depth + 1);
        }
      }
    }
    if (s.additionalProperties === false && properties) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) {
          out.push({ path, message: `unexpected property '${key}'` });
        }
      }
    }
  }
}

/**
 * Validate `value` against the schema subset. Returns violations; empty
 * array means valid. A non-object/malformed schema validates everything
 * (permissive by design — authored schemas only narrow).
 */
export function validateJsonSchema(value: unknown, schema: unknown): JsonSchemaViolation[] {
  const out: JsonSchemaViolation[] = [];
  validateAt(value, schema, '', out, 0);
  return out;
}

/** One-line human summary for error payloads (first few violations). */
export function formatJsonSchemaViolations(violations: JsonSchemaViolation[]): string {
  return violations
    .slice(0, 4)
    .map((v) => (v.path ? `${v.path}: ${v.message}` : v.message))
    .join('; ');
}
