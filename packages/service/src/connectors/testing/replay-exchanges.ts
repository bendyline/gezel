/**
 * Answer a connector type's network calls from the recorded or hand-written
 * exchanges in its contract sidecar (`ConnectorTypeTestSpec`), with no
 * network: an HTTP `fetch` for script fetches and native adapters, and an
 * in-memory MCP server for `mcp` types. Every request is kept; one nothing
 * answers fails loudly, and an answer never used is reported so a case
 * cannot quietly test less than it says.
 */

import type { ConnectorTestExchange } from '@bendyline/gezel';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerSpec } from '../../providers/mcp-bridge.js';

type HttpExchange = Extract<ConnectorTestExchange, { kind: 'http' }>;
type ToolExchange = Extract<ConnectorTestExchange, { kind: 'mcp-tool' }>;

export interface ExchangeReplay {
  /** A `fetch` answering the case's HTTP exchanges. */
  fetch: typeof fetch;
  /** An in-memory MCP server answering the case's tool exchanges, in place of any spec. */
  mcpServer: () => McpServerSpec;
  /** Every request made, as `METHOD url` or `tool name(args)`. */
  requests: string[];
  /** Origins of every HTTP request. */
  origins: Set<string>;
  /** Requests no exchange answered. */
  unmatched: string[];
  /** Exchanges with answers left over. */
  unused(): string[];
}

function matches(ex: HttpExchange, method: string, url: URL): boolean {
  if ((ex.request.method ?? 'GET').toUpperCase() !== method.toUpperCase()) return false;
  const want = new URL(ex.request.url);
  if (want.origin !== url.origin || want.pathname !== url.pathname) return false;
  for (const [key, value] of want.searchParams) {
    if (url.searchParams.get(key) !== value) return false;
  }
  return true;
}

function responseFor(ex: HttpExchange): Response {
  const body = ex.response.body;
  const text = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
  const headers = new Headers(ex.response.headers ?? {});
  if (text !== null && typeof body !== 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return new Response(text, { status: ex.response.status ?? 200, headers });
}

export function replayExchanges(exchanges: readonly ConnectorTestExchange[]): ExchangeReplay {
  const left = exchanges.map((ex) => ({ ex, remaining: ex.times ?? 1 }));
  const requests: string[] = [];
  const origins = new Set<string>();
  const unmatched: string[] = [];

  const take = (pick: (ex: ConnectorTestExchange) => boolean) => {
    const slot = left.find((s) => s.remaining > 0 && pick(s.ex));
    if (!slot) return undefined;
    slot.remaining--;
    return slot.ex;
  };

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push(`${method} ${url.href}`);
    origins.add(url.origin);
    const ex = take((e) => e.kind === 'http' && matches(e, method, url)) as
      | HttpExchange
      | undefined;
    if (!ex) {
      unmatched.push(`${method} ${url.href}`);
      throw new Error(`no recorded answer for ${method} ${url.href}`);
    }
    return responseFor(ex);
  };

  const mcpServer = (): McpServerSpec => ({
    kind: 'in-memory',
    label: 'contract-replay',
    connect: () => {
      const server = new Server(
        { name: 'contract-replay', version: '1.0.0' },
        { capabilities: { tools: {} } },
      );
      const toolNames = [
        ...new Set(
          exchanges.filter((e) => e.kind === 'mcp-tool').map((e) => (e as ToolExchange).tool),
        ),
      ];
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: toolNames.map((name) => ({
          name,
          description: `replayed ${name}`,
          inputSchema: { type: 'object' as const, additionalProperties: true },
        })),
      }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        requests.push(`tool ${name}(${JSON.stringify(request.params.arguments ?? {})})`);
        const args = (request.params.arguments ?? {}) as Record<string, unknown>;
        const ex = take(
          (e) =>
            e.kind === 'mcp-tool' &&
            e.tool === name &&
            Object.entries(e.args ?? {}).every(
              ([k, v]) => JSON.stringify(args[k]) === JSON.stringify(v),
            ),
        ) as ToolExchange | undefined;
        if (!ex) {
          unmatched.push(`tool ${name}`);
          return {
            isError: true,
            content: [{ type: 'text', text: `no recorded answer for ${name}` }],
          };
        }
        const text = typeof ex.result === 'string' ? ex.result : JSON.stringify(ex.result);
        return { ...(ex.isError ? { isError: true } : {}), content: [{ type: 'text', text }] };
      });
      const [client, serverHalf] = InMemoryTransport.createLinkedPair();
      void server.connect(serverHalf);
      return client;
    },
  });

  return {
    fetch: fetchImpl,
    mcpServer,
    requests,
    origins,
    unmatched,
    unused: () =>
      left
        .filter((s) => s.remaining > 0)
        .map((s) =>
          s.ex.kind === 'http'
            ? `${s.ex.request.method ?? 'GET'} ${s.ex.request.url}`
            : `tool ${s.ex.tool}`,
        ),
  };
}
