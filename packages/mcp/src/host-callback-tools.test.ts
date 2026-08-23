/**
 * Host-harness callbacks must accept arguments gezel did not declare.
 *
 * `request_tool_permission` is called by Claude Code, not by a model, and
 * its payload is the CLI's to change. Registration used to close every tool
 * schema with `z.strictObject`, so when the CLI started stamping a
 * `tool_use_id` on the request, the server answered `-32602` — and because
 * every tool outside `--allowedTools` routes through this callback, that
 * one rejected key silently disabled every third-party toolset for the
 * whole `anthropic-cli` provider while auto-approved gezel-mcp tools kept
 * working.
 *
 * These tests pin both halves of the rule: the callback tolerates unknown
 * keys, and the model-facing surface stays closed.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface InspectableServer {
  _registeredTools: Record<string, { description?: string }>;
  server: {
    _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
  };
}

async function loadServer(): Promise<InspectableServer> {
  for (const [k, v] of Object.entries({
    GEZEL_MCP_NO_MAIN: '1',
    GEZEL_PERMISSION_PROMPT: '1',
    // Port 1 refuses immediately, so a call that clears validation fails
    // fast in the HTTP back-channel instead of waiting on a real daemon.
    GEZEL_BASE_URL: 'http://127.0.0.1:1',
    GEZEL_TOKEN: 'test-token',
    GEZEL_AGENT_ID: 'test-agent',
    GEZEL_PROJECT_ID: 'test-project',
    GEZEL_SESSION_ID: 'test-session',
    GEZEL_HOME: '/tmp/gezel-mcp-test',
  })) {
    vi.stubEnv(k, v);
  }
  vi.resetModules();
  const mod = await import('./server.js');
  return mod.server as unknown as InspectableServer;
}

async function callTool(
  server: InspectableServer,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const handler = server.server._requestHandlers.get('tools/call');
  expect(handler, 'tools/call handler installed').toBeDefined();
  const result = (await handler!(
    { method: 'tools/call', params: { name, arguments: args } },
    {},
  )) as { content?: Array<{ text?: string }> };
  return (result.content ?? []).map((c) => c.text ?? '').join(' ');
}

describe('host-harness callback tools', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts the CLI tool_use_id and any key a newer CLI adds', async () => {
    const server = await loadServer();
    const text = await callTool(server, 'request_tool_permission', {
      tool_name: 'mcp__docblocks__convert_document',
      input: { source: { kind: 'markdown', text: '# Deck' } },
      tool_use_id: 'toolu_01ABC',
      some_field_a_future_cli_adds: { nested: true },
    });

    expect(text).not.toContain('-32602');
    expect(text).not.toContain('unrecognized_keys');
    // Validation cleared, so we reached the handler and it reported the
    // refused back-channel as a deny verdict in the CLI's own shape.
    expect(JSON.parse(text)).toMatchObject({ behavior: 'deny' });
  }, 30_000);

  it('tolerates a request with no input object at all', async () => {
    const server = await loadServer();
    const text = await callTool(server, 'request_tool_permission', {
      tool_name: 'mcp__docblocks__list_roots',
    });

    expect(text).not.toContain('unrecognized_keys');
    expect(JSON.parse(text)).toMatchObject({ behavior: 'deny' });
  }, 30_000);

  it('still rejects an undeclared argument on a model-facing tool', async () => {
    const server = await loadServer();
    const text = await callTool(server, 'set_task_status', {
      ref: 'default/11',
      status: 'active',
      hallucinated_argument: 1,
    });

    expect(text).toContain('unrecognized_keys');
    expect(text).toContain('hallucinated_argument');
  }, 30_000);
});
