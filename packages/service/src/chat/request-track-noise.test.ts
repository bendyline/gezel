import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActivityStatusResponse, ListRequestsResponse } from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryManager } from '../memory/manager.js';
import { MockProvider } from '../providers/mock.js';
import { type RunningService, startService } from '../service.js';
import { ChatEventBus } from './events.js';
import { ChatManager } from './manager.js';

/**
 * The noise budget for one request. The bakery's first invoice put three
 * craftbook cards, a failed call and a task id in front of its owner; however
 * noisy the turn that launches the work, the person gets one tracker and one
 * Activity row, and it ends Ready with the file they asked for.
 */

const noopMemory = {
  save: async () => {},
  search: async () => [],
  reindex: async () => 0,
  writeSummary: async () => {},
  getRecent: async () => '',
} as unknown as MemoryManager;

let svc: RunningService;
let home: string;
let httpFetch: typeof fetch;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-request-noise-'));
  svc = await startService({ home });
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
}, 30_000);

async function get<T>(path: string): Promise<T> {
  const base = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  const res = await httpFetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${svc.context.token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe('one request, one tracker', () => {
  it('stays one tracker and one Activity row through a noisy launch, and ends Ready', async () => {
    const store = svc.context.store;
    await store.writeProjectCraftbook('default', {
      id: 'invoice-pdf',
      name: 'Invoice PDF',
      version: '1.0.0',
      entryStepId: 'make',
      steps: [
        {
          id: 'make',
          name: 'Make the invoice PDF',
          // Nothing runs a model here: the step waits for the person.
          assignee: { kind: 'user' },
          advanceWhen: { file: '{{task.dir}}/invoice.pdf', artifact: true },
          terminal: true,
        },
      ],
      createdAt: '2026-10-23T00:00:00.000Z',
      updatedAt: '2026-10-23T00:00:00.000Z',
    });
    await store.writeConfig({ provider: 'copilot', toolFilterMode: 'never' });
    const mock = new MockProvider({ name: 'copilot' });
    const manager = new ChatManager({
      store,
      events: new ChatEventBus(),
      memory: noopMemory,
      getPort: () => svc.port,
      getToken: () => svc.context.token,
      getCert: () => svc.cert?.certPem ?? null,
      home,
      providers: [['copilot', mock]],
      catalog: svc.context.catalog,
      secrets: svc.context.secrets,
      history: svc.context.history,
    });
    const lead = await store.createGezel({ name: 'Pia', role: 'Planner' });
    const thread = await manager.createSession({ gezelId: lead.id });

    const invoke = { name: 'invoke_craftbook', arguments: { craftbookId: 'invoice-pdf' } };
    mock.scriptToolCalls([invoke, invoke]);
    mock.scriptToolCalls([invoke, { name: 'invoke_craftbook', arguments: { craftbookId: 7 } }]);
    mock.script('Your invoice PDF is underway.', 'Your invoice PDF is underway.');
    await manager.send(thread.id, 'Make my October invoice as a PDF');
    // The runtime may stop a batch early; what matters is that it was noisy.
    expect(
      mock.toolCallOutputs.filter((o) => o.name === 'invoke_craftbook').length,
    ).toBeGreaterThanOrEqual(2);

    const launched = await get<ListRequestsResponse>(`/api/requests?sessions=${thread.id}`);
    expect(launched.requests).toHaveLength(1);
    const track = launched.requests[0]!;
    expect(track).toMatchObject({ kind: 'work', summary: 'Make my October invoice as a PDF' });
    expect(track.state).not.toBe('ready');

    const task = (await store.listProjectTasks('default')).find((t) => t.ref === track.taskRefs[0]);
    if (!task) throw new Error('the launch made no task');
    await store.writeProjectArtifact('default', `${task.artifactDir}/invoice.pdf`, '%PDF-1.4');
    await svc.context.tasks.completeStep('default', task.num, 'make');
    await expect
      .poll(async () => {
        const record = await store.findSessionById(thread.id);
        return record?.messages.some((m) => m.synthetic === 'task-wrapup');
      })
      .toBe(true);

    const ready = await get<ListRequestsResponse>(`/api/requests?sessions=${thread.id}`);
    expect(ready.requests).toHaveLength(1);
    expect(ready.requests[0]).toMatchObject({
      key: track.key,
      stop: 'ready',
      state: 'ready',
      deliverable: { path: `${task.artifactDir}/invoice.pdf` },
    });

    const activity = await get<ActivityStatusResponse>('/api/activity');
    const refs = new Set(ready.requests[0]!.taskRefs);
    const rows = activity.items.filter(
      (item) => item.requestKey === track.key || (item.taskRef && refs.has(item.taskRef)),
    );
    expect(rows.map((r) => r.id)).toEqual([`request:${track.key}`]);
  });
});
