import { describe, expect, it } from 'vitest';
import { portableToolInputSchema } from '../runtime/product-tools.js';
import { TOOL_DESCRIPTIONS } from './descriptions.js';
import { TOOL_CALL_FIXTURES } from './tool-call-fixtures.js';

describe('shared tool input schemas', () => {
  it.each(TOOL_CALL_FIXTURES.map((f) => [`${f.tool} ${f.expect}`, f] as const))(
    '%s',
    (_n, fixture) => {
      const schema = portableToolInputSchema(fixture.tool);
      expect(schema, fixture.tool).toBeDefined();
      expect(schema!.safeParse(fixture.args).success).toBe(fixture.expect === 'accept');
    },
  );

  it('describes every tool in one sentence', () => {
    for (const [name, text] of Object.entries(TOOL_DESCRIPTIONS)) {
      expect(text.length, name).toBeGreaterThan(10);
      expect(portableToolInputSchema(name), name).toBeDefined();
    }
  });
});
