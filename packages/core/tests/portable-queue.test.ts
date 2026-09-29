import { describe, expect, it, vi } from 'vitest';
import { GezelClient } from '../../client/src/client.js';
import type { PortableFileEntry, PortableFileSystem } from '../src/runtime/files.js';
import { type PortableInference, PortableProductService } from '../src/runtime/product-service.js';
import { PortableStore } from '../src/runtime/store.js';
import type { ChatEventEnvelope } from '../src/schemas/gezel.js';
import { QueueStatusResponseSchema } from '../src/schemas/queue-status.js';

/**
 * The phone runs the desktop's queued execution model on one engine slot:
 * conversations wait their turn instead of being refused, and a busy
 * conversation queues its messages.
 */

class MemoryFiles implements PortableFileSystem {
  entries = new Map<string, Uint8Array | null>([['', null]]);
  async read(path: string) {
    const value = this.entries.get(path);
    return value ? value.slice() : null;
  }
  async mkdir(path: string) {
    for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
      this.entries.set(p, null);
    }
  }
  async write(path: string, data: Uint8Array) {
    const slash = path.lastIndexOf('/');
    if (slash > 0) await this.mkdir(path.slice(0, slash));
    this.entries.set(path, data.slice());
  }
  async list(path: string) {
    const prefix = path ? `${path}/` : '';
    return [...this.entries]
      .filter(
        ([name]) =>
          name !== path && name.startsWith(prefix) && !name.slice(prefix.length).includes('/'),
      )
      .map(
        ([name, data]): PortableFileEntry => ({
          name: name.slice(prefix.length),
          isDirectory: data === null,
          size: data?.length ?? 0,
          mtime: Date.now(),
        }),
      );
  }
  async remove(path: string) {
    for (const name of this.entries.keys())
      if (name === path || name.startsWith(`${path}/`)) this.entries.delete(name);
  }
  async rename(from: string, to: string) {
    const values = [...this.entries].filter(
      ([name]) => name === from || name.startsWith(`${from}/`),
    );
    for (const [name, data] of values) this.entries.set(to + name.slice(from.length), data);
    await this.remove(from);
  }
}

type Call = {
  prompt: string;
  requestId: string;
  onDelta: Parameters<PortableInference['generate']>[1];
  hooks: Parameters<PortableInference['generate']>[3];
  resolve: (value: { text: string; stopReason: 'stop' | 'cancelled' }) => void;
};

/** An engine the test answers by hand, one generation at a time. */
async function setup() {
  const calls: Call[] = [];
  const store = new PortableStore({ files: new MemoryFiles() });
  const service = new PortableProductService(
    store,
    {
      providers: async () => [
        {
          id: 'llama-cpp',
          name: 'Test local model',
          locality: 'on-device',
          availability: 'available',
          contextTokens: 32000,
          maxOutputTokens: 1000,
          capabilities: {
            text: true,
            tools: false,
            structuredOutput: false,
            images: false,
            foregroundOnly: true,
          },
        },
      ],
      generate: (request, onDelta, _onToolCall, hooks) =>
        new Promise((resolve) => {
          const users = request.messages.filter((message) => message.role === 'user');
          calls.push({
            prompt: users.at(-1)?.content ?? '',
            requestId: request.requestId,
            onDelta,
            hooks,
            resolve,
          });
        }),
      cancel: async (requestId) => {
        calls
          .find((call) => call.requestId === requestId)
          ?.resolve({ text: '', stopReason: 'cancelled' });
      },
    },
    'test-token',
  );
  await service.initialize();
  const client = new GezelClient({
    baseUrl: 'https://gezel.local',
    token: 'test-token',
    fetch: service.fetch,
  });
  const events: ChatEventEnvelope[] = [];
  const stream = await service.fetch(client.allEventsUrl(), {
    headers: { authorization: 'Bearer test-token' },
  });
  const reader = stream.body!.getReader();
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (frame.startsWith('data: ')) events.push(JSON.parse(frame.slice(6)));
      }
    }
  })();
  /** Answer the `index`th generation once it has been requested. */
  const answer = async (index: number, text = `reply ${index + 1}`) => {
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(index));
    const call = calls[index]!;
    call.onDelta({ requestId: call.requestId, delta: text });
    call.resolve({ text, stopReason: 'stop' });
  };
  const { gezels } = await client.listGezels();
  const gezelId = gezels[0]!.id;
  const settled = async () => {
    await vi.waitFor(() => expect(service.busy).toBe(false));
  };
  const typesFor = (sessionId: string) =>
    events.filter((e) => e.sessionId === sessionId).map((e) => e.event.type);
  return {
    store,
    service,
    client,
    calls,
    answer,
    events,
    typesFor,
    gezelId,
    settled,
    stop: () => reader.cancel(),
  };
}

describe('portable queued execution', () => {
  it('queues a second conversation behind the engine instead of refusing it', async () => {
    const f = await setup();
    const a = await f.client.createChatSession({ gezelId: f.gezelId });
    const b = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(a.id, { message: 'first' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await expect(f.client.sendToChatSession(b.id, { message: 'second' })).resolves.toMatchObject({
      accepted: true,
    });
    const { inflight } = await f.client.listInflightTurns();
    expect(inflight.map((turn) => turn.sessionId).sort()).toEqual([a.id, b.id].sort());
    // Only one generation reaches the engine at a time.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(f.calls).toHaveLength(1);
    expect(f.typesFor(b.id)).toContain('queued');
    await f.answer(0);
    await f.answer(1);
    await f.settled();
    expect(f.calls.map((call) => call.prompt)).toEqual(['first', 'second']);
    const saved = await f.client.getChatSession(b.id);
    expect(saved.messages.map((m) => m.content)).toEqual(['second', 'reply 2']);
    await f.stop();
  });

  it('stops a waiting turn before it reaches the engine and leaves the running one alone', async () => {
    const f = await setup();
    const a = await f.client.createChatSession({ gezelId: f.gezelId });
    const b = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(a.id, { message: 'running' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(b.id, { message: 'waiting' });
    await expect(f.client.cancelChatSessionTurn(b.id)).resolves.toMatchObject({ cancelled: true });
    const stopped = await f.client.getChatSession(b.id);
    expect(stopped.lastTurnError).toContain('stopped before it began');
    expect(stopped.turnStartedAt).toBeUndefined();
    await f.answer(0);
    await f.settled();
    expect(f.calls).toHaveLength(1);
    expect((await f.client.getChatSession(a.id)).messages.at(-1)?.content).toBe('reply 1');
    await f.stop();
  });

  it('queues messages to a busy conversation and merges consecutive nudges into one turn', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'long question' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(session.id, { message: 'nudge one', nudge: true });
    await f.client.sendToChatSession(session.id, { message: 'nudge two', nudge: true });
    const queued = await f.client.listSessionQueue(session.id);
    expect(queued.entries.map((entry) => [entry.text, entry.nudge])).toEqual([
      ['nudge one', true],
      ['nudge two', true],
    ]);
    await f.answer(0);
    await f.answer(1, 'merged reply');
    await f.settled();
    const saved = await f.client.getChatSession(session.id);
    const users = saved.messages.filter((m) => m.role === 'user');
    expect(users.map((m) => m.content)).toEqual(['long question', 'nudge one\n\nnudge two']);
    expect(users[1]?.nudge).toBe(true);
    expect(f.calls).toHaveLength(2);
    await f.stop();
  });

  it('edits and discards queued messages in place', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'busy' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(session.id, { message: 'typo' });
    await f.client.sendToChatSession(session.id, { message: 'drop me' });
    const [first, second] = (await f.client.listSessionQueue(session.id)).entries;
    await expect(
      f.client.updateQueuedMessage(session.id, first!.queueId, { message: 'fixed' }),
    ).resolves.toMatchObject({ updated: true, entry: { text: 'fixed' } });
    await expect(f.client.cancelQueuedMessage(session.id, second!.queueId)).resolves.toEqual({
      cancelled: true,
    });
    await f.answer(0);
    await f.answer(1);
    await f.settled();
    expect(f.calls.map((call) => call.prompt)).toEqual(['busy', 'fixed']);
    await f.stop();
  });

  it('interrupts the running turn and runs the new message ahead of the queue', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'long job' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(session.id, { message: 'later' });
    await f.client.interruptChatSession(session.id, { message: 'do this instead' });
    await f.answer(1, 'redirected');
    await f.answer(2, 'then this');
    await f.settled();
    expect(f.calls.map((call) => call.prompt)).toEqual(['long job', 'do this instead', 'later']);
    const saved = await f.client.getChatSession(session.id);
    expect(saved.messages.find((m) => m.stopReason === 'cancelled')).toBeDefined();
    await f.stop();
  });

  it('holds work that had not started while the app is in the background', async () => {
    const f = await setup();
    const a = await f.client.createChatSession({ gezelId: f.gezelId });
    const b = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(a.id, { message: 'running' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(b.id, { message: 'waiting' });
    await f.client.sendToChatSession(a.id, { message: 'queued follow-up' });
    await f.service.suspend();
    // The running turn was interrupted and never replays.
    expect((await f.client.getChatSession(a.id)).messages.at(-1)?.stopReason).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.calls).toHaveLength(1);
    expect(f.service.busy).toBe(true);
    await expect(f.client.sendToChatSession(b.id, { message: 'while away' })).rejects.toMatchObject(
      { status: 409 },
    );
    f.service.resume();
    await f.answer(1, 'resumed');
    await f.answer(2, 'follow-up answered');
    await f.settled();
    expect(f.calls.map((call) => call.prompt)).toEqual(['running', 'waiting', 'queued follow-up']);
    await f.stop();
  });

  it('reports the queue in the daemon wire shape and lets a waiting item be dropped', async () => {
    const f = await setup();
    const a = await f.client.createChatSession({ gezelId: f.gezelId });
    const b = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(a.id, { message: 'running' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    await f.client.sendToChatSession(b.id, { message: 'waiting' });
    await f.client.sendToChatSession(a.id, { message: 'queued' });
    const status = await f.client.getQueueStatus();
    expect(QueueStatusResponseSchema.safeParse(status).success).toBe(true);
    const llama = status.providers['llama-cpp']!;
    expect(llama).toMatchObject({ running: 1, queuedInteractive: 1, maxConcurrency: 1 });
    expect(status.sessions).toMatchObject([{ sessionId: a.id, depth: 1 }]);
    const pendingId = llama.pending[0]!.id;
    await expect(
      f.client.cancelProviderQueueItem('android-mlkit', pendingId),
    ).resolves.toMatchObject({ cancelled: false });
    await expect(f.client.cancelProviderQueueItem('llama-cpp', pendingId)).resolves.toMatchObject({
      cancelled: true,
    });
    await expect(f.client.cancelProviderQueueItem('ollama', pendingId)).rejects.toMatchObject({
      status: 404,
    });
    await f.answer(0);
    await f.answer(1);
    await f.settled();
    expect(f.calls.map((call) => call.prompt)).toEqual(['running', 'queued']);
    await f.stop();
  });

  it('lets a text transform wait for the engine instead of refusing it', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'busy' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const transformed = f.client.rewriteText({ text: 'A rough paragraph.' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(f.calls).toHaveLength(1);
    await f.answer(0);
    await f.answer(1, 'A polished paragraph.');
    await expect(transformed).resolves.toMatchObject({ text: 'A polished paragraph.' });
    await f.settled();
    await f.stop();
  });

  it('reports engine phases for the phone provider', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'hello' });
    await f.answer(0);
    await f.settled();
    const phases = f.events
      .filter((e) => e.sessionId === session.id && e.event.type === 'engine_phase')
      .map((e) => (e.event.type === 'engine_phase' ? [e.event.provider, e.event.phase] : []));
    expect(phases).toEqual([
      ['llama-cpp', 'prefill'],
      ['llama-cpp', 'generating'],
    ]);
    await f.stop();
  });

  it('shows native prompt progress in the desktop engines’ words', async () => {
    const f = await setup();
    const session = await f.client.createChatSession({ gezelId: f.gezelId });
    await f.client.sendToChatSession(session.id, { message: 'hello' });
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    const call = f.calls[0]!;
    // Past the four-a-second limit on repeats of one phase.
    await new Promise((resolve) => setTimeout(resolve, 300));
    call.hooks?.onPhase?.({
      requestId: call.requestId,
      phase: 'prefill',
      promptTokens: 1000,
      processedTokens: 500,
      progress: 0.5,
    });
    await f.answer(0);
    await f.settled();
    const details = f.events.flatMap((e) =>
      e.sessionId === session.id && e.event.type === 'engine_phase' && e.event.detail
        ? [e.event.detail]
        : [],
    );
    expect(details).toContain('Processing prompt (50% · 500 / 1,000 tokens)');
    await f.stop();
  });

  it('says a response never started when the app closed while it waited', async () => {
    const f = await setup();
    const session = await f.store.createSession({ gezelId: f.gezelId, providerName: 'llama-cpp' });
    session.messages.push({ id: 'u1', role: 'user', content: 'waiting', at: session.createdAt });
    session.turnStartedAt = session.createdAt;
    await f.store.writeSession(session);
    await f.service.initialize();
    const saved = await f.store.getSession(f.gezelId, session.id);
    expect(saved?.lastTurnError).toContain('before this response started');
    await f.stop();
  });
});
