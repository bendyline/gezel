export interface BuiltinToolContract {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

let builtinToolContractsPromise: Promise<BuiltinToolContract[]> | undefined;

/**
 * Return the exact JSON Schemas exposed by the built-in MCP server's
 * `tools/list` response. This lint-only entry point is deliberately separate
 * from the ordinary inventory export so production sessions do not load MCP
 * client or schema-inspection code.
 */
export function loadBuiltinToolContractsForLint(): Promise<BuiltinToolContract[]> {
  builtinToolContractsPromise ??= loadBuiltinToolContracts();
  return builtinToolContractsPromise;
}

async function loadBuiltinToolContracts(): Promise<BuiltinToolContract[]> {
  const envKeys = [
    'GEZEL_MCP_NO_MAIN',
    'GEZEL_MCP_SCHEMA_LINT',
    'GEZEL_MCP_ALLOW',
    'GEZEL_MCP_EXCLUDE',
    'GEZEL_MCP_LEGACY_TOOLS',
    'GEZEL_CRAFTBOOK_ID',
    'GEZEL_MAIL_ENABLED',
    'GEZEL_CONNECTORS_ENABLED',
    'GEZEL_PERMISSION_PROMPT',
  ] as const;
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  process.env.GEZEL_MCP_NO_MAIN = '1';
  process.env.GEZEL_MCP_SCHEMA_LINT = '1';
  delete process.env.GEZEL_MCP_ALLOW;
  delete process.env.GEZEL_MCP_EXCLUDE;
  delete process.env.GEZEL_MCP_LEGACY_TOOLS;
  // Include the contextual surgical schema in the contract corpus even
  // though ordinary sessions do not advertise it.
  process.env.GEZEL_CRAFTBOOK_ID = 'schema-lint-craftbook';
  process.env.GEZEL_MAIL_ENABLED = '1';
  process.env.GEZEL_CONNECTORS_ENABLED = '1';
  process.env.GEZEL_PERMISSION_PROMPT = '1';

  try {
    const serverModulePath = './server.js';
    const [{ Client }, { InMemoryTransport }, { server }] = await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js'),
      import(serverModulePath),
    ]);
    const client = new Client(
      { name: 'gezel-prompt-schema-linter', version: '1.0.0' },
      { capabilities: {} },
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listing = await client.listTools();
      return listing.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as Record<string, unknown>,
      }));
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  } finally {
    for (const key of envKeys) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
