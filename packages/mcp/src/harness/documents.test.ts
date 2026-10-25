import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerHarnessDocumentTools } from './documents.js';
import type { HarnessBinding, HarnessSession } from './session.js';

/**
 * What reaches DocBlocks from an app's call. A stand-in DocBlocks answers
 * `list_roots` and echoes every other call, so these run without the real
 * one; harness.test.ts covers the real round trip where it is installed.
 */

/** The SDK's ESM build, for a script that runs outside this package. */
function sdkUrl(subpath: string): string {
  const cjs = createRequire(import.meta.url).resolve(`@modelcontextprotocol/sdk/${subpath}`);
  return pathToFileURL(cjs.replace(`${sep}cjs${sep}`, `${sep}esm${sep}`)).href;
}

const FAKE_DOCBLOCKS = `
import { Server } from ${JSON.stringify(sdkUrl('server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(sdkUrl('server/stdio.js'))};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkUrl('types.js'))};
const server = new Server({ name: 'fake-docblocks', version: '0.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'list_roots') {
    const roots = [{ id: 'read', write: false }, { id: 'out', write: true }];
    return { content: [{ type: 'text', text: JSON.stringify({ roots }) }] };
  }
  const echo = { args: request.params.arguments, argv: process.argv.slice(2) };
  return { content: [{ type: 'text', text: JSON.stringify(echo) }], structuredContent: { kind: 'ok' } };
});
await server.connect(new StdioServerTransport());
`;

let dir: string;
let folder: string;
let output: string;
let client: Client;
let server: McpServer;
const closers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-harness-documents-'));
  folder = join(dir, 'folder');
  const artifacts = join(dir, 'artifacts');
  output = join(artifacts, 'documents');
  await mkdir(join(folder, 'docs'), { recursive: true });
  const entry = join(dir, 'fake-docblocks.mjs');
  await writeFile(entry, FAKE_DOCBLOCKS);
  const binding = {
    key: 'folder',
    request: {},
    info: {
      project: { id: 'notes', name: 'Notes', workingDir: folder },
      artifactsDir: artifacts,
      documents: { entry },
    },
  } as unknown as HarnessBinding;
  const session = {
    bind: async () => binding,
    onClose: (fn: () => Promise<void>) => closers.push(fn),
  } as unknown as HarnessSession;
  server = new McpServer({ name: 'documents-test', version: '1.0.0' });
  registerHarnessDocumentTools(server, session);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  client = new Client({ name: 'documents-test', version: '1.0.0' });
  await client.connect(clientSide);
}, 30_000);

afterAll(async () => {
  await client?.close();
  await server?.close();
  await Promise.all(closers.map((close) => close()));
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

type Result = Awaited<ReturnType<Client['callTool']>>;

function texts(result: Result): string[] {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '');
}

/** What the stand-in DocBlocks was called with. */
function forwarded(result: Result): { args: Record<string, unknown>; argv: string[] } {
  return JSON.parse(texts(result)[0]!);
}

describe('document tools for an outside app', () => {
  it('starts DocBlocks reading the bound folder and writing only Gezel’s output folder', async () => {
    const result = await client.callTool({
      name: 'convert_document',
      arguments: { source: { kind: 'markdown', markdown: '# Hi' }, targets: ['docx'] },
    });
    expect(result.isError, texts(result).join('\n')).toBeFalsy();
    const { argv } = forwarded(result);
    expect(argv).toEqual(['mcp', '--allow-read', folder, '--allow-write', output]);
  }, 30_000);

  it("turns an app's file path into one inside DocBlocks' read root", async () => {
    const absolute = await client.callTool({
      name: 'convert_document',
      arguments: { source: join(folder, 'docs', 'brief.md'), targets: ['docx'] },
    });
    expect(forwarded(absolute).args.source).toEqual({ kind: 'file', path: 'docs/brief.md' });
    const relative = await client.callTool({
      name: 'inspect_document',
      arguments: { source: { kind: 'file', path: 'docs/brief.md', rootId: 'stale' } },
    });
    expect(forwarded(relative).args.source).toEqual({ kind: 'file', path: 'docs/brief.md' });
    const outside = await client.callTool({
      name: 'convert_document',
      arguments: { source: join(dir, 'elsewhere.md'), targets: ['docx'] },
    });
    expect(outside.isError).toBe(true);
    expect(texts(outside)[0]).toBe(`${join(dir, 'elsewhere.md')} is not inside ${folder}.`);
  }, 30_000);

  it('saves under a file name in Gezel’s folder, numbering a name already taken', async () => {
    const save = (destination: unknown) =>
      client.callTool({
        name: 'save_artifact',
        arguments: { artifactUri: 'docblocks://artifacts/a1', destination },
      });
    const first = await save({ path: 'report.docx' });
    expect(forwarded(first).args.destination).toEqual({
      rootId: 'out',
      path: 'report.docx',
      ifExists: 'error',
      expectedSha256: null,
    });
    expect(texts(first).at(-1)).toContain(`Saved to ${join(output, 'report.docx')}.`);
    // Claude Code shows structuredContent instead of content, which hid that note.
    expect(first.structuredContent).toBeUndefined();

    await writeFile(join(output, 'report.docx'), 'earlier');
    const again = await save({ path: 'report.docx' });
    expect(forwarded(again).args.destination).toMatchObject({ path: 'report (2).docx' });
    expect(texts(again).at(-1)).toContain('already had a report.docx, so this one is named');

    const replaced = await save({ path: 'report.docx', ifExists: 'replace' });
    expect(forwarded(replaced).args.destination).toEqual({
      rootId: 'out',
      path: 'report.docx',
      ifExists: 'replace',
      expectedSha256: createHash('sha256').update('earlier').digest('hex'),
    });

    const elsewhere = await save({ path: join(folder, 'report.docx') });
    expect(elsewhere.isError).toBe(true);
    expect(texts(elsewhere)[0]).toMatch(/^Gezel saves documents in its own folder/);
  }, 30_000);
});
