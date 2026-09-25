import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ChatSession,
  Craftbook,
  LaunchTaskFromSessionResponse,
  PromptDraft,
} from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../../service.js';

/**
 * `POST /api/sessions/:id/launch-task` — the chat composer's attached task.
 * The message becomes the task's brief without a model turn; the thread
 * gets the message and a receipt; a retried POST finds what it already made.
 */

let svc: RunningService;
let baseUrl: string;
let token: string;
let home: string;
let httpFetch: typeof fetch;
let projectId: string;
let gezelId: string;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;

const DECK_BOOK: Craftbook = {
  id: 'topic-deck',
  name: 'Topic Deck',
  version: '1.0.0',
  paramSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', title: 'Topic' },
      audience: { type: 'string', title: 'Audience', default: 'everyone' },
      slides: { type: 'number', title: 'Slides' },
    },
  },
  steps: [{ id: 'write', name: 'Write the deck', prompt: 'Write a deck about {{topic}}.' }],
  entryStepId: 'write',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-launch-task-'));
  svc = await startService({ home });
  const scheme = svc.cert ? 'https' : 'http';
  baseUrl = `${scheme}://127.0.0.1:${svc.port}`;
  token = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  projectId = (await svc.context.store.createProject({ name: 'Launch from chat' })).id;
  await svc.context.store.writeProjectCraftbook(projectId, DECK_BOOK);
  await svc.context.store.writeProjectCraftbook('default', DECK_BOOK);
  gezelId = (await svc.context.store.createGezel({ name: 'Wren', role: 'Meester' })).id;
}, 30_000);

afterAll(async () => {
  await svc.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
}, 30_000);

function authed(path: string, init: RequestInit = {}) {
  return httpFetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function openSession(project = projectId): Promise<ChatSession> {
  const res = await authed('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ gezelId, projectId: project }),
  });
  return (await res.json()) as ChatSession;
}

function launch(sessionId: string, body: unknown) {
  return authed(`/api/sessions/${sessionId}/launch-task`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions/:id/launch-task', () => {
  it('creates the task from the message, records both messages, and marks the draft sent', async () => {
    const session = await openSession();
    const draftRes = await authed(`/api/projects/${projectId}/prompt-drafts`, {
      method: 'POST',
      body: JSON.stringify({
        gezelId,
        sessionId: session.id,
        content: 'A short deck about Delft',
        taskLaunch: { craftbookId: 'topic-deck', params: {}, origin: 'user' },
      }),
    });
    const draft = (await draftRes.json()) as PromptDraft;

    const res = await launch(session.id, {
      message: 'A short deck about Delft',
      draftId: draft.id,
      launch: { craftbookId: 'topic-deck', params: { slides: 6 } },
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as LaunchTaskFromSessionResponse;

    expect(out.reused).toBe(false);
    expect(out.task.projectId).toBe(projectId);
    expect(out.task.title).toBe('Topic Deck');
    expect(out.task.launchSessionId).toBe(session.id);
    expect(out.task.createdBy).toEqual({ kind: 'user' });
    expect(out.task.origin?.kind).toBe('craftbook-invocation');
    // The message filled the book's main content param; the number was
    // stringified like every other launcher's; the default stayed.
    expect(out.task.craftbookParams).toMatchObject({
      topic: 'A short deck about Delft',
      slides: '6',
      audience: 'everyone',
    });
    // Too short for the create minimum, so the daemon padded it — but the
    // person's words come first and verbatim.
    expect(out.task.description?.startsWith('A short deck about Delft')).toBe(true);
    expect(out.task.description?.length).toBeGreaterThanOrEqual(40);

    expect(out.userMessage).toMatchObject({
      role: 'user',
      content: 'A short deck about Delft',
      draftId: draft.id,
    });
    expect(out.receipt.synthetic).toBe('craftbook-launch');
    expect(out.receipt.toolCalls?.[0]?.card).toMatchObject({
      kind: 'craftbook-start',
      taskRef: out.task.ref,
      craftbookName: 'Topic Deck',
    });

    const stored = (await (await authed(`/api/sessions/${session.id}`)).json()) as ChatSession;
    expect(stored.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    const sentDraft = (await (
      await authed(`/api/projects/${projectId}/prompt-drafts/${draft.id}`)
    ).json()) as PromptDraft;
    expect(sentDraft.status).toBe('sent');
    expect(sentDraft.sentSessionId).toBe(session.id);
  });

  it('answers a retried POST with the same task and receipt, appending nothing', async () => {
    const session = await openSession();
    const body = {
      message: 'Please make a deck about the canals of Delft for the new hires this spring.',
      launch: { craftbookId: 'topic-deck', params: { audience: 'new hires' } },
    };
    const first = (await (await launch(session.id, body)).json()) as LaunchTaskFromSessionResponse;
    const secondRes = await launch(session.id, body);
    expect(secondRes.status).toBe(200);
    const second = (await secondRes.json()) as LaunchTaskFromSessionResponse;

    expect(second.reused).toBe(true);
    expect(second.task.ref).toBe(first.task.ref);
    expect(second.receipt.at).toBe(first.receipt.at);
    const stored = (await (await authed(`/api/sessions/${session.id}`)).json()) as ChatSession;
    expect(stored.messages).toHaveLength(2);
    expect(await svc.context.tasks.list({ projectId })).toHaveLength(2);
  });

  it('launches in the Default project like anywhere else', async () => {
    const session = await openSession('default');
    const res = await launch(session.id, {
      message: '',
      launch: { craftbookId: 'topic-deck', params: { topic: 'Windmills' } },
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as LaunchTaskFromSessionResponse;
    expect(out.task.projectId).toBe('default');
    expect(out.task.craftbookParams?.topic).toBe('Windmills');
    expect(out.task.description).toBe('Run the "Topic Deck" craftbook against this project.');
    expect(out.userMessage.content).toBe('');
  });

  it('previews a trigger-phrase proposal for a coordinator, and never a prelude for it', async () => {
    await svc.context.store.writeProjectCraftbook(projectId, {
      ...DECK_BOOK,
      id: 'topic-deck-triggered',
      name: 'Triggered Deck',
      triggers: ['make me a topic deck'],
    });
    const preview = async (gezel: string) =>
      (
        await authed('/api/sessions/turn-intent-preview', {
          method: 'POST',
          body: JSON.stringify({
            message: 'Please make me a topic deck about the harbour',
            gezelId: gezel,
            projectId,
          }),
        })
      ).json() as Promise<{ visible: boolean; reason: string; craftbook?: { id: string } }>;

    const plan = await preview(gezelId);
    expect(plan).toMatchObject({
      visible: true,
      reason: 'trigger-phrase',
      craftbook: {
        id: 'topic-deck-triggered',
        invocation: { params: { topic: 'the harbour' } },
      },
    });

    const worker = await svc.context.store.createGezel({ name: 'Pim', role: 'Developer' });
    expect((await preview(worker.id)).visible).toBe(false);
  });

  it('refuses an unknown session, an unknown draft, and an unavailable craftbook', async () => {
    const session = await openSession();
    const launchBody = { craftbookId: 'topic-deck', params: {} };
    expect((await launch('nope', { message: 'x', launch: launchBody })).status).toBe(404);
    expect(
      (
        await launch(session.id, {
          message: 'x',
          draftId: '2026-01-01-0099',
          launch: launchBody,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await launch(session.id, {
          message: 'x',
          launch: { craftbookId: 'no-such-book', params: {} },
        })
      ).status,
    ).toBe(404);
  });
});
