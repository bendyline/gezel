import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HARNESS_SERVER_INSTRUCTIONS, HarnessClientIdSchema } from '@bendyline/gezel';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { teachInvalidArguments } from './arguments.js';
import { registerHarnessDocumentTools } from './documents.js';
import { registerHarnessIssueTools, registerHarnessPrompts } from './issues.js';
import { type HarnessOptions, HarnessSession } from './session.js';
import { registerHarnessTools } from './tools.js';

export { HarnessSession, HarnessUnavailableError } from './session.js';
export type { HarnessBinding, HarnessOptions } from './session.js';
export { registerHarnessTools } from './tools.js';

const ROOTS_TIMEOUT_MS = 5_000;

function packageVersion(): string {
  try {
    return (
      (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? '0.0.0'
    );
  } catch {
    return '0.0.0';
  }
}

/**
 * `--harness <client> [--project <id>] [--folder <path>]`. A value an MCP
 * client failed to substitute (`${workspaceFolder}` with no folder open) is
 * treated as absent.
 */
export function parseHarnessArgs(argv: readonly string[]): HarnessOptions {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    const raw = at >= 0 ? argv[at + 1] : undefined;
    if (!raw || raw.startsWith('--') || raw.includes('${')) return undefined;
    return raw;
  };
  const client = HarnessClientIdSchema.safeParse(value('--harness'));
  if (!client.success) {
    throw new Error(
      `gezel-mcp: --harness needs one of ${HarnessClientIdSchema.options.join(', ')}.`,
    );
  }
  const projectId = value('--project');
  const folder = value('--folder');
  const home = process.env.GEZEL_HOME;
  return {
    client: client.data,
    ...(projectId ? { projectId } : {}),
    ...(folder ? { folder } : {}),
    ...(home ? { home } : {}),
  };
}

/** An MCP server with the harness profile, not yet connected to a transport. */
export function createHarnessServer(session: HarnessSession): McpServer {
  const server = new McpServer(
    { name: 'gezel', version: packageVersion() },
    { instructions: HARNESS_SERVER_INSTRUCTIONS },
  );
  registerHarnessTools(server, session);
  registerHarnessDocumentTools(server, session);
  registerHarnessIssueTools(server, session);
  registerHarnessPrompts(server, session);
  teachInvalidArguments(server);
  session.setRootsProvider(async () => {
    if (!server.server.getClientCapabilities()?.roots) return null;
    const { roots } = await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
    return roots
      .filter((root) => root.uri.startsWith('file:'))
      .map((root) => fileURLToPath(root.uri));
  });
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
    session.invalidateRoots();
  });
  return server;
}

/** Run the harness profile over stdio until the client disconnects. */
export async function runHarness(argv: readonly string[]): Promise<void> {
  const session = new HarnessSession(parseHarnessArgs(argv));
  const server = createHarnessServer(session);
  const transport = new StdioServerTransport();
  transport.onclose = () => {
    void session.close();
  };
  await server.connect(transport);
}
