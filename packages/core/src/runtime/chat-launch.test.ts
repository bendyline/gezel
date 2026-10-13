import { describe, expect, it, vi } from 'vitest';
import type { CatalogItemDetail } from '../schemas/catalog.js';
import { CraftbookSchema } from '../schemas/craftbook.js';
import type { ChatMessage } from '../schemas/gezel.js';
import { type PortableInference, PortableProductService } from './product-service.js';
import { portableFixture } from './test-files.js';

const book = CraftbookSchema.parse({
  id: 'notes-book',
  name: 'Notes to actions',
  createdAt: '2026-09-20T12:00:00Z',
  updatedAt: '2026-09-20T12:00:00Z',
  entryStepId: 'read',
  steps: [
    {
      id: 'read',
      name: 'Read the notes',
      terminal: true,
      // Nothing runs in these tests: the step waits for the person.
      assignee: { kind: 'user' },
    },
  ],
});
const item = {
  kind: 'craftbook-template',
  id: 'notes-book',
  sourceId: 'bundled',
  manifest: { version: '1.0.0' },
} as unknown as CatalogItemDetail;

async function fixture() {
  const { store } = portableFixture();
  const inference: PortableInference = {
    providers: async () => [
      {
        id: 'llama-cpp',
        name: 'Local fixture',
        locality: 'on-device',
        availability: 'available',
        contextTokens: 32000,
        maxOutputTokens: 1000,
        capabilities: {
          text: true,
          tools: false,
          images: false,
          structuredOutput: false,
          foregroundOnly: true,
        },
      },
    ],
    generate: vi.fn(async () => ({ text: 'Done.', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret');
  service.setContent({ templates: [], craftbooks: [{ item, book }] });
  await service.initialize();
  const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
  const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
  const launch = async (body: Record<string, unknown>) => {
    const response = await service.fetch(
      `https://gezel.local/api/sessions/${session.id}/launch-task`,
      {
        method: 'POST',
        headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const messages = async () =>
    ((await store.getSession(gezel.id, session.id))?.messages ?? []) as ChatMessage[];
  const tasks = () => store.listTasks({ projectId: session.projectId });
  return { store, gezel, session, launch, messages, tasks };
}

const message = 'Turn these meeting notes into actions for the team.';

describe('phone chat launch', () => {
  it('sends a drafted message with its receipt and marks the draft sent', async () => {
    const { store, gezel, session, launch, messages, tasks } = await fixture();
    const draft = await store.createPromptDraft(session.projectId, {
      gezelId: gezel.id,
      sessionId: session.id,
      content: message,
    });
    const first = await launch({
      message,
      draftId: draft.id,
      launch: { craftbookId: 'notes-book' },
    });
    expect(first.status).toBe(201);
    const thread = await messages();
    expect(thread.at(-2)).toMatchObject({ role: 'user', draftId: draft.id });
    expect(thread.at(-1)).toMatchObject({ synthetic: 'craftbook-launch' });
    expect((await store.getPromptDraft(session.projectId, draft.id))?.status).toBe('sent');
    expect(await tasks()).toHaveLength(1);

    const retry = await launch({
      message,
      draftId: draft.id,
      launch: { craftbookId: 'notes-book' },
    });
    expect(retry.status).toBe(200);
    expect(retry.body.reused).toBe(true);
    expect(await messages()).toHaveLength(thread.length);
    expect(await tasks()).toHaveLength(1);
  });

  it('writes a lost receipt for the live task instead of starting a second one', async () => {
    const { store, session, launch, messages, tasks } = await fixture();
    const first = await launch({ message, launch: { craftbookId: 'notes-book' } });
    const ref = (first.body.task as { ref: string }).ref;
    const saved = (await store.getSession(session.gezelId, session.id))!;
    saved.messages = saved.messages.slice(0, -2);
    await store.writeSession(saved);

    const again = await launch({ message, launch: { craftbookId: 'notes-book' } });
    expect(again.status).toBe(201);
    expect((again.body.task as { ref: string }).ref).toBe(ref);
    expect(await tasks()).toHaveLength(1);
    expect((await messages()).at(-1)).toMatchObject({ synthetic: 'craftbook-launch' });
  });

  it('starts a new run once the earlier one is no longer live', async () => {
    const { store, launch, tasks } = await fixture();
    const first = await launch({ message, launch: { craftbookId: 'notes-book' } });
    await store.setTaskStatus((first.body.task as { ref: string }).ref, 'canceled');
    const again = await launch({ message, launch: { craftbookId: 'notes-book' } });
    expect(again.status).toBe(201);
    expect(again.body.reused).toBe(false);
    expect(await tasks()).toHaveLength(2);
  });

  it('keeps a thread title the person already has, and refuses a run tonight', async () => {
    const { store, session, launch } = await fixture();
    const titled = (await store.getSession(session.gezelId, session.id))!;
    titled.title = 'Monday planning';
    await store.writeSession(titled);
    await launch({ message, launch: { craftbookId: 'notes-book' } });
    expect((await store.getSession(session.gezelId, session.id))?.title).toBe('Monday planning');

    const tonight = await launch({ message, launch: { craftbookId: 'notes-book', tonight: true } });
    expect(tonight.status).toBe(501);
  });
});
