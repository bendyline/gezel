import type { AppToolRelayEvent } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  buildTransport,
  describeSpec,
  isInMemorySpec,
  isStdioSpec,
} from '../providers/mcp-bridge.js';
import { connectAppToolClientForTest, createAppToolRelayTransport } from './relay-mcp-transport.js';
import { AppToolRelayRegistry, type AppToolRelayStreamSink } from './relay-registry.js';

const TOOL = {
  name: 'add_travel_points',
  description: 'Award travel points to the traveller.',
  inputSchema: {
    type: 'object',
    properties: { points: { type: 'number' }, reason: { type: 'string' } },
    required: ['points'],
  },
};

/** A stand-in for the connected app: answers each call with `respond`. */
function appStream(
  registry: AppToolRelayRegistry,
  relayId: string,
  respond: (call: Extract<AppToolRelayEvent, { type: 'tool_call' }>) => void,
): AppToolRelayStreamSink {
  return {
    write(event) {
      if (event.type === 'tool_call') queueMicrotask(() => respond(event));
    },
  };
}

function setup(respond: (call: Extract<AppToolRelayEvent, { type: 'tool_call' }>) => void) {
  const registry = new AppToolRelayRegistry();
  const { relayId } = registry.open({ appId: 'qualla', appName: 'Qualla' });
  registry.attachStream(relayId, appStream(registry, relayId, respond));
  registry.register(relayId, { projectId: 'trips', tools: [TOOL] });
  const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
  if (!binding) throw new Error('no binding');
  return {
    registry,
    relayId,
    open: () =>
      connectAppToolClientForTest({
        registry,
        binding,
        session: { sessionId: 's1', gezelId: 'gids', projectId: 'trips' },
      }),
  };
}

describe('app-tool relay MCP transport', () => {
  it("lists the app's tools as an ordinary MCP server would", async () => {
    const { open } = setup(() => {});
    const client = await open();
    try {
      const listing = await client.listTools();
      expect(listing.tools).toHaveLength(1);
      expect(listing.tools[0]).toMatchObject({
        name: 'add_travel_points',
        description: 'Award travel points to the traveller.',
      });
      expect(listing.tools[0]?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.close();
    }
  });

  it("carries a call to the app and the app's answer back to the caller", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const { registry, relayId, open } = setup((call) => {
      seen.push({ tool: call.tool, args: call.arguments, session: call.sessionId });
      registry.resolveCall(relayId, call.callId, {
        ok: true,
        content: `awarded ${(call.arguments as { points: number }).points}`,
      });
    });
    const client = await open();
    try {
      const result = await client.callTool({
        name: 'add_travel_points',
        arguments: { points: 5, reason: 'booked a trip' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'awarded 5' }]);
      expect(result.isError).toBeFalsy();
      expect(seen).toEqual([
        { tool: 'add_travel_points', args: { points: 5, reason: 'booked a trip' }, session: 's1' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('reports an app-side failure as a tool error, not a transport fault', async () => {
    const { registry, relayId, open } = setup((call) => {
      registry.resolveCall(relayId, call.callId, { ok: false, error: 'the traveller is unknown' });
    });
    const client = await open();
    try {
      const result = await client.callTool({
        name: 'add_travel_points',
        arguments: { points: 1 },
      });
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([{ type: 'text', text: 'the traveller is unknown' }]);
    } finally {
      await client.close();
    }
  });

  it('rejects arguments that do not match the declared schema before reaching the app', async () => {
    let reached = false;
    const { open } = setup(() => {
      reached = true;
    });
    const client = await open();
    try {
      const result = await client.callTool({
        name: 'add_travel_points',
        arguments: { points: 'five' },
      });
      expect(result.isError).toBe(true);
      expect(String((result.content as Array<{ text: string }>)[0]?.text)).toContain(
        'invalid arguments for add_travel_points',
      );
      expect(reached).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('passes image blocks through untouched', async () => {
    const { registry, relayId, open } = setup((call) => {
      registry.resolveCall(relayId, call.callId, {
        ok: true,
        content: [
          { type: 'text', text: 'here is the badge' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      });
    });
    const client = await open();
    try {
      const result = await client.callTool({
        name: 'add_travel_points',
        arguments: { points: 1 },
      });
      expect(result.content).toEqual([
        { type: 'text', text: 'here is the badge' },
        { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      ]);
    } finally {
      await client.close();
    }
  });

  it('is a bridge spec the transport builder and log formatter understand', () => {
    const registry = new AppToolRelayRegistry();
    const { relayId } = registry.open({ appId: 'qualla' });
    registry.attachStream(relayId, { write: () => {} });
    registry.register(relayId, { projectId: 'trips', tools: [TOOL] });
    const binding = registry.listForSession({ projectId: 'trips', gezelId: 'gids' })[0];
    if (!binding) throw new Error('no binding');

    const spec = {
      kind: 'in-memory' as const,
      label: 'qualla',
      connect: () =>
        createAppToolRelayTransport({
          registry,
          binding,
          session: { sessionId: 's1', gezelId: 'gids', projectId: 'trips' },
        }),
    };
    expect(isInMemorySpec(spec)).toBe(true);
    expect(isStdioSpec(spec)).toBe(false);
    expect(describeSpec(spec)).toBe('in-memory qualla');
    // Never logs anything the app supplied beyond the label, and builds a real
    // transport rather than trying to spawn a process.
    expect(buildTransport(spec)).toBeDefined();
  });
});
