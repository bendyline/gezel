import { describe, expect, it } from 'vitest';
import { renderGildeSchemaFiles } from './gilde-schema-export.js';

/**
 * JSON Schema 2020-12 formats that gilde's validator (ajv + ajv-formats)
 * implements. Any other `format` is printed as `unknown format … ignored`
 * on every gilde check and validates nothing.
 */
const AJV_KNOWN_FORMATS = new Set([
  'date-time',
  'date',
  'time',
  'duration',
  'email',
  'hostname',
  'ipv4',
  'ipv6',
  'uri',
  'uri-reference',
  'uri-template',
  'uuid',
  'json-pointer',
  'relative-json-pointer',
  'regex',
]);

function formatsIn(value: unknown, path: string, out: string[]): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((entry, i) => formatsIn(entry, `${path}[${i}]`, out));
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'format' && typeof entry === 'string' && !AJV_KNOWN_FORMATS.has(entry)) {
      out.push(`${path}.format = ${entry}`);
    }
    formatsIn(entry, `${path}.${key}`, out);
  }
}

describe('exported gilde schemas', () => {
  it('use only formats gilde can validate', () => {
    const unknown: string[] = [];
    for (const [filename, content] of renderGildeSchemaFiles()) {
      if (filename.endsWith('.json')) formatsIn(JSON.parse(content), filename, unknown);
    }
    expect(unknown).toEqual([]);
  });
});
