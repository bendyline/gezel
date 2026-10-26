import type { ToolCallEvent } from '@bendyline/gezel-inference/internal/providers/types';
import { describe, expect, it, vi } from 'vitest';
import { McpBridge } from './mcp-bridge.js';

function bridgeWith(tools: string[], opts: { servesGezelMcp?: boolean } = {}) {
  const bridge = new McpBridge();
  const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'ran' }] }));
  const mutable = bridge as unknown as {
    client: { callTool: typeof callTool };
    toolNameSet: Set<string>;
    servesGezelMcp: boolean;
  };
  mutable.client = { callTool };
  mutable.toolNameSet = new Set(tools);
  mutable.servesGezelMcp = opts.servesGezelMcp === true;
  const events: ToolCallEvent[] = [];
  bridge.onToolCall = (info) => {
    events.push(info);
  };
  return { bridge, callTool, events };
}

describe('McpBridge egress indicators', () => {
  it('refuses a third-party call that names a metadata service, before it runs', async () => {
    const { bridge, callTool, events } = bridgeWith(['browser_navigate']);
    const result = await bridge.callToolRich('browser_navigate', {
      url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Blocked by Gezel');
    expect(callTool).not.toHaveBeenCalled();
    expect(events[0]).toMatchObject({
      name: 'browser_navigate',
      success: false,
      egressIndicators: [{ kind: 'cloud-metadata', match: '169.254.169.254' }],
    });
  });

  it('lets an ordinary third-party call through', async () => {
    const { bridge, callTool, events } = bridgeWith(['browser_navigate']);
    const result = await bridge.callToolRich('browser_navigate', { url: 'http://localhost:5173/' });
    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
    expect(events[0]?.egressIndicators).toBeUndefined();
  });

  it('leaves Gezel’s own tools to their sinks, so a report may quote the address', async () => {
    const { bridge, callTool } = bridgeWith(['write_artifact'], { servesGezelMcp: true });
    const result = await bridge.callToolRich('write_artifact', {
      path: 'reports/ssrf.md',
      content: 'The fetch can reach http://169.254.169.254/ — block link-local targets.',
    });
    expect(result.isError).toBe(false);
    expect(callTool).toHaveBeenCalledOnce();
  });
});
