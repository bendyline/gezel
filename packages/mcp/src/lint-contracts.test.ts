import { describe, expect, it } from 'vitest';
import { loadBuiltinToolContractsForLint } from './lint-contracts.js';

describe('loadBuiltinToolContractsForLint', () => {
  // Loads the full server module and completes an MCP handshake in-process.
  // ~1.5s alone, but it runs alongside inventory.test.ts's subprocess fan-out,
  // where contention pushes it past the 5s default.
  it('returns the production tools/list JSON Schemas, including conditional tools', async () => {
    const contracts = await loadBuiltinToolContractsForLint();
    const byName = new Map(contracts.map((tool) => [tool.name, tool]));

    expect(byName.has('write_file')).toBe(true);
    expect(byName.has('draft_email')).toBe(true);
    expect(byName.has('draft_connector_action')).toBe(true);
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

    for (const tool of contracts) {
      expect(tool.annotations, `${tool.name} annotations`).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }

    for (const name of [
      'search_memory',
      'grep_files',
      'list_dir',
      'stat',
      'get_task',
      'set_task_status',
      'run_nodejs_script',
      'run_playwright_script',
      'run_git',
      'draft_email',
      'draft_connector_action',
    ]) {
      expect(byName.get(name)?.outputSchema, `${name} output schema`).toMatchObject({
        type: 'object',
      });
    }
    expect(byName.get('grep_files')?.outputSchema).toMatchObject({
      required: ['summary', 'matches', 'count'],
      properties: {
        summary: { type: 'string' },
        matches: { type: 'array' },
        count: { type: 'integer', minimum: 0 },
      },
    });
    expect(byName.get('run_git')?.outputSchema).toMatchObject({
      required: ['summary', 'state', 'ok', 'command', 'args'],
    });
  }, 30_000);
});
