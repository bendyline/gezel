import type { ProjectCompletionResponse } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { ModelNotInstalledError } from '../../providers/types.js';
import type { ServiceContext } from '../context.js';
import { completionRoutes, completionTuning, parseJsonAnswer } from './completions.js';

type OneShot = ServiceContext['chat']['oneShotCompletion'];

function app(answer: OneShot, gezels: string[] = ['writer']) {
  const calls: Array<{ prompt: string; timeoutMs: number | undefined; opts: unknown }> = [];
  const ctx = {
    store: {
      getProject: async (id: string) => {
        if (id !== 'stories') throw new Error('not found');
        return { id };
      },
      getGezel: async (id: string) => {
        if (!gezels.includes(id)) throw new Error('not found');
        return { id };
      },
    },
    chat: {
      oneShotCompletion: (async (prompt, timeoutMs, opts) => {
        calls.push({ prompt, timeoutMs, opts });
        return answer(prompt, timeoutMs, opts);
      }) as OneShot,
    },
  } as unknown as ServiceContext;
  return { routes: completionRoutes(ctx), calls };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /:id/completions', () => {
  it('runs one structured call with the request tuning and a verbatim system message', async () => {
    const { routes, calls } = app(async () => '{"ok":true}');
    const res = await routes.request(
      '/stories/completions',
      post({
        gezelId: 'writer',
        system: 'You check facts.',
        prompt: 'Check S1.',
        jsonSchema: { type: 'object' },
        temperature: 0.1,
        maxTokens: 4000,
        thinking: false,
        timeoutMs: 90_000,
        label: 'check · Taylorville',
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as ProjectCompletionResponse;
    expect(body).toMatchObject({ content: '{"ok":true}', json: { ok: true } });
    expect(typeof body.elapsedMs).toBe('number');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe('Check S1.');
    expect(calls[0]?.timeoutMs).toBe(90_000);
    expect(calls[0]?.opts).toMatchObject({
      gezelId: 'writer',
      systemMessage: 'You check facts.',
      projectId: 'stories',
      jobLabel: 'check · Taylorville',
      tuning: {
        sampling: { temperature: 0.1, maxTokens: 4000 },
        reasoning: { enableThinking: false },
        output: { jsonSchema: { type: 'object' } },
      },
    });
  });

  it('sends no system message and no tuning layers the caller did not ask for', async () => {
    const { routes, calls } = app(async () => 'plain answer');
    const res = await routes.request(
      '/stories/completions',
      post({ prompt: 'Say hi.', provider: 'llama-cpp', model: 'gemma4-31b-q4' }),
    );
    expect(await res.json()).toMatchObject({ content: 'plain answer' });
    expect(calls[0]?.opts).toMatchObject({
      providerName: 'llama-cpp',
      model: 'gemma4-31b-q4',
      systemMessage: '',
      tuning: {},
    });
    expect((await routes.request('/stories/completions', post({ prompt: 'x' }))).status).toBe(200);
  });

  it('reports an unparseable structured answer instead of failing the call', async () => {
    const { routes } = app(async () => 'not json');
    const body = (await (
      await routes.request('/stories/completions', post({ prompt: 'x', jsonSchema: {} }))
    ).json()) as ProjectCompletionResponse;
    expect(body.content).toBe('not json');
    expect(body.jsonError).toBeTruthy();
    expect(body.json).toBeUndefined();
  });

  it('answers 404 for an unknown project or gezel before any model work', async () => {
    const { routes, calls } = app(async () => 'x');
    expect((await routes.request('/nope/completions', post({ prompt: 'x' }))).status).toBe(404);
    expect(
      (await routes.request('/stories/completions', post({ prompt: 'x', gezelId: 'ghost' })))
        .status,
    ).toBe(404);
    expect(calls).toHaveLength(0);
  });

  // 5xx bodies are made opaque by the HTTP layer, so these must be 4xx.
  it('keeps the outcomes a workflow acts on readable: timeout, engine not ready, missing model', async () => {
    const failing = (err: unknown) =>
      app(async () => {
        throw err;
      }).routes.request('/stories/completions', post({ prompt: 'x' }));

    const timeout = Object.assign(new Error('one-shot timed out after 90s'), {
      name: 'TimeoutError',
    });
    const slow = await failing(timeout);
    expect(slow.status).toBe(408);
    expect(await slow.json()).toEqual({
      error: 'one-shot timed out after 90s',
      code: 'completion_timeout',
    });

    const downloading = Object.assign(new Error('On-device engine is downloading.'), {
      isActionable: true,
    });
    const notReady = await failing(downloading);
    expect(notReady.status).toBe(409);
    expect(await notReady.json()).toMatchObject({ code: 'provider_unavailable' });

    const missing = await failing(new ModelNotInstalledError('llama-cpp', 'gemma9'));
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: 'model_not_installed' });

    await expect(failing(new Error('socket hang up'))).resolves.toHaveProperty('status', 500);
  });
});

describe('completion helpers', () => {
  it('maps only the fields that were given', () => {
    expect(completionTuning({})).toEqual({});
    expect(completionTuning({ thinking: true })).toEqual({ reasoning: { enableThinking: true } });
    expect(completionTuning({ maxTokens: 10 })).toEqual({ sampling: { maxTokens: 10 } });
  });

  it('tolerates a Markdown fence around grammar-constrained JSON', () => {
    expect(parseJsonAnswer('```json\n{"a":1}\n```')).toEqual({ json: { a: 1 } });
    expect(parseJsonAnswer(' [1,2] ')).toEqual({ json: [1, 2] });
    expect(parseJsonAnswer('{')).toHaveProperty('jsonError');
  });
});
