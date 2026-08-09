import { describe, expect, it, vi } from 'vitest';
import { CopilotProvider } from './copilot.js';
import type { ToolCallEvent } from './types.js';

function toolActivitySdk(): Record<string, unknown> {
  type Event = { data: Record<string, unknown> };
  type Handler = (event: Event) => void;
  const listeners = new Map<string, Set<Handler>>();
  const emit = (name: string, data: Record<string, unknown>) => {
    for (const listener of listeners.get(name) ?? []) listener({ data });
  };
  const session = {
    sessionId: 'tool-activity-test',
    on(name: string, handler: Handler) {
      const group = listeners.get(name) ?? new Set<Handler>();
      group.add(handler);
      listeners.set(name, group);
      return () => group.delete(handler);
    },
    async sendAndWait() {
      emit('tool.execution_start', {
        toolCallId: 'intent-noise',
        toolName: 'report_intent',
        arguments: { intent: 'Using MCP tool call' },
      });
      emit('tool.execution_start', {
        toolCallId: 'intent-phase',
        toolName: 'report_intent',
        arguments: { intent: 'Reviewing the final result' },
      });
      emit('tool.execution_start', {
        toolCallId: 'tool-1',
        toolName: 'gezel-advance_task_step',
        arguments: { ref: 'demo/1' },
      });
      emit('tool.execution_complete', {
        toolCallId: 'tool-1',
        success: true,
      });
      return { data: { content: 'Done.' } };
    },
    async disconnect() {},
  };
  return {
    approveAll: () => ({ kind: 'approve-once' }),
    CopilotClient: class {
      async start() {}
      async stop() {}
      async createSession() {
        return session;
      }
      async resumeSession() {
        return session;
      }
      async listModels() {
        return [];
      }
      async getAuthStatus() {
        return { isAuthenticated: true };
      }
    },
  };
}

describe('Copilot tool activity display', () => {
  it('keeps tool execution transient and emits the concrete Gezel tool name', async () => {
    const provider = new CopilotProvider({});
    vi.spyOn(
      provider as unknown as { loadSdk: () => Promise<unknown> },
      'loadSdk',
    ).mockResolvedValue(toolActivitySdk());
    const toolCalls: ToolCallEvent[] = [];
    const session = await provider.createSession({
      systemMessage: 'go',
      mcpServer: { command: 'node', args: ['server.js'], env: {} },
      onToolCall: (event) => {
        toolCalls.push(event);
      },
    });
    const intents: string[] = [];
    const heartbeats: Array<string | undefined> = [];
    session.onIntent?.((label) => intents.push(label));
    session.onHeartbeat?.((label) => heartbeats.push(label));

    await session.sendAndWait('advance the task');

    expect(intents).toEqual(['Reviewing the final result']);
    expect(heartbeats).toContain('advance task step');
    expect(toolCalls).toMatchObject([
      {
        name: 'advance_task_step',
        args: { ref: 'demo/1' },
        success: true,
      },
    ]);
    await provider.shutdown();
  });
});
