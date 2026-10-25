import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { argumentHelp, missingArguments, teachInvalidArguments } from './arguments.js';

const pages = {
  properties: {
    path: { description: 'Where the file is.' },
    pages: { description: 'Which pages to read' },
    format: {},
  },
  required: ['path', 'pages', 'format'],
};

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

describe('missingArguments', () => {
  it('counts an absent or null argument as missing, and anything else as given', () => {
    expect(missingArguments(pages, { path: 'a.docx', pages: null, format: '' })).toEqual(['pages']);
    expect(missingArguments(pages, undefined)).toEqual(['path', 'pages', 'format']);
    expect(missingArguments({}, { anything: 1 })).toEqual([]);
  });
});

describe('argumentHelp', () => {
  it('names each missing argument with its description', () => {
    expect(argumentHelp('read_pages', pages, { format: 'md' })).toBe(
      '`read_pages` needs `path` (Where the file is) and `pages` (Which pages to read).',
    );
  });

  it("keeps the validator's reason when the arguments are there but wrong", () => {
    const given = { path: 1, pages: 2, format: 3 };
    expect(argumentHelp('read_pages', pages, given, 'expected string')).toBe(
      '`read_pages` could not use those arguments: expected string. It needs `path` (Where the file is), `pages` (Which pages to read) and `format`.',
    );
    expect(argumentHelp('read_pages', { required: [] }, given)).toBe(
      '`read_pages` could not use those arguments: they do not match its schema.',
    );
  });

  it('ends with an example call for a tool models call without its schema', () => {
    expect(argumentHelp('search', { required: ['query'] }, {})).toBe(
      '`search` needs `query`. For example: {"query":"where uploaded files are checked for size"}',
    );
  });
});

describe('teachInvalidArguments', () => {
  it("answers the server's own validation with what the tool needs", async () => {
    const server = new McpServer({ name: 'arguments-test', version: '1.0.0' });
    server.registerTool(
      'lookup',
      { inputSchema: { query: z.string().describe('What to find') } },
      async () => ({ content: [{ type: 'text', text: 'found' }] }),
    );
    teachInvalidArguments(server);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: 'arguments-test', version: '1.0.0' });
    await client.connect(clientSide);
    try {
      const missing = await client.callTool({ name: 'lookup', arguments: {} });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toBe('`lookup` needs `query` (What to find).');
      const wrong = await client.callTool({ name: 'lookup', arguments: { query: 7 } });
      expect(textOf(wrong)).toMatch(/^`lookup` could not use those arguments: .*expected string/);
      expect(textOf(wrong)).not.toContain('MCP error');
      expect(textOf(await client.callTool({ name: 'lookup', arguments: { query: 'x' } }))).toBe(
        'found',
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('passes every other failure through unchanged', async () => {
    const failures = [new Error('disk full'), new McpError(ErrorCode.InternalError, 'crashed')];
    for (const failure of failures) {
      const server = {
        validateToolInput: async () => {
          throw failure;
        },
      };
      teachInvalidArguments(server as unknown as McpServer);
      await expect(server.validateToolInput()).rejects.toBe(failure);
    }
  });
});
