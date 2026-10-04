/**
 * Live, synthetic checks through the desktop transport and shared iOS adapter.
 * Run from the repo root:
 * node scripts/run-with-dependency-lease.mjs --direct-node native/helpers/apple-fm/smoke.ts
 * Build the helper first with native/helpers/apple-fm/build.sh.
 * This does not start a daemon, change settings, or execute product tools.
 */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  acquireSuspendMonitor,
  awakeNow,
  createAwakeTimeout,
  getLogOutput,
  setLogOutput,
} from '../../../packages/core/dist/index.js';
import {
  AppleFmError,
  type AppleFmGenerateRequest,
  AppleFmHelper,
} from '../../../packages/service/src/providers/apple-foundation-models/helper.js';
import { AppleFoundationModelsProvider } from '../../../packages/service/src/providers/apple-foundation-models/provider.js';
import type { TurnUsage } from '../../../packages/service/src/providers/types.js';

const helper = new AppleFmHelper({
  binaryPath:
    process.env.GEZEL_APPLE_FM_BIN ??
    fileURLToPath(new URL('../../build/darwin-arm64/gezel-apple-fm', import.meta.url)),
});
const releaseMonitor = acquireSuspendMonitor();
const previousLogOutput = getLogOutput();
setLogOutput('stderr');
const results: Array<Record<string, unknown>> = [];

async function check<T>(name: string, run: (signal: AbortSignal) => Promise<T>) {
  const started = awakeNow();
  const timeout = createAwakeTimeout(60_000);
  let onAbort: () => void = () => {};
  try {
    const value = await Promise.race([
      run(timeout.signal),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error(`${name} exceeded 60 seconds of awake time`));
        timeout.signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    const result = { name, passed: true, durationMs: awakeNow() - started, value };
    results.push(result);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return value;
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    throw error;
  } finally {
    timeout.signal.removeEventListener('abort', onAbort);
    timeout.dispose();
  }
}

try {
  const hello = await check('availability', async () => {
    const status = await helper.ready();
    assert(status.available, status.reason ?? 'Apple Intelligence is unavailable');
    assert(status.contextTokens > status.maxOutputTokens);
    return status;
  });

  const request = (content: string): AppleFmGenerateRequest => ({
    messages: [{ role: 'user', content }],
    maxTokens: 128,
    contextSize: hello.contextTokens,
  });
  const tool = {
    name: 'lookup_parcel',
    description: 'Look up the pickup code for a parcel. Call this to find a pickup code.',
    parameters: {
      kind: 'object' as const,
      properties: [{ name: 'parcel', optional: false, schema: { kind: 'string' as const } }],
    },
  };
  const toolRequest = {
    ...request('Use lookup_parcel to find the pickup code for parcel blue. Report the code.'),
    tools: [tool],
  };

  await check('token-count-includes-tools', async () => {
    const plain = await helper.countTokens(toolRequest.messages);
    const withTools = await helper.countTokens(toolRequest.messages, [tool]);
    assert(plain > 0 && withTools > plain);
    return { plain, withTools };
  });

  async function generate(
    input: AppleFmGenerateRequest,
    signal: AbortSignal,
    options: { endTurn?: boolean; cancelOnDelta?: AbortController } = {},
  ) {
    let text = '';
    let chunks = 0;
    let firstDeltaMs: number | undefined;
    const calls: Array<{ name: string; arguments: string }> = [];
    let usage: { inputTokens: number; outputTokens: number } | undefined;
    const started = awakeNow();
    const reason = await helper.generate(
      input,
      {
        onUsage(value) {
          usage = value;
        },
        onDelta(delta) {
          firstDeltaMs ??= awakeNow() - started;
          text += delta;
          chunks++;
          options.cancelOnDelta?.abort();
        },
        async onToolCall(call) {
          calls.push({ name: call.name, arguments: call.arguments });
          assert.equal(call.name, tool.name);
          assert.equal(JSON.parse(call.arguments).parcel, 'blue');
          return { output: 'The pickup code is 4729.', endTurn: options.endTurn ?? false };
        },
      },
      signal,
    );
    return { reason, text, chunks, firstDeltaMs, calls, usage };
  }

  await check('streaming', async (signal) => {
    const result = await generate(
      request('In one sentence, explain why leaves are green.'),
      signal,
    );
    assert.equal(result.reason, 'stop');
    assert(result.text.length > 0 && result.chunks > 1);
    if (hello.supportsTokenUsage) {
      assert(result.usage && result.usage.inputTokens > 0 && result.usage.outputTokens > 0);
    }
    return result;
  });
  await check('conversation-replay', async (signal) => {
    const input = request('What is my favorite flower? Reply with its name only.');
    input.messages.unshift(
      { role: 'user', content: 'My favorite flower is an orchid.' },
      { role: 'assistant', content: 'Your favorite flower is an orchid.' },
    );
    const result = await generate(input, signal);
    assert.match(result.text, /orchid/i);
    return result;
  });
  await check('native-tool-roundtrip', async (signal) => {
    const result = await generate(toolRequest, signal);
    assert(result.calls.length > 0);
    assert.match(result.text, /4729/);
    return result;
  });
  await check('terminal-tool', async (signal) => {
    const result = await generate(toolRequest, signal, { endTurn: true });
    assert.equal(result.calls.length, 1);
    assert.equal(result.reason, 'stop');
    return result;
  });
  await check('context-rejection', async (signal) => {
    const input = request(`Summarize this: ${'A small garden with green leaves. '.repeat(150)}`);
    input.contextSize = 512;
    await assert.rejects(
      generate(input, signal),
      (error: unknown) => error instanceof AppleFmError && error.code === 'CONTEXT_LIMIT',
    );
    return { code: 'CONTEXT_LIMIT' };
  });
  await check('cancel-and-reuse', async (signal) => {
    const cancel = new AbortController();
    const input = request(
      'Tell a long story about a gardener and describe every plant in the garden.',
    );
    input.maxTokens = hello.maxOutputTokens;
    const cancelled = await generate(input, AbortSignal.any([signal, cancel.signal]), {
      cancelOnDelta: cancel,
    });
    assert.equal(cancelled.reason, 'cancelled');
    const recovered = await generate(request('Say hello in a short sentence.'), signal);
    assert.equal(recovered.reason, 'stop');
    assert(recovered.text.length > 0);
    return { cancelled, recovered };
  });
  await check('desktop-provider-session', async (signal) => {
    const provider = new AppleFoundationModelsProvider({ helper });
    const models = await provider.listModels();
    assert.equal(models[0]?.contextWindow, hello.contextTokens);
    const session = await provider.createSession({
      systemMessage: 'Answer briefly and accurately.',
      priorMessages: [
        { role: 'user', content: 'My favorite flower is an orchid.' },
        { role: 'assistant', content: 'Your favorite flower is an orchid.' },
      ],
    });
    let usage: TurnUsage | undefined;
    session.onUsage((value) => {
      usage = value;
    });
    try {
      const text = await session.sendAndWait('What is my favorite flower?', {
        queue: { lane: 'interactive', signal },
      });
      assert.match(text, /orchid/i);
      assert(usage && usage.inputTokens > 0 && usage.outputTokens > 0);
      return { text, usage };
    } finally {
      await session.disconnect();
    }
  });
} catch (error) {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
} finally {
  await helper.shutdown();
  releaseMonitor();
  setLogOutput(previousLogOutput);
  process.stdout.write(`${JSON.stringify({ name: 'summary', results })}\n`);
}
