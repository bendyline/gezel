import type { ScriptMeta } from '../schemas/script.js';

/**
 * Validate the stamped output against `meta.outputs` if declared.
 * Coerces but does not aggressively reshape — we want to catch type
 * mismatches that would mislead downstream consumers, not nit-pick.
 */
export function validateScriptOutput(meta: ScriptMeta, value: unknown): unknown {
  if (!meta.outputs) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('script output must be an object when meta.outputs is declared');
  }
  const src = value as Record<string, unknown>;
  for (const [name, spec] of Object.entries(meta.outputs)) {
    const v = src[name];
    if (v === undefined) {
      throw new Error(`output is missing declared field "${name}"`);
    }
    if (v === null) {
      if (spec.type === 'string' || spec.type === 'number' || spec.type === 'boolean') {
        if ((spec as { nullable?: boolean }).nullable) continue;
      }
      if (spec.type === 'json') continue;
      throw new Error(`output field "${name}" is null but type ${spec.type} is not nullable`);
    }
    const expected = expectedTypeOf(v);
    switch (spec.type) {
      case 'string':
        if (typeof v !== 'string') throw typeErr(name, 'string', expected);
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw typeErr(name, 'number', expected);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw typeErr(name, 'boolean', expected);
        break;
      case 'array':
        if (!Array.isArray(v)) throw typeErr(name, 'array', expected);
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) throw typeErr(name, 'object', expected);
        break;
      case 'json':
        break;
    }
  }
  return src;
}

function expectedTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeErr(field: string, expected: string, got: string): Error {
  return new Error(`output field "${field}" must be ${expected}, got ${got}`);
}
