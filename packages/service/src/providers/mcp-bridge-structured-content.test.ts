import { describe, expect, it, vi } from 'vitest';
import { MAX_TOOL_EVENT_STRUCTURED_CONTENT_BYTES, McpBridge } from './mcp-bridge.js';

describe('McpBridge structuredContent event safety', () => {
  it('recursively redacts small rich fields and omits an oversized event payload', async () => {
    const bridge = new McpBridge();
    const callTool = vi.fn(async (request: { arguments?: { oversized?: boolean } }) => ({
      content: [{ type: 'text', text: 'structured:ok' }],
      structuredContent: {
        diff: '@@ -1 +1 @@\n-old\n+new',
        addedLines: 1,
        removedLines: 1,
        results: [{ path: 'README.md', status: 'ok' }],
        gezelVideo: { artifactPath: 'clips/demo.mp4', mimeType: 'video/mp4' },
        nested: { authorization: 'Bearer secret-token', values: ['secret-token'] },
        ...(request.arguments?.oversized
          ? { blob: 'x'.repeat(MAX_TOOL_EVENT_STRUCTURED_CONTENT_BYTES + 1) }
          : {}),
      },
    }));
    const mutable = bridge as unknown as {
      client: { callTool: typeof callTool };
      toolNameSet: Set<string>;
    };
    mutable.client = { callTool };
    mutable.toolNameSet = new Set(['structured_event']);
    bridge.knownSecretValues = new Set(['secret-token']);
    const captured: Array<Record<string, unknown> | undefined> = [];
    bridge.onToolCall = (info) => {
      captured.push(info.structuredContent);
    };

    await expect(bridge.callTool('structured_event', {})).resolves.toBe('structured:ok');
    expect(captured[0]).toEqual({
      diff: '@@ -1 +1 @@\n-old\n+new',
      addedLines: 1,
      removedLines: 1,
      results: [{ path: 'README.md', status: 'ok' }],
      gezelVideo: { artifactPath: 'clips/demo.mp4', mimeType: 'video/mp4' },
      nested: { authorization: 'Bearer [REDACTED]', values: ['[REDACTED]'] },
    });
    expect(Buffer.byteLength(JSON.stringify(captured[0]), 'utf8')).toBeLessThanOrEqual(
      MAX_TOOL_EVENT_STRUCTURED_CONTENT_BYTES,
    );

    await expect(bridge.callTool('structured_event', { oversized: true })).resolves.toBe(
      'structured:ok',
    );
    expect(captured[1]).toBeUndefined();
  });
});
