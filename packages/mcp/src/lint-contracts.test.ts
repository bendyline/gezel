import { describe, expect, it } from 'vitest';
import { loadBuiltinToolContractsForLint } from './lint-contracts.js';

describe('loadBuiltinToolContractsForLint', () => {
  it('returns the production tools/list JSON Schemas, including conditional tools', async () => {
    const contracts = await loadBuiltinToolContractsForLint();
    const byName = new Map(contracts.map((tool) => [tool.name, tool]));

    expect(byName.has('write_file')).toBe(true);
    expect(byName.has('draft_email')).toBe(true);
    expect(byName.has('request_tool_permission')).toBe(true);
    expect(byName.has('craftbook_update_step')).toBe(true);
    expect(byName.has('craftbook_create')).toBe(false);
    expect(byName.has('craftbook_replace')).toBe(false);
    expect(byName.has('list_project_local_gezels')).toBe(false);
    expect(byName.has('create_gezel_from_gilde')).toBe(false);
    expect(byName.get('create_gezel')?.inputSchema).toMatchObject({
      properties: { templateId: { type: 'string' } },
    });
    expect(
      (byName.get('create_gezel')?.inputSchema.required as string[] | undefined) ?? [],
    ).not.toContain('role');
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
