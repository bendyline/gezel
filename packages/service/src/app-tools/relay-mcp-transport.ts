import { APP_TOOL_MAX_RESULT_CHARS, createLogger } from '@bendyline/gezel';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/index.js';
import type { AppToolBinding, AppToolRelayRegistry } from './relay-registry.js';

const log = createLogger('app-tools');

export interface AppToolRelaySessionRef {
  sessionId: string;
  gezelId: string;
  projectId: string;
}

export interface CreateAppToolRelayTransportOptions {
  registry: AppToolRelayRegistry;
  binding: AppToolBinding;
  session: AppToolRelaySessionRef;
}

/**
 * Serve one app's registered tools as an MCP server inside this process, and
 * hand back the client half of a linked transport pair.
 *
 * The daemon is both ends here, which is the point: the bridge keeps its whole
 * contract (timeouts, output caps, redaction, argument coercion, the `tool`
 * chat event, history) without the app having to implement an MCP server or
 * open a port. What the app implements is a handler.
 */
export function createAppToolRelayTransport(opts: CreateAppToolRelayTransportOptions): Transport {
  const { registry, binding, session } = opts;
  const validators = compileValidators(binding);
  const server = new Server(
    { name: `gezel-app-tools:${binding.appId}`, version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: binding.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as { type: 'object' },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const declared = binding.tools.find((tool) => tool.name === request.params.name);
    if (!declared) {
      // The pool only routes names this server listed, so this is a
      // registration that changed under a live turn rather than a bad call.
      return errorResult(`"${request.params.name}" is no longer offered by ${binding.appId}`);
    }
    // Validate before the call leaves the daemon. A rejected call comes back
    // as a tool error the model can act on, which is the difference between
    // "fix your arguments" and an app handler defending itself against every
    // shape a model might send.
    const validate = validators.get(declared.name);
    if (validate) {
      const verdict = validate(request.params.arguments ?? {});
      if (!verdict.valid) {
        return errorResult(`invalid arguments for ${declared.name}: ${verdict.errorMessage}`);
      }
    }
    const result = await registry.invoke(binding, {
      tool: declared.name,
      args: (request.params.arguments ?? {}) as Record<string, unknown>,
      sessionId: session.sessionId,
      gezelId: session.gezelId,
      projectId: session.projectId,
      ...(declared.timeoutMs === undefined ? {} : { timeoutMs: declared.timeoutMs }),
      ...(extra?.signal ? { signal: extra.signal } : {}),
    });
    if (!result.ok) return errorResult(result.error);
    return {
      content: toContentBlocks(result.content),
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    };
  });

  const [clientHalf, serverHalf] = InMemoryTransport.createLinkedPair();
  // The pair queues until both ends start, so connecting the server without
  // awaiting it here cannot lose the client's first request.
  void server.connect(serverHalf).catch((err: unknown) => {
    log.warn(
      `[app-tools] in-memory server for ${binding.appId} failed to start:`,
      err instanceof Error ? err.message : err,
    );
  });
  return clientHalf;
}

/**
 * A failed app tool is reported to the model as a tool error, never as a
 * transport fault: the turn should continue with the model knowing the call
 * did not work, the same as any other tool that returns an error.
 */
function errorResult(message: string): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function toContentBlocks(
  content:
    | string
    | Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  if (typeof content === 'string') return [{ type: 'text', text: cap(content) }];
  return content.map((block) =>
    block.type === 'text' ? { type: 'text' as const, text: cap(block.text) } : block,
  );
}

/**
 * Second line of defence behind the route's own limit. The bridge caps tool
 * output again on the way to the model; capping here keeps a single oversized
 * block from being assembled in the first place.
 */
function cap(text: string): string {
  if (text.length <= APP_TOOL_MAX_RESULT_CHARS) return text;
  return `${text.slice(0, APP_TOOL_MAX_RESULT_CHARS)}\n… [truncated]`;
}

/**
 * Compile one validator per declared tool. A schema Ajv refuses to compile
 * leaves that tool unvalidated rather than unusable: the app declared it, the
 * app can still defend itself, and a registration that passed the route's own
 * schema check should not become a dead tool here.
 */
function compileValidators(
  binding: AppToolBinding,
): Map<string, (input: unknown) => { valid: boolean; errorMessage?: string }> {
  const provider = new AjvJsonSchemaValidator();
  const validators = new Map<
    string,
    (input: unknown) => { valid: boolean; errorMessage?: string }
  >();
  for (const tool of binding.tools) {
    try {
      validators.set(tool.name, provider.getValidator(tool.inputSchema as JsonSchemaType));
    } catch (err) {
      log.warn(
        `[app-tools] ${binding.appId} tool ${tool.name} has an uncompilable inputSchema; arguments will not be validated:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return validators;
}

/**
 * Test helper: an MCP client speaking to one relay binding through the same
 * transport a real session would get.
 */
export async function connectAppToolClientForTest(
  opts: CreateAppToolRelayTransportOptions,
): Promise<Client> {
  const client = new Client({ name: 'app-tools-test', version: '1.0.0' }, { capabilities: {} });
  await client.connect(createAppToolRelayTransport(opts));
  return client;
}
