import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamingSessionBase } from '@bendyline/gezel/local-loop';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type RunningInferenceService, startService } from '../../inference-service.js';
import { mlxHttpError } from '../../providers/mlx/runtime-diagnostics.js';
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

const REFUSAL = "The response format's schema cannot be enforced: Invalid type: bogus";

/** An MLX engine whose sidecar refuses the request's schema with its 422. */
async function startRefusingEngine(): Promise<RunningInferenceService> {
  home = await mkdtemp(join(tmpdir(), 'gezel-inference-'));
  class Session extends StreamingSessionBase {
    async sendAndWait(): Promise<string> {
      throw mlxHttpError(422, 'Unprocessable Entity', JSON.stringify({ detail: REFUSAL }));
    }
    providerState() {
      return {};
    }
    async disconnect() {}
  }
  const provider: LLMProvider = {
    name: 'mlx',
    supportsPriorMessages: true,
    initialize: async () => {},
    shutdown: async () => {},
    listModels: async () => [{ id: 'fixture', name: 'Fixture' }],
    createSession: async () => new Session(),
  };
  return await startService({ home, providers: new Map([['mlx', provider]]) });
}

function post(path: string, body: unknown): Promise<Response> {
  return running!.fetch(`http://gezel.local${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${running!.clientToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

const chat = {
  model: 'mlx:fixture',
  messages: [{ role: 'user', content: 'Name a pet.' }],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'pet', schema: { type: 'object', properties: { n: { type: 'bogus' } } } },
  },
};

// An SDK retries a 500 `server_error`; this request can never succeed, so the
// engine's refusal has to reach the caller as its own mistake.
describe('a response_format the engine cannot enforce', () => {
  it('is a 400 invalid_request_error on /v1/chat/completions', async () => {
    running = await startRefusingEngine();
    const res = await post('/v1/chat/completions', chat);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        message: REFUSAL,
        type: 'invalid_request_error',
        param: 'response_format',
        code: 'unsupported_response_format',
      },
    });
  });

  it('is an invalid_request_error envelope on a stream already under way', async () => {
    running = await startRefusingEngine();
    const res = await post('/v1/chat/completions', { ...chat, stream: true });
    expect(res.status).toBe(200);
    const body = await res.text();
    const envelope = body
      .split('\n')
      .filter((line) => line.startsWith('data: {"error"'))
      .map((line) => JSON.parse(line.slice('data: '.length)) as { error: unknown })[0];
    expect(envelope?.error).toEqual({
      message: REFUSAL,
      type: 'invalid_request_error',
      code: 'unsupported_response_format',
    });
  });

  it('is a 400 invalid_request_error on /v1/responses', async () => {
    running = await startRefusingEngine();
    const res = await post('/v1/responses', { model: 'mlx:fixture', input: 'Hi', store: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: {
        message: REFUSAL,
        type: 'invalid_request_error',
        code: 'unsupported_response_format',
      },
    });
  });
});
