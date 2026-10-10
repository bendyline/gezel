import { afterEach, describe, expect, it, vi } from 'vitest';

const { lines } = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@bendyline/gezel', async (original) => ({
  ...(await original<object>()),
  createLogger: () => ({ info: (line: string) => lines.push(line) }),
}));
import {
  apiToolSurface,
  assertQualificationProvider,
  observeApiStream,
  recordRuntimeIntervention,
} from './api-observation.js';

async function* stream(events: unknown[]) {
  yield* events;
}
async function collect<T>(iterable: AsyncIterable<T>) {
  const events: T[] = [];
  for await (const e of iterable) events.push(e);
  return events;
}
const records = () =>
  lines
    .filter((l) => l.startsWith('measurement.api '))
    .map((l) => JSON.parse(l.slice('measurement.api '.length)));

afterEach(() => {
  vi.unstubAllEnvs();
  lines.length = 0;
});

describe('API request observation', () => {
  it('prevents CLI and fallback acquisition only inside qualification', () => {
    vi.stubEnv('GEZEL_EVAL_API_PROVIDER', 'openai');
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    expect(() => assertQualificationProvider('openai')).not.toThrow();
    for (const provider of ['anthropic-cli', 'codex-cli', 'anthropic', 'llama-cpp', 'remote']) {
      expect(() => assertQualificationProvider(provider)).toThrow('Qualification blocked provider');
    }
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '');
    expect(() => assertQualificationProvider('codex-cli')).not.toThrow();
  });
  it('is a transparent pass-through when not opted in', async () => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '');
    const events = [{ type: 'response.completed' }];
    expect(
      await collect(
        observeApiStream(() => stream(events), { provider: 'openai', request: {}, round: 1 }),
      ),
    ).toEqual(events);
    expect(lines).toEqual([]);
  });
  it('captures native OpenAI usage and actual settings, without prompt, argument or config contents', async () => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    const events = [
      {
        type: 'response.output_item.done',
        item: { type: 'function_call', arguments: 'private argument' },
      },
      {
        type: 'response.completed',
        response: {
          model: 'resolved-model',
          usage: {
            input_tokens: 20,
            output_tokens: 5,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      },
    ];
    const output = await collect(
      observeApiStream(() => stream(events), {
        provider: 'openai',
        request: {
          model: 'requested-model',
          instructions: 'private prompt',
          input: 'private input',
          tools: [{ name: 'read_file' }],
          reasoning: { effort: 'high' },
        },
        round: 2,
        context: { sessionId: 's', behaviors: [{ id: 'behavior', config: 'private config' }] },
      }),
    );
    expect(output).toEqual(events);
    expect(records()[0]).toMatchObject({
      model: 'requested-model',
      sessionId: 's',
      round: 2,
      reasoning: { effort: 'high' },
      tools: { count: 1, names: ['read_file'] },
      behaviors: [{ id: 'behavior', configHash: expect.any(String) }],
    });
    expect(records()[1]).toMatchObject({
      responseModel: 'resolved-model',
      outcome: 'completed',
      toolCalls: 1,
      sdkRetries: null,
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 10,
        reasoningTokens: 3,
        cacheWriteTokens: null,
      },
    });
    expect(lines.join('\n')).not.toContain('private');
  });
  it('uses Anthropic final output counters without double-counting the initial delta', async () => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    await collect(
      observeApiStream(
        () =>
          stream([
            {
              type: 'message_start',
              message: {
                model: 'sonnet',
                usage: {
                  input_tokens: 10,
                  output_tokens: 1,
                  cache_read_input_tokens: 100,
                  cache_creation_input_tokens: 20,
                },
              },
            },
            { type: 'message_delta', usage: { output_tokens: 8 } },
            { type: 'message_stop' },
          ]),
        { provider: 'anthropic', request: { model: 'sonnet' }, round: 1 },
      ),
    );
    expect(records()[1]).toMatchObject({
      outcome: 'completed',
      usage: {
        inputTokens: 10,
        outputTokens: 8,
        cachedInputTokens: 100,
        cacheWriteTokens: 20,
        reasoningTokens: null,
      },
    });
  });

  it.each([
    'max_output_tokens',
    'max_messages',
    'content_filter',
    'steered',
    'private unexpected reason',
  ])('records safe provider-declared incomplete reason %s', async (reason) => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    await collect(
      observeApiStream(
        () =>
          stream([
            {
              type: 'response.incomplete',
              response: { incomplete_details: { reason } },
            },
          ]),
        { provider: 'openai', request: {}, round: 1 },
      ),
    );
    expect(records()[1]).toMatchObject({
      outcome: 'incomplete',
      terminalEvent: 'response.incomplete',
      incompleteReason: reason.startsWith('private') ? 'other' : reason,
    });
    expect(lines.join('\n')).not.toContain('private');
  });
  it('preserves SDK errors and records their status without copying error bodies', async () => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    const error = Object.assign(new Error('private key leaked in SDK error'), { status: 429 });
    await expect(
      collect(
        observeApiStream(
          () => {
            throw error;
          },
          { provider: 'openai', request: {}, round: 1 },
        ),
      ),
    ).rejects.toBe(error);
    expect(records()[1]).toMatchObject({ outcome: 'failed', errorStatus: 429 });
    expect(lines.join('\n')).not.toContain('private key');
  });
  it('marks abandoned streams incomplete and hashes schema-only changes', async () => {
    vi.stubEnv('GEZEL_EVAL_OBSERVE', '1');
    const observed = observeApiStream(
      () => stream([{ type: 'message_start' }, { type: 'message_stop' }]),
      { provider: 'anthropic', request: {}, round: 1 },
    );
    await observed.next();
    await observed.return(undefined);
    expect(records()[1]).toMatchObject({
      outcome: 'incomplete',
      terminalEvent: null,
      incompleteReason: null,
    });
    expect(apiToolSurface([{ name: 'a' }]).schemaHash).not.toBe(
      apiToolSurface([{ name: 'b' }]).schemaHash,
    );
    recordRuntimeIntervention({
      sessionId: 's',
      source: 'product-runtime',
      reason: 'recovery',
      prompt: 'private correction',
    });
    expect(lines.at(-1)).toContain('"status":"prepared"');
    expect(lines.at(-1)).not.toContain('private correction');
  });
});
