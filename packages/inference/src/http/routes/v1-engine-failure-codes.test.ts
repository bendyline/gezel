import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from '../../inference-service.js';
import type { LLMProvider } from '../../providers/types.js';

vi.mock('../../memory/embeddings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/embeddings.js')>()),
  embedBatch: async (texts: string[]) => texts.map((text) => [text.length, 1]),
}));

let running: RunningInferenceService | undefined;
let home: string | undefined;

afterEach(async () => {
  await running?.stop();
  running = undefined;
  if (home) await rm(home, { recursive: true, force: true });
});

function coded(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A llama.cpp engine whose every turn fails with `failure`. */
async function startFailingEngine(failure: Error): Promise<RunningInferenceService> {
  home = await mkdtemp(join(tmpdir(), 'gezel-inference-'));
  class Session extends StreamingSessionBase {
    async sendAndWait(): Promise<string> {
      throw failure;
    }
    providerState() {
      return {};
    }
    async disconnect() {}
  }
  const provider: LLMProvider = {
    name: 'llama-cpp',
    supportsPriorMessages: true,
    initialize: async () => {},
    shutdown: async () => {},
    listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
    createSession: async () => new Session(),
  };
  return await startService({ home, providers: new Map([['llama-cpp', provider]]) });
}

function post(body: unknown): Promise<Response> {
  return running!.fetch('http://gezel.local/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${running!.clientToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const chat = {
  model: 'llama-cpp:fixture',
  messages: [{ role: 'user', content: 'Name a pet.' }],
};

async function streamedError(res: Response): Promise<unknown> {
  const body = await res.text();
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: {"error"'))
    .map((line) => (JSON.parse(line.slice('data: '.length)) as { error: unknown }).error)[0];
}

// A connected app decides what to tell its user from the code. Every engine
// failure used to arrive as `provider_error`, which says nothing it can act on.
describe('an on-device engine failure on /v1/chat/completions', () => {
  it('carries its own code before the stream starts', async () => {
    const memory = 'There is not enough memory to run this model right now.';
    running = await startFailingEngine(coded(memory, 'capacity-denied'));
    const res = await post(chat);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { message: memory, type: 'server_error', code: 'capacity_denied' },
    });
  });

  it('carries its own code on a stream already under way', async () => {
    const crash = coded('[llama-cpp] on-device engine crashed', 'native-engine-crash');
    running = await startFailingEngine(crash);
    const res = await post({ ...chat, stream: true });
    expect(res.status).toBe(200);
    expect(await streamedError(res)).toEqual({
      message: crash.message,
      type: 'server_error',
      code: 'engine_crashed',
    });
  });

  it('tells an out-of-memory kill apart from a crash', async () => {
    const oom = Object.assign(
      coded('[llama-cpp] on-device engine ran out of memory', 'native-engine-crash'),
      {
        panicKind: 'host-out-of-memory',
      },
    );
    running = await startFailingEngine(oom);
    const res = await post(chat);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'engine_out_of_memory' } });
  });

  it('reports a missing Windows runtime as a launch failure, not a crash to retry', async () => {
    const missing = Object.assign(
      coded('[llama-cpp] on-device engine could not start', 'native-engine-crash'),
      { panicKind: 'missing-runtime' },
    );
    running = await startFailingEngine(missing);
    const res = await post(chat);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'engine_launch_failed' } });
  });

  it('finds the code on a wrapped cause', async () => {
    const launch = coded('spawn EPERM', 'engine-launch');
    running = await startFailingEngine(new Error('engine start failed', { cause: launch }));
    const res = await post({ ...chat, stream: true });
    expect(await streamedError(res)).toMatchObject({ code: 'engine_launch_failed' });
  });

  it("reports an over-long prompt as the caller's 400, so an SDK does not retry it", async () => {
    running = await startFailingEngine(coded('ran out of working memory', 'context-overflow'));
    const res = await post(chat);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: { type: 'invalid_request_error', code: 'context_length_exceeded' },
    });
  });

  it('stays provider_error when nothing more is known', async () => {
    running = await startFailingEngine(new Error('something else went wrong'));
    const res = await post(chat);
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'provider_error' } });
  });
});
