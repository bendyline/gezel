import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { portableFixture } from '../src/runtime/test-files.js';
import type { TransformStreamEvent } from '../src/schemas/api.js';

async function fixture(overrides: Partial<PortableInference> = {}) {
  const f = portableFixture();
  const requests: Parameters<PortableInference['generate']>[0][] = [];
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Fixture',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 8192,
        maxOutputTokens: 4096,
        capabilities: {
          text: true,
          tools: false,
          structuredOutput: false,
          images: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: async (request, delta) => {
      requests.push(request);
      delta({
        requestId: request.requestId,
        delta: '<think>Checking meaning</think>```md\nEdited text\n```',
      });
      return { text: '<think>Checking meaning</think>```md\nEdited text\n```', stopReason: 'stop' };
    },
    cancel: async () => {},
    ...overrides,
  };
  const service = new PortableProductService(f.store, inference, 'secret');
  await service.initialize();
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'secret',
    fetch: service.fetch,
  });
  return { ...f, service, client, requests, inference };
}
async function run(client: GezelClient, body = { mode: 'rewrite' as const, text: 'Original' }) {
  const events: TransformStreamEvent[] = [];
  await client.transformTextStream(body, (event) => events.push(event));
  return events;
}

describe('the shared editor transform API on an offline product host', () => {
  it('streams the configured Klerk with exact provider/model budgets and leaves the source untouched', async () => {
    const f = await fixture();
    const klerk = await f.store.createGezel({
      name: 'Mira',
      role: 'Klerk',
      about: 'Preserve the voice.',
      model: 'fixture-model',
    });
    await f.store.writeConfig({
      klerkGezelId: klerk.id,
      modelContextOverrides: { 'llama-cpp:fixture-model': 8192 },
      modelTuning: { 'fixture-model': { sampling: { maxTokens: 2000 } } },
    });
    await f.store.writeFile('workspace', 'default', 'draft.md', 'Original');
    const events = await run(f.client);
    expect(events[0]).toEqual({ type: 'status', phase: 'started' });
    expect(events).toContainEqual({ type: 'thinking-delta', text: 'Checking meaning' });
    expect(events.at(-1)).toEqual({ type: 'done', text: 'Edited text' });
    expect(f.requests[0]).toMatchObject({
      providerId: 'llama-cpp',
      modelId: 'fixture-model',
      contextSize: 8192,
      maxTokens: 2000,
    });
    expect(f.requests[0]?.messages[0]?.content).toContain(klerk.about);
    expect(f.requests[0]?.messages[1]?.content).toContain('Rewrite ONLY that fragment');
    expect(await f.store.readFile('workspace', 'default', 'draft.md')).toBe('Original');
    expect(await f.store.listSessions()).toEqual([]);
    expect(f.service.busy).toBe(false);
    expect(f.service.capabilities.textTransforms).toBe(true);
  });

  it('reuses a lazily recruited Klerk and retains the legacy rewrite contract', async () => {
    const f = await fixture();
    expect(await f.client.rewriteText({ text: 'Original' })).toEqual({ text: 'Edited text' });
    const id = (await f.store.readConfig()).klerkGezelId;
    expect(id).toBeTruthy();
    await run(f.client);
    expect((await f.store.readConfig()).klerkGezelId).toBe(id);
    expect((await f.store.listGezels()).filter((g) => g.role === 'Klerk')).toHaveLength(1);
  });

  it.each([
    { mode: 'insert', text: '' },
    { mode: 'rewrite', text: '  ' },
  ])('rejects invalid editor requests before recruitment: %j', async (body) => {
    const f = await fixture();
    await expect(
      f.client.transformTextStream(
        body as Parameters<GezelClient['transformTextStream']>[0],
        () => {},
      ),
    ).rejects.toThrow();
    expect((await f.store.readConfig()).klerkGezelId).toBeUndefined();
    expect(f.requests).toEqual([]);
    expect(f.service.busy).toBe(false);
  });

  it.each(['length', 'cancelled'] as const)(
    'keeps %s output out of the Apply result',
    async (stopReason) => {
      const f = await fixture({
        generate: async (_request, delta) => {
          delta({ requestId: _request.requestId, delta: 'Partial text' });
          return { text: 'Partial text', stopReason };
        },
      });
      const events = await run(f.client);
      expect(events.at(-1)?.type).toBe('error');
      expect(events.some((event) => event.type === 'done')).toBe(false);
      expect(f.service.busy).toBe(false);
    },
  );

  it('cancels through the native release barrier when the editor closes, while rejecting competing work', async () => {
    let finish!: (value: Awaited<ReturnType<PortableInference['generate']>>) => void;
    const started = vi.fn();
    const cancel = vi.fn(async () => finish({ text: '', stopReason: 'cancelled' }));
    const f = await fixture({
      generate: async () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      cancel,
    });
    const controller = new AbortController();
    const pending = f.client
      .transformTextStream({ mode: 'rewrite', text: 'Original' }, () => {}, controller.signal)
      .catch(() => {});
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    expect(f.service.busy).toBe(true);
    await expect(f.service.withModelChange(async () => {})).rejects.toThrow('text transform');
    controller.abort();
    await pending;
    await vi.waitFor(() => expect(f.service.busy).toBe(false));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('stops active text work on backgrounding and permits only an explicit fresh attempt on return', async () => {
    let finish!: (value: Awaited<ReturnType<PortableInference['generate']>>) => void;
    const started = vi.fn();
    const f = await fixture({
      generate: async () => {
        started();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      cancel: async () => finish({ text: '', stopReason: 'cancelled' }),
    });
    const pending = run(f.client);
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    await f.service.suspend();
    expect((await pending).at(-1)?.type).toBe('error');
    await expect(run(f.client)).rejects.toThrow();
    f.service.resume();
    expect(started).toHaveBeenCalledOnce();
    expect(f.service.busy).toBe(false);
  });
});
