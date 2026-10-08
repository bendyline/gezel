import { describe, expect, it, vi } from 'vitest';
import type { ChatEventEnvelope } from '../schemas/gezel.js';
import type { ListRemindersResponse } from '../schemas/notifications.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { PortableScriptHost } from './script-host.js';
import { portableFixture } from './test-files.js';

const inference: PortableInference = {
  providers: async () => [],
  generate: vi.fn(async () => ({ text: '', stopReason: 'stop' as const })),
  cancel: vi.fn(async () => {}),
};

async function fixture() {
  const { store } = portableFixture();
  const service = new PortableProductService(store, inference, 'secret');
  await service.initialize();
  const events: ChatEventEnvelope[] = [];
  (
    service as unknown as {
      eventBus: { subscribeAll(listener: (e: ChatEventEnvelope) => void): () => void };
    }
  ).eventBus.subscribeAll((e) => events.push(e));
  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const response = await service.fetch(`https://gezel.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(200);
    return payload as T;
  };
  return { store, service, events, request };
}

describe('earned notifications on the phone', () => {
  it('announces finished work the person asked for, naming who did it', async () => {
    const { store, events, request } = await fixture();
    const gezelId = (await store.readConfig()).meesterGezelId!;
    const session = await store.createSession({
      gezelId,
      projectId: 'default',
      providerName: 'llama-cpp',
    });
    const asked = await store.createTask('default', {
      title: 'Plan the trip',
      description: 'Plan a weekend trip to the coast with train times and a budget.',
      assignee: { kind: 'gezel', gezelId },
      launchSessionId: session.id,
      steps: [{ name: 'Plan' }],
    });
    const background = await store.createTask('default', {
      title: 'Tidy notes',
      description: 'Tidy the notes folder into one summary file for the week.',
      assignee: { kind: 'gezel', gezelId },
      steps: [{ name: 'Tidy' }],
    });
    for (const task of [asked, background])
      await request(
        `/api/projects/default/tasks/${task.num}/steps/${task.activeStepId}/complete`,
        {},
      );
    expect((await store.getTask(asked.ref))?.status).toBe('complete');
    const settled = events.filter((e) => e.event.type === 'task_settled').map((e) => e.event);
    expect(settled).toEqual([
      {
        type: 'task_settled',
        taskRef: asked.ref,
        title: 'Plan the trip',
        outcome: 'complete',
        sessionId: session.id,
        gezelId,
      },
    ]);
  });

  it('keeps a reminder a script computed, and lists it for the notifier', async () => {
    const { store, service, events, request } = await fixture();
    const host = new PortableScriptHost(store);
    service.setScripts({
      setRemindersChanged: (listener: (projectId: string) => void) =>
        host.setRemindersChanged(listener),
    } as never);
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const context = {
      projectId: 'default',
      scriptName: 'deck-store',
      signal: new AbortController().signal,
    };
    await host.dispatch(context, 'reminder.set', {
      at,
      title: 'Cards are due',
      body: '4 cards to review',
    });
    const listed = await request<ListRemindersResponse>('/api/reminders');
    expect(listed.reminders).toEqual([
      expect.objectContaining({
        projectId: 'default',
        at,
        title: 'Cards are due',
        source: 'deck-store',
      }),
    ]);
    expect(events.map((e) => e.event)).toContainEqual({
      type: 'reminders_updated',
      projectId: 'default',
    });

    await host.dispatch(context, 'reminder.clear', {});
    expect((await request<ListRemindersResponse>('/api/reminders')).reminders).toEqual([]);
    await expect(
      host.dispatch(context, 'reminder.set', { at: '2020-01-01T00:00:00Z', title: 'Late' }),
    ).rejects.toThrow(/future/);
  });
});
