/**
 * Minimal JSON-Schema-subset validation for connector binding config. Covers
 * exactly what the bundled connector-type `configSchema`s use — `type`,
 * `properties`, `required`, `const`, `enum`, `items` — and deliberately
 * ignores every other keyword rather than failing on it: the gate exists to
 * catch a missing repository or a mistyped field at bind time (a clear 400)
 * instead of a sync-time `lastError` days later, not to be a full validator.
 */

export interface ConfigSchema {
  type?: string;
  properties?: Record<string, ConfigSchema>;
  required?: string[];
  const?: unknown;
  enum?: unknown[];
  items?: ConfigSchema;
  title?: string;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function typeMatches(declared: string, actual: string): boolean {
  if (declared === actual) return true;
  return declared === 'number' && actual === 'integer';
}

function validateValue(schema: ConfigSchema, value: unknown, path: string, errors: string[]): void {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${path}: must be ${JSON.stringify(schema.const)}`);
    return;
  }
  if (schema.enum && !schema.enum.some((v) => v === value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`);
    return;
  }
  if (schema.type && !typeMatches(schema.type, typeOf(value))) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return;
  }
  if (schema.type === 'object' || schema.properties) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      const present = key in obj && obj[key] !== undefined && obj[key] !== null && obj[key] !== '';
      if (!present) {
        const title = schema.properties?.[key]?.title;
        errors.push(`${path ? `${path}.` : ''}${key}: required${title ? ` (${title})` : ''}`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[key] !== undefined) {
        validateValue(sub, obj[key], path ? `${path}.${key}` : key, errors);
      }
    }
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => validateValue(schema.items!, item, `${path}[${i}]`, errors));
  }
}

/** Validate a binding config against a type's `configSchema`. [] = valid. */
export function validateConnectorConfig(
  configSchema: Record<string, unknown> | undefined,
  config: Record<string, unknown>,
): string[] {
  if (!configSchema) return [];
  const errors: string[] = [];
  validateValue(configSchema as ConfigSchema, config, '', errors);
  return errors;
}
