import { describe, expect, it, vi } from 'vitest';
import { OFFLINE_RUNTIME_CAPABILITIES } from '../schemas/runtime-capabilities.js';
import {
  PORTABLE_LABELS_ONLY_WARNINGS,
  PORTABLE_UNREAD_IMAGE_WARNING,
  PORTABLE_UNSEEN_IMAGE_WARNING,
  type PortableInference,
  PortableProductService,
} from './product-service.js';
import { portableFixture } from './test-files.js';
import type { PortableVision } from './vision.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]);

async function fixture(host: { vision?: PortableVision } = {}) {
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
    generate: vi.fn(async () => ({ text: 'I cannot see it.', stopReason: 'stop' as const })),
    cancel: vi.fn(async () => {}),
  };
  const service = new PortableProductService(store, inference, 'secret', host);
  await service.initialize();
  const gezel = await store.createGezel({ name: 'Noor', role: 'Generalist' });
  const session = await store.createSession({ gezelId: gezel.id, providerName: 'llama-cpp' });
  const newDraft = () =>
    store.createPromptDraft(session.projectId, {
      gezelId: gezel.id,
      sessionId: session.id,
      content: 'What is this?',
    });
  let draft = await newDraft();
  const nextDraft = async () => {
    draft = await newDraft();
  };
  const settled = (turns: number) =>
    vi.waitFor(async () => {
      const saved = await store.getSession(gezel.id, session.id);
      expect(saved?.messages.filter((m) => m.role === 'assistant').length).toBe(turns);
      expect(saved?.turnStartedAt).toBeUndefined();
    });
  const send = async (message: string) => {
    const response = await service.fetch(`https://gezel.local/api/sessions/${session.id}/send`, {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
      body: JSON.stringify({ message, draftId: draft.id }),
    });
    await response.text();
    return response.status;
  };
  const attach = (name: string, bytes: Uint8Array) =>
    store.writeFileBytes(
      'artifacts',
      session.projectId,
      `prompts/${draft.id}/message_files/${name}`,
      bytes,
      { createOnly: true },
    );
  const sentMessages = (call = 0) =>
    (
      vi.mocked(inference.generate).mock.calls[call]![0] as {
        messages: Array<{ role: string; content: string }>;
      }
    ).messages;
  const sentText = (call = 0) => sentMessages(call).at(-1)!.content;
  const userMessage = async () =>
    (await store.getSession(gezel.id, session.id))?.messages.find((m) => m.role === 'user');
  return {
    store,
    service,
    inference,
    gezel,
    session,
    send,
    attach,
    sentText,
    sentMessages,
    userMessage,
    nextDraft,
    settled,
  };
}

describe('chat attachments on the portable host', () => {
  it('offers attachments to the phone composer', () => {
    expect(OFFLINE_RUNTIME_CAPABILITIES.chatAttachments).toBe(true);
  });

  it('tells a text-only model it cannot see an attached photo and warns the person', async () => {
    const f = await fixture();
    await f.attach('photo-2026-10-06-101500.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x10]));

    expect(
      await f.send('What is this?\n\n![Photo](message_files/photo-2026-10-06-101500.jpg)'),
    ).toBe(200);
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalled());

    const prompt = f.sentText();
    expect(prompt).toContain('/message_files/photo-2026-10-06-101500.jpg');
    expect(prompt).toContain('cannot see images');
    expect(prompt).not.toContain('�');
    const saved = await f.store.getSession(f.gezel.id, f.session.id);
    expect(saved?.messages.find((m) => m.role === 'user')?.warnings).toEqual([
      PORTABLE_UNSEEN_IMAGE_WARNING,
    ]);
  });

  it('notes a binary file instead of failing the send', async () => {
    const f = await fixture();
    await f.attach('brief.pdf', new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]));
    await f.attach('notes.md', new TextEncoder().encode('Remember the soil test.'));

    expect(
      await f.send(
        'Summarize\n\n[brief](message_files/brief.pdf)\n[notes](message_files/notes.md)',
      ),
    ).toBe(200);
    await vi.waitFor(() => expect(f.inference.generate).toHaveBeenCalled());

    const prompt = f.sentText();
    expect(prompt).toContain('is not text');
    expect(prompt).toContain('Remember the soil test.');
    const saved = await f.store.getSession(f.gezel.id, f.session.id);
    expect(saved?.messages.find((m) => m.role === 'user')?.warnings).toBeUndefined();
  });

  it('reads a photo on the device and replays the reading on later turns', async () => {
    const read = vi.fn<PortableVision['read']>(async () => ({
      description: 'A ripe tomato on a vine in a greenhouse.',
      labels: ['tomato', 'plant', 'greenhouse'],
      width: 1536,
      height: 2048,
      models: ['mlkit-genai-image-description', 'mlkit-image-labeling'],
    }));
    const f = await fixture({ vision: { read } });
    await f.attach('photo.jpg', JPEG);

    expect(await f.send('Is this ready to pick?\n\n![Photo](message_files/photo.jpg)')).toBe(200);
    await f.settled(1);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({ mimeType: 'image/jpeg' });
    const prompt = f.sentText();
    expect(prompt).toContain('A ripe tomato on a vine in a greenhouse.');
    expect(prompt).toContain('Scene labels: tomato, plant, greenhouse');
    expect(prompt).toContain('attached-image-1');
    expect(prompt).not.toContain('message_files/photo.jpg');
    expect(prompt).not.toContain('cannot see images');
    const user = await f.userMessage();
    expect(user?.warnings).toBeUndefined();
    expect(user?.recognizedImages).toEqual([
      expect.objectContaining({
        status: 'ok',
        modelId: 'mlkit-genai-image-description+mlkit-image-labeling',
      }),
    ]);
    expect(user?.content).toContain('message_files/photo.jpg');

    await f.nextDraft();
    expect(await f.send('And the one next to it?')).toBe(200);
    await f.settled(2);
    expect(read).toHaveBeenCalledTimes(1);
    const replayed = f
      .sentMessages(1)
      .find((m) => m.role === 'user' && m.content.includes('Is this ready to pick?'));
    expect(replayed?.content).toContain('A ripe tomato on a vine in a greenhouse.');
  });

  it('says when only labels reached the model', async () => {
    const read = vi.fn<PortableVision['read']>(async () => ({
      labels: ['dog', 'grass'],
      text: 'BEWARE OF DOG',
      models: ['apple-vision'],
      describer: 'not-installed' as const,
    }));
    const f = await fixture({ vision: { read } });
    await f.attach('photo.jpg', JPEG);

    expect(await f.send('What sign is this?\n\n![Photo](message_files/photo.jpg)')).toBe(200);
    await f.settled(1);

    expect(f.sentText()).toContain('BEWARE OF DOG');
    const user = await f.userMessage();
    expect(user?.recognizedImages?.[0]?.status).toBe('partial');
    expect(user?.warnings).toEqual([PORTABLE_LABELS_ONLY_WARNINGS['not-installed']]);
  });

  it('falls back to the cannot-see note when the recognizers fail', async () => {
    const read = vi.fn<PortableVision['read']>(async () => {
      throw new Error('Vision is unavailable');
    });
    const f = await fixture({ vision: { read } });
    await f.attach('photo.jpg', JPEG);

    expect(await f.send('What is this?\n\n![Photo](message_files/photo.jpg)')).toBe(200);
    await f.settled(1);

    expect(f.sentText()).toContain('cannot see images');
    const user = await f.userMessage();
    expect(user?.recognizedImages).toBeUndefined();
    expect(user?.warnings).toEqual([PORTABLE_UNREAD_IMAGE_WARNING]);
  });

  it('reads a photo whose name the editor percent-encoded', async () => {
    const read = vi.fn<PortableVision['read']>(async () => ({
      description: 'A garden bed.',
      models: ['apple-vision'],
    }));
    const f = await fixture({ vision: { read } });
    await f.attach('My Photo.jpg', JPEG);

    expect(await f.send('What grows here?\n\n![Photo](message_files/My%20Photo.jpg)')).toBe(200);
    await f.settled(1);

    expect(read).toHaveBeenCalledTimes(1);
    const prompt = f.sentText();
    expect(prompt).toContain('A garden bed.');
    expect(prompt).not.toContain('cannot see images');
    expect((await f.userMessage())?.warnings).toBeUndefined();
  });
});
