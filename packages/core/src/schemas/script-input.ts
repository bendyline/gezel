import type { ScriptInputField, ScriptInputs, ScriptMeta } from './script.js';

export class ScriptInputError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = 'ScriptInputError';
  }
}

/**
 * Normalize raw input against a script's declared `meta.inputs`. Applies
 * defaults, enforces `required`, validates `pattern` / `min` / `max`,
 * and rejects values that don't match the declared type. Returns the
 * validated input object — the exact shape the script sees as
 * `gezel.input`.
 */
export function validateScriptInput(
  meta: ScriptMeta,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const inputs: ScriptInputs = meta.inputs ?? {};
  const source = raw ?? {};
  const out: Record<string, unknown> = {};

  for (const [name, spec] of Object.entries(inputs)) {
    const hasValue =
      Object.prototype.hasOwnProperty.call(source, name) && source[name] !== undefined;
    if (hasValue) {
      out[name] = validateField(name, spec, source[name]);
      continue;
    }
    const defaultValue = specDefault(spec);
    if (defaultValue !== undefined) {
      out[name] = defaultValue;
      continue;
    }
    if (spec.required) {
      throw new ScriptInputError(`input "${name}" is required`, name);
    }
  }

  for (const key of Object.keys(source)) {
    if (!(key in inputs)) {
      throw new ScriptInputError(`unknown input "${key}"`, key);
    }
  }

  return out;
}

function validateField(name: string, spec: ScriptInputField, value: unknown): unknown {
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') {
        throw new ScriptInputError(`"${name}" must be a string, got ${typeOf(value)}`, name);
      }
      if (spec.pattern && !new RegExp(spec.pattern).test(value)) {
        throw new ScriptInputError(`"${name}" does not match pattern ${spec.pattern}`, name);
      }
      return value;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ScriptInputError(`"${name}" must be a finite number, got ${typeOf(value)}`, name);
      }
      if (spec.integer && !Number.isInteger(value)) {
        throw new ScriptInputError(`"${name}" must be an integer`, name);
      }
      if (spec.min !== undefined && value < spec.min) {
        throw new ScriptInputError(`"${name}" must be >= ${spec.min}`, name);
      }
      if (spec.max !== undefined && value > spec.max) {
        throw new ScriptInputError(`"${name}" must be <= ${spec.max}`, name);
      }
      return value;
    }
    case 'boolean': {
      if (typeof value !== 'boolean') {
        throw new ScriptInputError(`"${name}" must be boolean, got ${typeOf(value)}`, name);
      }
      return value;
    }
    case 'choice': {
      if (typeof value !== 'string') {
        throw new ScriptInputError(`"${name}" must be one of the choice values`, name);
      }
      if (!spec.options.some((o) => o.value === value)) {
        const allowed = spec.options.map((o) => o.value).join(', ');
        throw new ScriptInputError(`"${name}" must be one of: ${allowed}`, name);
      }
      return value;
    }
    case 'ref': {
      if (typeof value !== 'string' || value.length === 0) {
        throw new ScriptInputError(`"${name}" must be a non-empty ref string`, name);
      }
      return value;
    }
    case 'json': {
      return value;
    }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function specDefault(spec: ScriptInputField): unknown {
  switch (spec.type) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'choice':
    case 'json':
      return spec.default;
    case 'ref':
      return undefined;
  }
}
