import * as core from '@bendyline/gezel';
import { ExpectedDeliverableSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { coerceJsonArray, coerceJsonObject, coerceStringArray } from './zod-coerce.js';

// The coercers' behavior is covered beside them in core; this pins that the
// MCP tool schemas use the very same functions, not a drifting copy.
describe('MCP zod coercers', () => {
  it('are the core coercers', () => {
    expect(coerceJsonObject).toBe(core.coerceJsonObject);
    expect(coerceJsonArray).toBe(core.coerceJsonArray);
    expect(coerceStringArray).toBe(core.coerceStringArray);
  });

  it('accept a JSON-stringified expectedDeliverable handoff hint', () => {
    const out = coerceJsonObject(ExpectedDeliverableSchema).parse(
      '{"kind":"file","filePath":"report.md"}',
    );
    expect(out).toEqual({ kind: 'file', filePath: 'report.md' });
  });
});
