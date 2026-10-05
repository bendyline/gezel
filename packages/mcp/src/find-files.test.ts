import { FILE_GLOB_MAX_LENGTH } from '@bendyline/gezel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(
    async () =>
      new Response(JSON.stringify({ files: [], truncated: false }), {
        headers: { 'content-type': 'application/json' },
      }),
  ),
}));
vi.mock('@bendyline/gezel-client/node', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bendyline/gezel-client/node')>()),
  createPatientFetch: () => apiFetch,
}));
let client: Client;
let server: typeof import('./server.js')['server'];

beforeAll(async () => {
  vi.stubGlobal('fetch', apiFetch);
  for (const [key, value] of Object.entries({
    GEZEL_MCP_NO_MAIN: '1',
    GEZEL_BASE_URL: 'http://127.0.0.1:0',
    GEZEL_TOKEN: 'test-token',
    GEZEL_AGENT_ID: 'test-agent',
    GEZEL_PROJECT_ID: 'test-project',
    GEZEL_SESSION_ID: 'test-session',
  }))
    vi.stubEnv(key, value);
  server = (await import('./server.js')).server;
  client = new Client({ name: 'find-files-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('find_files MCP boundary', () => {
  it('advertises the shared length and result limits', async () => {
    const tools = await client.listTools();
    const input = tools.tools.find((tool) => tool.name === 'find_files')?.inputSchema;
    expect(input?.properties?.glob).toMatchObject({ maxLength: FILE_GLOB_MAX_LENGTH });
    expect(input?.properties?.maxResults).toMatchObject({ maximum: 5000 });
  });

  it.each([
    `${'{'.repeat(4999)}x${'}'.repeat(4999)}`,
    `${'{'.repeat(9)}x${'}'.repeat(9)}`,
    '{a,b}'.repeat(30),
    '{1..1000000000}',
    '{"}"'.repeat(9) + '"{"}'.repeat(9),
  ])('rejects unsafe input before calling the daemon', async (glob) => {
    apiFetch.mockClear();
    const result = await client.callTool({ name: 'find_files', arguments: { glob } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('glob');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('continues forwarding ordinary globs', async () => {
    apiFetch.mockClear();
    const result = await client.callTool({
      name: 'find_files',
      arguments: { glob: '**/*.{ts,tsx}' },
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expect(apiFetch).toHaveBeenCalledOnce();
  });
});
