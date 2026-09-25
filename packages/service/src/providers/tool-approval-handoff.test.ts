import { describe, expect, it, vi } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import type { McpBridgePool } from './mcp-bridge-pool.js';
import { McpBridge } from './mcp-bridge.js';
import { MlxProvider } from './mlx/provider.js';
import { ProviderQueue } from './queue.js';
import { RemoteSession } from './remote/session.js';

function pendingBridge(tool = 'run_package_script', structured = true, isError = false) {
  const bridge = new McpBridge();
  (bridge as unknown as { client: unknown }).client = {
    callTool: async () => ({
      content: [{ type: 'text', text: 'This command needs user approval.' }],
      ...(structured
        ? {
            structuredContent: {
              state: 'approval_pending',
              approvalPending: true,
              questionId: 'q1',
            },
          }
        : {}),
      isError,
    }),
    close: async () => {},
  };
  return { bridge, tool };
}

describe('command approval handoff', () => {
  it('yields the broker-backed turn and retains tool results for the approval answer', async () => {
    const requests: Array<{ priorMessages: Array<{ role: string; toolCallId?: string }> }> = [];
    const { bridge } = pendingBridge();
    const session = new RemoteSession({
      baseUrl: 'https://broker.test',
      token: 'test-token',
      model: 'mlx:test',
      systemMessage: 'Build',
      numCtx: 32768,
      timeoutMs: 5000,
      priorMessages: [],
      queue: new ProviderQueue({ concurrency: 1 }),
      fetch: (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        const frames =
          requests.length === 1
            ? [
                {
                  type: 'tool_call',
                  calls: [
                    { id: 'c1', name: 'run_package_script', arguments: '{"script":"build"}' },
                  ],
                },
                { type: 'done' },
              ]
            : [{ type: 'delta', text: 'Continuing approved work.' }, { type: 'done' }];
        return new Response(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
      bridges: {
        isEmpty: () => false,
        getOpenAITools: () => [{ name: 'run_package_script', parameters: { type: 'object' } }],
        callToolRich: bridge.callToolRich.bind(bridge),
        stop: () => bridge.stop(),
      } as unknown as McpBridgePool,
    });
    try {
      await session.sendAndWait('Run the build.');
      expect(requests).toHaveLength(1);
      expect(await session.sendAndWait('Approved; continue.')).toBe('Continuing approved work.');
      expect(requests).toHaveLength(2);
      expect(requests[1]!.priorMessages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      expect(requests[1]!.priorMessages.at(-1)?.toolCallId).toBe('c1');
    } finally {
      await session.disconnect();
    }
  });
  it.each([
    ['run_package_script', true, false, true],
    ['run_npx', true, false, true],
    ['read_file', true, false, false],
    ['run_package_script', false, false, false],
    ['run_package_script', true, true, false],
  ] as const)(
    'only signals a structured pending command: %s / %s / %s',
    async (tool, structured, error, pending) => {
      const { bridge } = pendingBridge(tool, structured, error);
      const onApprovalPending = vi.fn();
      await bridge.callTool(tool, {}, { onApprovalPending });
      expect(onApprovalPending).toHaveBeenCalledTimes(pending ? 1 : 0);
      await bridge.stop();
    },
  );

  it.each([LlamaCppProvider, MlxProvider])(
    '%s yields before requesting another completion',
    async (Provider) => {
      let requests = 0;
      const provider = new Provider({
        baseUrl: 'http://model.test',
        fetchImpl: (async () => {
          requests++;
          if (requests > 1) throw new Error('Must yield for the approval follow-up');
          const events = [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'c1',
                        type: 'function',
                        function: { name: 'run_package_script', arguments: '{"script":"build"}' },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ];
          return new Response(
            `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')}data: [DONE]\n\n`,
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }) as typeof fetch,
      });
      const session = await provider.createSession({ systemMessage: 'Run the package build.' });
      const { bridge } = pendingBridge();
      (session as unknown as { deps: { bridges: unknown } }).deps.bridges = {
        isEmpty: () => false,
        hasTool: () => true,
        getOpenAITools: () => [
          {
            type: 'function',
            name: 'run_package_script',
            description: 'Build',
            parameters: {
              type: 'object',
              properties: { script: { type: 'string' } },
              required: ['script'],
            },
          },
        ],
        callTool: bridge.callTool.bind(bridge),
        stop: () => bridge.stop(),
      };
      try {
        await session.sendAndWait('Run the package build.', { timeoutMs: 5000 });
        expect(requests).toBe(1);
      } finally {
        await session.disconnect();
        await provider.shutdown();
      }
    },
  );
});
