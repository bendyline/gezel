import { EngineBusyError } from '@bendyline/gezel-inference/internal/providers/native/capacity-broker';
import { describe, expect, it } from 'vitest';
import type { ServiceContext } from '../context.js';
import { promptAssistRoutes } from './prompt-assist.js';

type OneShot = ServiceContext['chat']['oneShotCompletion'];

function app(answer: OneShot) {
  const calls: Array<{ prompt: string; opts: unknown }> = [];
  const ctx = {
    store: {
      getProject: async (id: string) => {
        if (id !== 'cards') throw new Error('not found');
        return { id };
      },
      getGezel: async (id: string) => (id === 'ada' ? { id, name: 'Ada' } : null),
    },
    chat: {
      oneShotCompletion: (async (prompt, timeoutMs, opts) => {
        calls.push({ prompt, opts });
        return answer(prompt, timeoutMs, opts);
      }) as OneShot,
    },
    imageProvider: {
      providerForModel: async () => ({
        name: 'google-ai',
        listInstalledModels: async () => [],
      }),
    },
    catalog: { get: async () => null },
  } as unknown as ServiceContext;
  return { routes: promptAssistRoutes(ctx), calls };
}

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('POST /:id/prompt-assist', () => {
  it('rewrites a draft on the interactive lane with the recipient named', async () => {
    const { routes, calls } = app(
      async () => '<message>Please draft the deck by Friday.</message>',
    );
    const res = await routes.request(
      '/cards/prompt-assist',
      post({ action: 'clarify', text: 'deck friday pls', gezelId: 'ada' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Please draft the deck by Friday.' });
    expect(calls[0]?.prompt).toContain('about to send to Ada');
    expect(calls[0]?.opts).toMatchObject({
      gezelId: 'ada',
      projectId: 'cards',
      lane: 'interactive',
      tuning: { reasoning: { enableThinking: false } },
    });
  });

  it('gives an image rewrite the drawing model’s guide', async () => {
    const { routes, calls } = app(
      async () => '<message>Three red cubes on an oak table.</message>',
    );
    const res = await routes.request(
      '/cards/prompt-assist',
      post({ action: 'shape-image', text: 'three red cubes', imageModel: 'gpt-image-2' }),
    );
    expect(res.status).toBe(200);
    expect(calls[0]?.prompt).toContain('The model that will draw it: gpt-image-2 reads plain');
  });

  it('returns review suggestions', async () => {
    const { routes } = app(async () => '- Say who the deck is for\n- Give a slide count');
    const res = await routes.request(
      '/cards/prompt-assist',
      post({ action: 'review', text: 'make a deck' }),
    );
    expect(await res.json()).toEqual({
      suggestions: ['Say who the deck is for', 'Give a slide count'],
    });
  });

  it('leaves the draft alone when the answer is unusable or the engine is busy', async () => {
    const unchanged = await app(async () => '<message>deck friday pls</message>').routes.request(
      '/cards/prompt-assist',
      post({ action: 'proofread', text: 'deck friday pls' }),
    );
    expect(await unchanged.json()).toEqual({ text: 'deck friday pls', unchanged: true });
    const unusable = await app(async () => '<message></message>').routes.request(
      '/cards/prompt-assist',
      post({ action: 'proofread', text: 'deck friday pls' }),
    );
    expect(unusable.status).toBe(422);
    expect(((await unusable.json()) as { error: string }).error).toContain('unchanged');
    const busy = await app(async () => {
      throw new EngineBusyError('engine busy');
    }).routes.request('/cards/prompt-assist', post({ action: 'shorten', text: 'a long message' }));
    expect(busy.status).toBe(409);
  });
});
