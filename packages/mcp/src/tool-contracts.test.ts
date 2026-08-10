import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import {
  ExecutionToolOutputSchema,
  SearchToolOutputSchema,
  annotationsForTool,
  errorResult,
  okResult,
  outputSchemaForTool,
} from './tool-contracts.js';
import { CANONICAL_TOOL_NAMES } from './tool-inventory.js';

describe('tool result helpers', () => {
  it('returns validated structured content with a backwards-compatible text block', () => {
    const result = okResult(SearchToolOutputSchema, {
      summary: 'Found 1 match.',
      query: 'needle',
      matches: [{ path: 'src/a.ts', line: 3, text: 'needle' }],
      count: 1,
      truncated: false,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      summary: 'Found 1 match.',
      query: 'needle',
      matches: [{ path: 'src/a.ts', line: 3, text: 'needle' }],
      count: 1,
      truncated: false,
    });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Found 1 match.'),
    });
  });

  it('rejects handler output that does not satisfy the advertised schema', () => {
    expect(() =>
      okResult(SearchToolOutputSchema, {
        summary: 'Invalid count.',
        matches: [],
        count: -1,
      }),
    ).toThrow();
  });

  it('retains approval metadata needed to continue an execution turn', () => {
    const result = okResult(ExecutionToolOutputSchema, {
      summary: 'npx vitest needs user approval.',
      state: 'approval_pending',
      ok: false,
      questionId: 'question-7',
      resolvedBinPath: 'node_modules/.bin/vitest',
    });

    expect(result.structuredContent).toMatchObject({
      state: 'approval_pending',
      questionId: 'question-7',
      resolvedBinPath: 'node_modules/.bin/vitest',
    });
  });

  it('marks tool-execution failures and includes repair guidance', () => {
    expect(
      errorResult('The path does not exist.', {
        code: 'not_found',
        retryable: true,
        hint: 'Call list_dir and retry with an existing path.',
      }),
    ).toEqual({
      content: [
        {
          type: 'text',
          text: '[not_found] The path does not exist.\nRetryable: true\nNext: Call list_dir and retry with an existing path.',
        },
      ],
      isError: true,
    });
  });

  it('lets the MCP dispatch boundary reject structured output that violates its schema', async () => {
    const server = new McpServer({ name: 'output-validation-test', version: '1.0.0' });
    server.registerTool(
      'broken_search',
      { outputSchema: SearchToolOutputSchema },
      async () =>
        ({
          content: [{ type: 'text', text: 'broken' }],
          structuredContent: { summary: 'Broken.', matches: [], count: -1 },
        }) as never,
    );
    const client = new Client(
      { name: 'output-validation-client', version: '1.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: 'broken_search', arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('Output validation error');
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('tool annotations', () => {
  it('provides all four MCP behavior hints for every canonical tool', () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(annotationsForTool(name), name).toEqual({
        readOnlyHint: expect.any(Boolean),
        destructiveHint: expect.any(Boolean),
        idempotentHint: expect.any(Boolean),
        openWorldHint: expect.any(Boolean),
      });
    }
  });

  it('classifies representative read, destructive, additive, and open-world tools', () => {
    expect(annotationsForTool('grep_files')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsForTool('delete_path')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsForTool('make_dir')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(annotationsForTool('web_search')).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(annotationsForTool('run_git')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(annotationsForTool('insert_at_marker').idempotentHint).toBe(false);
    expect(annotationsForTool('advance_task_step').idempotentHint).toBe(false);
    expect(annotationsForTool('fetch_diff')).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(annotationsForTool('generate_video').destructiveHint).toBe(true);
    expect(annotationsForTool('generate_image').openWorldHint).toBe(true);
    for (const name of ['render_image', 'generate_image', 'extract_archive'] as const) {
      expect(annotationsForTool(name).destructiveHint, name).toBe(true);
    }
  });

  it('uses conservative hints for dynamic project-script tools', () => {
    expect(annotationsForTool('make_release_bundle')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(annotationsForTool('constructor')).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    expect(outputSchemaForTool('constructor')).toBeUndefined();
  });
});
