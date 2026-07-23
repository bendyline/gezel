import { describe, expect, it } from 'vitest';
import { loadBuiltinToolContractsForLint } from './lint-contracts.js';

describe('loadBuiltinToolContractsForLint', () => {
  it('returns the production tools/list JSON Schemas, including conditional tools', async () => {
    const contracts = await loadBuiltinToolContractsForLint();
    const byName = new Map(contracts.map((tool) => [tool.name, tool]));

    expect(byName.has('writeFile')).toBe(true);
    expect(byName.has('draftEmail')).toBe(true);
    expect(byName.has('request_tool_permission')).toBe(true);
    expect(byName.get('set_task_status')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['ref', 'status'],
      properties: {
        status: { enum: ['paused', 'active', 'complete', 'canceled'] },
      },
      additionalProperties: false,
    });
  });
});
