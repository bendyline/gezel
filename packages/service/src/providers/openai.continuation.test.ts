import type OpenAI from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { CLOUD_TOOL_ROUND_LIMIT } from './cloud-tool-limits.js';
import { McpBridgePool } from './mcp-bridge-pool.js';
import { OpenAISession, type OpenAISessionDeps } from './openai.js';
import { ProviderQueue } from './queue.js';
import { TERMINAL_ACTION_SKIPPED_OUTPUT } from './terminal-tool-policy.js';

const call = (id: string, name = 'read_artifact', args = '{"path":"notes.md"}') => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', call_id: id, name, arguments: args },
});
const terminal = (id: string, status = 'completed') => ({
  type: `response.${status}`,
  response: {
    id,
    usage: { input_tokens: 20, output_tokens: 4 },
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    ...(status === 'failed' ? { error: { code: 'server_error' } } : {}),
  },
});
const text = (delta: string) => ({ type: 'response.output_text.delta', delta });

async function harness(
  rounds: Array<unknown[] | Error>,
  overrides: Partial<OpenAISessionDeps> = {},
) {
  const requests: Array<Record<string, unknown>> = [];
  const openai = {
    responses: {
      stream: (request: Record<string, unknown>) => {
        requests.push(structuredClone(request));
        return (async function* () {
          const round = rounds.shift();
          if (!round) throw new Error('Unexpected API request');
          if (round instanceof Error) throw round;
          yield* round;
        })();
      },
    },
  } as unknown as OpenAI;
  const bridges = await McpBridgePool.fromSessionOpts({ systemMessage: '' }, '[test]');
  vi.spyOn(bridges, 'hasTool').mockReturnValue(true);
  const execute = vi.spyOn(bridges, 'callToolRich').mockResolvedValue({
    text: 'Saved result',
    images: [],
    isError: false,
  });
  const deps = {
    openai,
    bridges,
    model: 'gpt-test',
    systemMessage: 'Test assistant',
    previousResponseId: null,
    queue: new ProviderQueue({ concurrency: 1 }),
    ...overrides,
  };
  return { session: new OpenAISession(deps), deps, requests, execute };
}

describe('OpenAI continuation state', () => {
  it('advances past an incomplete response that already received a tool result', async () => {
    const { session, requests, execute } = await harness([
      [call('read-1'), terminal('resp-call')],
      [text('Partial answer'), terminal('resp-incomplete', 'incomplete')],
      [text('Recovered'), terminal('resp-recovered')],
    ]);
    const usage = vi.fn();
    session.onUsage(usage);

    await expect(session.sendAndWait('Read the notes')).rejects.toThrow(
      'incomplete (max_output_tokens)',
    );
    expect(requests[1]).toMatchObject({
      previous_response_id: 'resp-call',
      input: [{ type: 'function_call_output', call_id: 'read-1', output: 'Saved result' }],
    });
    expect(session.providerState()).toEqual({ openaiPreviousResponseId: 'resp-incomplete' });
    expect(usage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 40, outputTokens: 8 }),
    );

    await expect(session.sendAndWait('Continue')).resolves.toBe('Recovered');
    expect(requests[2]).toMatchObject({
      previous_response_id: 'resp-incomplete',
      input: 'Continue',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('carries terminal handoff results and skipped calls across a saved-session resume', async () => {
    const { session, deps, requests, execute } = await harness([
      [
        call('advance-1', 'advance_task_step', '{"ref":"default/1","stepId":"read"}'),
        call('stale-write', 'write_artifact'),
        terminal('resp-handoff'),
      ],
      [text('Next step'), terminal('resp-next')],
      [text('Done'), terminal('resp-done')],
    ]);
    const receipt = 'Completed step "read" on default/1. Active step is now "write".';
    execute.mockResolvedValue({ text: receipt, images: [], isError: false });
    await expect(session.sendAndWait('Finish reading')).resolves.toBe(receipt);
    expect(requests).toHaveLength(1);
    expect(execute).toHaveBeenCalledTimes(1);

    const saved = JSON.parse(JSON.stringify(session.providerState()));
    const resumed = new OpenAISession({
      ...deps,
      previousResponseId: saved.openaiPreviousResponseId,
      pendingToolOutputs: saved.openaiPendingToolOutputs,
    });
    await expect(resumed.sendAndWait('Start writing')).resolves.toBe('Next step');
    expect(requests[1]).toMatchObject({
      previous_response_id: 'resp-handoff',
      input: [
        { type: 'function_call_output', call_id: 'advance-1', output: receipt },
        {
          type: 'function_call_output',
          call_id: 'stale-write',
          output: TERMINAL_ACTION_SKIPPED_OUTPUT,
        },
        { role: 'user', content: 'Start writing' },
      ],
    });
    expect(resumed.providerState()).toEqual({ openaiPreviousResponseId: 'resp-next' });
    await resumed.sendAndWait('Wrap up');
    expect(requests[2]).toMatchObject({ previous_response_id: 'resp-next', input: 'Wrap up' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['HTTP failure', new Error('429 rate limit')],
    ['truncated stream', [text('Partial')]],
  ])('retains tool results after %s without executing the tool again', async (_label, failure) => {
    const { session, requests, execute } = await harness([
      [call('read-1'), terminal('resp-call')],
      failure as unknown[] | Error,
      [text('Recovered'), terminal('resp-recovered')],
    ]);
    await expect(session.sendAndWait('Read')).rejects.toThrow();
    const output = { type: 'function_call_output', call_id: 'read-1', output: 'Saved result' };
    expect(session.providerState()).toEqual({
      openaiPreviousResponseId: 'resp-call',
      openaiPendingToolOutputs: [output],
    });
    await session.sendAndWait('Retry');
    expect(requests[2]).toMatchObject({
      previous_response_id: 'resp-call',
      input: [output, { role: 'user', content: 'Retry' }],
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each(['incomplete', 'failed'])(
    'does not execute tool calls from a %s response',
    async (status) => {
      const { session, execute, requests } = await harness([
        [
          call('write-1', 'write_artifact', '{"path":"notes.md","content":"partial"}'),
          terminal('resp-partial', status),
        ],
        [text('Recovered'), terminal('resp-recovered')],
      ]);
      await expect(session.sendAndWait('Write notes')).rejects.toThrow(status);
      expect(execute).not.toHaveBeenCalled();
      await session.sendAndWait('Retry');
      expect(requests[1]).toMatchObject({
        previous_response_id: 'resp-partial',
        input: [
          {
            type: 'function_call_output',
            call_id: 'write-1',
            output: expect.stringContaining('not executed'),
          },
          { role: 'user', content: 'Retry' },
        ],
      });
    },
  );

  it('surfaces streamed errors instead of returning a successful empty answer', async () => {
    const { session } = await harness([[{ type: 'error', code: 'server_error' }]]);
    await expect(session.sendAndWait('Hello')).rejects.toThrow('error (server_error)');
  });

  it('closes partial calls present only in the terminal response snapshot', async () => {
    const partial = terminal('resp-partial', 'incomplete');
    const { session, execute, requests } = await harness([
      [
        {
          ...partial,
          response: {
            ...partial.response,
            output: [
              {
                type: 'function_call',
                call_id: 'partial-1',
                name: 'write_artifact',
                arguments: '{"path":',
              },
            ],
          },
        },
      ],
      [text('Recovered'), terminal('resp-recovered')],
    ]);
    await expect(session.sendAndWait('Write notes')).rejects.toThrow('incomplete');
    expect(execute).not.toHaveBeenCalled();
    await session.sendAndWait('Retry');
    expect(requests[1]).toMatchObject({
      previous_response_id: 'resp-partial',
      input: [
        {
          type: 'function_call_output',
          call_id: 'partial-1',
          output: expect.stringContaining('not executed'),
        },
        { role: 'user', content: 'Retry' },
      ],
    });
  });
});

describe('OpenAI checkpoint and loop budgets', () => {
  const terminalToolPolicy = {
    toolNames: ['write_artifact'],
    onlyWhenArgEquals: { arg: 'path', value: 'tasks/4/notes.md' },
    fallbackText: 'Checkpoint saved.',
  };

  it('closes only after the configured successful checkpoint and preserves its receipt', async () => {
    const { session, requests, execute } = await harness(
      [
        [call('other', 'write_artifact', '{"path":"other.md"}'), terminal('r1')],
        [call('failed', 'write_artifact', '{"path":"tasks/4/notes.md"}'), terminal('r2')],
        [
          call('saved', 'write_artifact', '{"path":"tasks/4/notes.md"}'),
          call('stale'),
          terminal('r3'),
        ],
        [text('Next step'), terminal('r4')],
      ],
      { terminalToolPolicy },
    );
    execute
      .mockResolvedValueOnce({ text: 'Saved', images: [], isError: false })
      .mockResolvedValueOnce({ text: 'Permission denied', images: [], isError: true });
    await expect(session.sendAndWait('Write checkpoint')).resolves.toBe('Checkpoint saved.');
    expect(requests).toHaveLength(3);
    expect(execute).toHaveBeenCalledTimes(3);
    await session.sendAndWait('Continue');
    expect(requests[3]).toMatchObject({
      previous_response_id: 'r3',
      input: [
        { type: 'function_call_output', call_id: 'saved', output: 'Saved result' },
        { type: 'function_call_output', call_id: 'stale', output: TERMINAL_ACTION_SKIPPED_OUTPUT },
        { role: 'user', content: 'Continue' },
      ],
    });
  });

  it('allows more than twelve productive rounds and accounts for every response', async () => {
    const rounds = Array.from({ length: 14 }, (_, i) => [
      call(`c${i}`, 'read_artifact', JSON.stringify({ path: `${i}.md` })),
      terminal(`r${i}`),
    ]);
    const { session, requests } = await harness([...rounds, [text('Done'), terminal('final')]]);
    const usage = vi.fn();
    session.onUsage(usage);
    await expect(session.sendAndWait('Review files')).resolves.toBe('Done');
    expect(requests).toHaveLength(15);
    expect(usage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ inputTokens: 300, outputTokens: 60 }),
    );
  });

  it('keeps an absolute limit, reports usage, and saves the last tool receipt on exhaustion', async () => {
    const rounds = Array.from({ length: CLOUD_TOOL_ROUND_LIMIT }, (_, i) => [
      call(`c${i}`),
      terminal(`r${i}`),
    ]);
    const { session, requests } = await harness(rounds);
    const usage = vi.fn();
    session.onUsage(usage);
    await expect(session.sendAndWait('Review')).rejects.toThrow('too many tool-call loops');
    expect(requests).toHaveLength(CLOUD_TOOL_ROUND_LIMIT);
    expect(session.providerState().openaiPendingToolOutputs).toEqual([
      {
        type: 'function_call_output',
        call_id: `c${CLOUD_TOOL_ROUND_LIMIT - 1}`,
        output: 'Saved result',
      },
    ]);
    expect(usage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        inputTokens: 20 * CLOUD_TOOL_ROUND_LIMIT,
        outputTokens: 4 * CLOUD_TOOL_ROUND_LIMIT,
      }),
    );
  });
});
