import {
  MobileModelInventorySchema,
  type MobileProvider,
  type MobileProviderId,
  type MobileState,
  MobileStateSchema,
} from '@bendyline/gezel/schemas';
import { describe, expect, it, vi } from 'vitest';
import { createMobileClient } from './client.js';
import type { MobileInference, MobileRuntimeOptions } from './contracts.js';
import { searchConversations } from './store.js';

function provider(id: MobileProviderId = 'llama-cpp'): MobileProvider {
  return {
    id,
    name: id,
    locality: 'on-device',
    availability: 'available',
    contextTokens: 32_768,
    maxOutputTokens: 8_192,
    capabilities: {
      text: true,
      tools: false,
      structuredOutput: false,
      images: false,
      foregroundOnly: true,
    },
  };
}

interface Generation {
  request: Parameters<MobileInference['generate']>[0];
  delta: Parameters<MobileInference['generate']>[1];
  resolve: (value: Awaited<ReturnType<MobileInference['generate']>>) => void;
  reject(error: Error): void;
}

function fixture(raw: string | null = null) {
  let stored = raw;
  let nextId = 0;
  const generations: Generation[] = [];
  const options: MobileRuntimeOptions = {
    createId: () => `id_${++nextId}`,
    now: () => '2026-09-20T00:00:00.000Z',
    storage: {
      load: vi.fn(async () => stored),
      save: vi.fn(async (data) => {
        stored = data;
      }),
    },
    inference: {
      providers: vi.fn(async () => [provider(), provider('apple-foundation-models')]),
      generate: vi.fn<MobileInference['generate']>(
        (request, delta) =>
          new Promise((resolve, reject) => {
            generations.push({ request, delta, resolve, reject });
          }),
      ),
      cancel: vi.fn(async () => {}),
    },
  };
  return {
    options,
    client: createMobileClient(options),
    generations,
    data: () => stored,
    saved: () => MobileStateSchema.parse(JSON.parse(stored!)),
    async generation(index = 0): Promise<Generation> {
      await vi.waitFor(() => expect(generations.length).toBeGreaterThan(index), { interval: 1 });
      return generations[index]!;
    },
  };
}

describe('foreground mobile conversations', () => {
  it('persists a named Meester, explicit poppetje, default project, and isolated snapshots', async () => {
    const f = fixture();
    const snapshot = await f.client.snapshot();
    expect(snapshot.state.gezel).toMatchObject({ id: 'meester', name: 'Mira', role: 'Meester' });
    expect(snapshot.state.gezel.poppetje.key).toBe('meester');
    expect(snapshot.state.project.id).toBe('default');
    expect(f.saved()).toEqual(snapshot.state);
    snapshot.state.gezel.name = 'Edited outside the store';
    expect((await f.client.snapshot()).state.gezel.name).toBe('Mira');
    expect(f.options.storage.save).toHaveBeenCalledTimes(1);
  });

  it.each(['', '{invalid', '{"version":2}', '{"version":1}'])(
    'preserves invalid stored data: %s',
    async (raw) => {
      const f = fixture(raw);
      await expect(f.client.snapshot()).rejects.toThrow('have not been replaced');
      expect(f.data()).toBe(raw);
      expect(f.options.storage.save).not.toHaveBeenCalled();
    },
  );

  it('recovers an unfinished reply without regenerating it or changing the poppetje', async () => {
    const initial = fixture();
    const state = (await initial.client.snapshot()).state;
    state.sessions[0]!.messages.push(
      {
        id: 'user_1',
        role: 'user',
        content: 'Hello',
        at: initial.options.now(),
        status: 'complete',
      },
      {
        id: 'assistant_1',
        role: 'assistant',
        content: 'Part of a reply',
        at: initial.options.now(),
        status: 'streaming',
      },
    );
    const f = fixture(JSON.stringify(state));
    const recovered = await f.client.snapshot();
    expect(recovered.state.sessions[0]!.messages[1]).toMatchObject({
      content: 'Part of a reply',
      status: 'interrupted',
      stopReason: 'cancelled',
    });
    expect(recovered.state.gezel.poppetje).toEqual(state.gezel.poppetje);
    expect(f.saved()).toEqual(recovered.state);
    expect(f.options.inference.generate).not.toHaveBeenCalled();
  });

  it('persists the user before inference and reconciles lost deltas from final text', async () => {
    const f = fixture();
    const listener = vi.fn();
    const unsubscribe = f.client.subscribe(listener);
    const send = f.client.send('Help me plan');
    const generation = await f.generation();
    expect(f.saved().sessions[0]!.messages).toMatchObject([
      { role: 'user', content: 'Help me plan', status: 'complete' },
      { role: 'assistant', content: '', status: 'streaming' },
    ]);
    expect(generation.request.messages).toMatchObject([
      { role: 'system' },
      { role: 'user', content: 'Help me plan' },
    ]);
    generation.delta({ requestId: generation.request.requestId, delta: 'First' });
    expect((await f.client.snapshot()).state.sessions[0]!.messages[1]!.content).toBe('First');
    generation.resolve({ text: 'First, choose one priority.', stopReason: 'stop' });
    const result = await send;
    expect(result.activeRequestId).toBeNull();
    expect(result.state.sessions[0]!.messages[1]).toMatchObject({
      content: 'First, choose one priority.',
      status: 'complete',
    });
    expect(f.saved()).toEqual(result.state);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('serializes concurrent conversation mutations', async () => {
    const f = fixture();
    await f.client.snapshot();
    let activeWrites = 0;
    let maxWrites = 0;
    const save = f.options.storage.save;
    f.options.storage.save = async (data) => {
      maxWrites = Math.max(maxWrites, ++activeWrites);
      await Promise.resolve();
      await save(data);
      activeWrites--;
    };
    await Promise.all([f.client.newConversation(), f.client.newConversation()]);
    expect(maxWrites).toBe(1);
    expect(f.saved().sessions).toHaveLength(3);
    expect(new Set(f.saved().sessions.map((session) => session.id)).size).toBe(3);
  });

  it('restores the selected conversation and supplies only its history to the model', async () => {
    const f = fixture();
    const firstSend = f.client.send('First conversation');
    (await f.generation()).resolve({ text: 'First reply', stopReason: 'stop' });
    const firstId = (await firstSend).state.activeSessionId;
    const secondId = (await f.client.newConversation()).state.activeSessionId;
    const secondSend = f.client.send('Second conversation');
    const second = await f.generation(1);
    expect(second.request.messages.map((message) => message.content)).not.toContain('First reply');
    second.resolve({ text: 'Second reply', stopReason: 'stop' });
    await secondSend;
    await f.client.selectConversation(firstId);
    const restored = fixture(f.data());
    const snapshot = await restored.client.snapshot();
    expect(snapshot.state.activeSessionId).toBe(firstId);
    expect(
      snapshot.state.sessions.find((session) => session.id === secondId)!.messages[1]!.content,
    ).toBe('Second reply');
    expect(restored.options.storage.save).not.toHaveBeenCalled();
  });

  it('rejects overlapping sends and navigation during an active response', async () => {
    const f = fixture();
    const send = f.client.send('First');
    await f.generation();
    await expect(f.client.send('Second')).rejects.toThrow('Stop the current response');
    await expect(f.client.newConversation()).rejects.toThrow('Stop the current response');
    await expect(f.client.selectConversation('id_1')).rejects.toThrow('Stop the current response');
    await f.client.cancel();
    await send;
    expect(f.options.inference.generate).toHaveBeenCalledTimes(1);
  });

  it('persists cancellation and ignores callbacks and completion from an older request', async () => {
    const f = fixture();
    const firstSend = f.client.send('First');
    const first = await f.generation();
    first.delta({ requestId: first.request.requestId, delta: 'Partial reply' });
    await f.client.cancel();
    expect((await firstSend).state.sessions[0]!.messages[1]).toMatchObject({
      content: 'Partial reply',
      status: 'interrupted',
    });
    expect(f.options.inference.cancel).toHaveBeenCalledWith(first.request.requestId);
    const secondSend = f.client.send('Second');
    const second = await f.generation(1);
    first.delta({ requestId: first.request.requestId, delta: ' stale' });
    second.delta({ requestId: first.request.requestId, delta: ' wrong id' });
    first.resolve({ text: 'Old final reply', stopReason: 'stop' });
    second.resolve({ text: 'New final reply', stopReason: 'stop' });
    const result = await secondSend;
    expect(result.state.sessions[0]!.messages.map((message) => message.content)).toEqual([
      'First',
      'Partial reply',
      'Second',
      'New final reply',
    ]);
  });

  it('keeps the run busy until native cancellation has completed', async () => {
    const f = fixture();
    const send = f.client.send('First');
    await f.generation();
    let stopped!: () => void;
    f.options.inference.cancel = () =>
      new Promise<void>((resolve) => {
        stopped = resolve;
      });
    const cancel = f.client.cancel();
    await vi.waitFor(() => expect(stopped).toBeTypeOf('function'), { interval: 1 });
    await expect(f.client.send('Too soon')).rejects.toThrow('Stop the current response');
    expect((await f.client.snapshot()).activeRequestId).not.toBeNull();
    stopped();
    expect((await cancel).activeRequestId).toBeNull();
    await send;
  });

  it('does not invoke inference if the user message cannot be saved', async () => {
    const f = fixture();
    await f.client.snapshot();
    const before = f.data();
    const save = f.options.storage.save;
    f.options.storage.save = async () => {
      throw new Error('Disk full');
    };
    await expect(f.client.send('Keep this safe')).rejects.toThrow('Could not save');
    expect(f.data()).toBe(before);
    expect(f.options.inference.generate).not.toHaveBeenCalled();
    expect((await f.client.snapshot()).persistenceError).toContain('Disk full');
    f.options.storage.save = save;
    expect((await f.client.retrySave()).persistenceError).toBeNull();
    expect(f.data()).toBe(before);
    expect(f.options.inference.generate).not.toHaveBeenCalled();
  });

  it('never reports completion before its final write and permits saving again after failure', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    const save = f.options.storage.save;
    f.options.storage.save = async () => {
      throw new Error('Disk full');
    };
    const failed = expect(send).rejects.toThrow('Could not save');
    generation.resolve({ text: 'A useful reply', stopReason: 'stop' });
    await failed;
    expect(f.saved().sessions[0]!.messages[1]!.status).toBe('streaming');
    expect((await f.client.snapshot()).state.sessions[0]!.messages[1]!.status).toBe('complete');
    f.options.storage.save = save;
    await f.client.retrySave();
    expect(f.saved().sessions[0]!.messages[1]).toMatchObject({
      content: 'A useful reply',
      status: 'complete',
      stopReason: 'stop',
    });
  });

  it('records model failures and preserves the user turn', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    generation.reject(new Error('Select a model first'));
    const result = await send;
    expect(result.state.sessions[0]!.messages).toMatchObject([
      { content: 'Hello', role: 'user' },
      { role: 'assistant', status: 'error', error: 'Select a model first' },
    ]);
    expect(f.saved()).toEqual(result.state);
  });

  it.each(['completion', 'cancellation'] as const)(
    'awaits final persistence and seals deltas during %s',
    async (terminal) => {
      const f = fixture();
      const send = f.client.send('Hello');
      const generation = await f.generation();
      generation.delta({ requestId: generation.request.requestId, delta: 'Partial' });
      let writeStarted = false;
      let releaseWrite!: () => void;
      const blocked = new Promise<void>((resolve) => {
        releaseWrite = resolve;
      });
      const save = f.options.storage.save;
      f.options.storage.save = async (data) => {
        writeStarted = true;
        await blocked;
        await save(data);
      };
      let settled = false;
      void send.then(() => {
        settled = true;
      });
      const cancel = terminal === 'cancellation' ? f.client.cancel() : undefined;
      if (terminal === 'completion')
        generation.resolve({ text: 'Authoritative', stopReason: 'stop' });
      await vi.waitFor(() => expect(writeStarted).toBe(true), { interval: 1 });
      generation.delta({ requestId: generation.request.requestId, delta: ' late token' });
      expect(settled).toBe(false);
      expect(f.saved().sessions[0]!.messages[1]!.status).toBe('streaming');
      releaseWrite();
      const result = await send;
      if (cancel) await cancel;
      expect(result.state.sessions[0]!.messages[1]).toMatchObject({
        content: terminal === 'completion' ? 'Authoritative' : 'Partial',
        status: terminal === 'completion' ? 'complete' : 'interrupted',
      });
      expect(f.saved()).toEqual(result.state);
    },
  );

  it('rejects an overlong context without silently trimming or changing its history', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    generation.resolve({ text: 'x'.repeat(24_000), stopReason: 'length' });
    await send;
    const before = f.data();
    await expect(f.client.send('Continue')).rejects.toThrow('Start a new conversation');
    expect(f.data()).toBe(before);
    expect(f.generations).toHaveLength(1);
  });

  it('stops oversized streamed output without letting a late completion overwrite the error', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    let cancelled!: () => void;
    f.options.inference.cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cancelled = resolve;
        }),
    );
    generation.delta({ requestId: generation.request.requestId, delta: 'x'.repeat(64_001) });
    await vi.waitFor(() => expect(f.options.inference.cancel).toHaveBeenCalled(), { interval: 1 });
    await expect(f.client.send('Next')).rejects.toThrow('Stop the current response');
    expect((await f.client.snapshot()).activeRequestId).toBe(generation.request.requestId);
    cancelled();
    const result = await send;
    generation.resolve({ text: 'Late', stopReason: 'stop' });
    expect(result.state.sessions[0]!.messages[1]).toMatchObject({ content: '', status: 'error' });
    expect(f.saved().sessions[0]!.messages[1]!.status).toBe('error');
  });

  it('records an empty model completion as an error instead of a completed placeholder', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    generation.resolve({ text: '', stopReason: 'stop' });
    const result = await send;
    expect(result.state.sessions[0]!.messages[1]).toMatchObject({
      status: 'error',
      error: 'The model finished without a reply. Please try again.',
    });
  });

  it('rejects invalid inputs and missing conversations without changing stored data', async () => {
    const f = fixture();
    await f.client.snapshot();
    const before = f.data();
    await expect(f.client.send('  ')).rejects.toThrow('Write a message');
    await expect(f.client.send('x'.repeat(16_001))).rejects.toThrow('too long');
    await expect(f.client.selectConversation('absent')).rejects.toThrow('could not be found');
    expect(f.data()).toBe(before);
  });

  it('does not silently repair a persisted conversation with inconsistent references', async () => {
    const f = fixture();
    const state: MobileState = (await f.client.snapshot()).state;
    state.activeSessionId = 'missing';
    const raw = JSON.stringify(state);
    const corrupt = fixture(raw);
    await expect(corrupt.client.snapshot()).rejects.toThrow('have not been replaced');
    expect(corrupt.options.storage.save).not.toHaveBeenCalled();
  });

  it('migrates the original v1 state to an explicit llama.cpp preference without relabeling history', async () => {
    const original = fixture();
    const state = (await original.client.snapshot()).state;
    const { selectedProviderId: _, ...legacy } = state;
    const raw = JSON.stringify(legacy);
    const f = fixture(raw);
    expect((await f.client.snapshot()).state.selectedProviderId).toBe('llama-cpp');
    expect(f.saved().selectedProviderId).toBe('llama-cpp');
    expect(f.saved().gezel).toEqual(state.gezel);
    expect(f.options.storage.save).toHaveBeenCalledTimes(1);
    const failed = fixture(raw);
    failed.options.storage.save = async () => {
      throw new Error('Read-only storage');
    };
    await expect(failed.client.snapshot()).rejects.toThrow('Read-only storage');
    expect(failed.data()).toBe(raw);
  });

  it('persists an explicit provider and pins its identity on the request and response', async () => {
    const f = fixture();
    await f.client.setProvider('apple-foundation-models');
    expect(f.saved().selectedProviderId).toBe('apple-foundation-models');
    const send = f.client.send('Hello');
    const generation = await f.generation();
    expect(generation.request.providerId).toBe('apple-foundation-models');
    await expect(f.client.setProvider('llama-cpp')).rejects.toThrow('Stop the current response');
    generation.resolve({ text: 'Reply', stopReason: 'stop' });
    expect((await send).state.sessions[0]!.messages[1]!.providerId).toBe('apple-foundation-models');
  });

  it.each(['unavailable', 'download-required', 'downloading'] as const)(
    'checks fresh provider availability (%s) before recording a user turn and never falls back',
    async (availability) => {
      const f = fixture();
      await f.client.setProvider('apple-foundation-models');
      const before = f.data();
      f.options.inference.providers = async () => [
        provider(),
        {
          ...provider('apple-foundation-models'),
          availability,
          reason: 'Provider needs attention',
        },
      ];
      await expect(f.client.send('Hello')).rejects.toThrow('Provider needs attention');
      await expect(f.client.setProvider('apple-foundation-models')).rejects.toThrow(
        'Provider needs attention',
      );
      expect(f.data()).toBe(before);
      expect(f.options.inference.generate).not.toHaveBeenCalled();
      expect((await f.client.snapshot()).state.selectedProviderId).toBe('apple-foundation-models');
    },
  );

  it('rejects missing or malformed provider inventories without writes or fallback', async () => {
    const f = fixture();
    await f.client.snapshot();
    const before = f.data();
    f.options.inference.providers = async () => [provider('apple-foundation-models')];
    await expect(f.client.send('Hello')).rejects.toThrow('unavailable');
    f.options.inference.providers = async () => [provider(), provider()];
    await expect(f.client.send('Hello')).rejects.toThrow('Duplicate mobile provider');
    expect(f.data()).toBe(before);
    expect(f.options.inference.generate).not.toHaveBeenCalled();
  });

  it('leaves provider choice unchanged when its persistence fails', async () => {
    const f = fixture();
    await f.client.snapshot();
    const before = f.data();
    f.options.storage.save = async () => {
      throw new Error('Disk full');
    };
    await expect(f.client.setProvider('apple-foundation-models')).rejects.toThrow('Could not save');
    expect(f.data()).toBe(before);
    expect((await f.client.snapshot()).state.selectedProviderId).toBe('llama-cpp');
  });

  it('applies provider-sized context and response allocation bounds', async () => {
    const f = fixture();
    await f.client.snapshot();
    f.options.inference.providers = async () => [
      { ...provider(), contextTokens: 2_048, maxOutputTokens: 64 },
    ];
    const before = f.data();
    await expect(f.client.send('x'.repeat(8_000))).rejects.toThrow('too long for the mobile model');
    expect(f.data()).toBe(before);
    const send = f.client.send('Hello');
    (await f.generation()).resolve({ text: 'x'.repeat(513), stopReason: 'length' });
    expect((await send).state.sessions[0]!.messages[1]!.status).toBe('error');
  });

  it('renames, searches locally, deletes, and replaces the final conversation durably', async () => {
    const f = fixture();
    const firstId = (await f.client.snapshot()).state.activeSessionId;
    await f.client.renameConversation(firstId, '  Weekend plans  ');
    const send = f.client.send('Find a trail');
    (await f.generation()).resolve({ text: 'Try the coast', stopReason: 'stop' });
    await send;
    const secondId = (await f.client.newConversation()).state.activeSessionId;
    const state = (await f.client.snapshot()).state;
    expect(searchConversations(state, 'WEEKEND').map(({ id }) => id)).toEqual([firstId]);
    expect(searchConversations(state, 'coast').map(({ id }) => id)).toEqual([firstId]);
    expect(searchConversations(state, 'missing')).toEqual([]);
    expect(state.sessions).toHaveLength(2);
    await f.client.deleteConversation(secondId);
    expect(f.saved().activeSessionId).toBe(firstId);
    await f.client.deleteConversation(firstId);
    const final = f.saved();
    expect(final.sessions).toHaveLength(1);
    expect(final.sessions[0]!.messages).toEqual([]);
    expect(final.activeSessionId).not.toBe(firstId);
    expect(final.activeSessionId).not.toBe(secondId);
  });

  it.each(['rename', 'delete'] as const)(
    'preserves all stored conversations after a failed %s',
    async (operation) => {
      const f = fixture();
      const snapshot = await f.client.snapshot();
      const before = f.data();
      f.options.storage.save = async () => {
        throw new Error('Disk full');
      };
      const change =
        operation === 'rename'
          ? f.client.renameConversation(snapshot.state.activeSessionId, 'New name')
          : f.client.deleteConversation(snapshot.state.activeSessionId);
      await expect(change).rejects.toThrow('Could not save');
      expect(f.data()).toBe(before);
      expect((await f.client.snapshot()).state).toEqual(snapshot.state);
    },
  );

  it('retains a failed cancellation barrier until the original inference actually settles', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    generation.delta({ requestId: generation.request.requestId, delta: 'Partial' });
    f.options.inference.cancel = async () => {
      throw new Error('Native cancellation failed');
    };
    await expect(f.client.cancel()).rejects.toThrow('has not confirmed it stopped');
    const blocked = await f.client.snapshot();
    expect(blocked.activeRequestId).toBe(generation.request.requestId);
    expect(blocked.cancellationError).toContain('Native cancellation failed');
    expect(f.saved().sessions[0]!.messages[1]!.status).toBe('streaming');
    await expect(f.client.send('Too soon')).rejects.toThrow('Stop the current response');
    await expect(f.client.deleteConversation(blocked.state.activeSessionId)).rejects.toThrow(
      'Stop the current response',
    );
    await expect(
      f.client.renameConversation(blocked.state.activeSessionId, 'Rename'),
    ).rejects.toThrow('Stop the current response');
    await expect(f.client.retrySave()).rejects.toThrow('Stop the model');
    generation.delta({ requestId: generation.request.requestId, delta: ' ignored' });
    generation.resolve({ text: 'Late final text', stopReason: 'stop' });
    const settled = await send;
    expect(settled.activeRequestId).toBeNull();
    expect(settled.cancellationError).toBeNull();
    expect(f.saved().sessions[0]!.messages[1]).toMatchObject({
      content: 'Partial',
      status: 'interrupted',
      stopReason: 'cancelled',
    });
  });

  it('permits retrying a failed cancellation without letting the old request overwrite the new one', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    f.options.inference.cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('Busy'))
      .mockResolvedValue(undefined);
    await expect(f.client.cancel()).rejects.toThrow('Retry stopping');
    await f.client.cancel();
    await send;
    const nextSend = f.client.send('Next');
    const next = await f.generation(1);
    generation.resolve({ text: 'Old', stopReason: 'stop' });
    next.resolve({ text: 'New', stopReason: 'stop' });
    expect((await nextSend).state.sessions[0]!.messages[3]!.content).toBe('New');
  });

  it('retains an overflow abort barrier after cancellation fails and saves the original error', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    const generation = await f.generation();
    f.options.inference.cancel = async () => {
      throw new Error('Busy');
    };
    generation.delta({ requestId: generation.request.requestId, delta: 'x'.repeat(64_001) });
    await vi.waitFor(
      async () => expect((await f.client.snapshot()).cancellationError).toContain('Busy'),
      { interval: 1 },
    );
    await expect(f.client.send('Too soon')).rejects.toThrow('Stop the current response');
    generation.resolve({ text: 'Late', stopReason: 'stop' });
    expect((await send).state.sessions[0]!.messages[1]).toMatchObject({
      status: 'error',
      error: 'The model response exceeded the supported size.',
    });
  });

  it('omits failed whole pairs but keeps useful interrupted context without orphan messages', async () => {
    const f = fixture();
    const failed = f.client.send('Failed question');
    (await f.generation()).reject(new Error('Provider refused'));
    await failed;
    const stopped = f.client.send('Stopped question');
    const second = await f.generation(1);
    second.delta({ requestId: second.request.requestId, delta: 'Partial' });
    await f.client.cancel();
    await stopped;
    const successful = f.client.send('Successful question');
    (await f.generation(2)).resolve({ text: 'Successful answer', stopReason: 'stop' });
    await successful;
    const next = f.client.send('Next question');
    const fourth = await f.generation(3);
    expect(fourth.request.messages.slice(1)).toEqual([
      { role: 'user', content: 'Stopped question' },
      { role: 'assistant', content: 'Partial' },
      { role: 'user', content: 'Successful question' },
      { role: 'assistant', content: 'Successful answer' },
      { role: 'user', content: 'Next question' },
    ]);
    fourth.resolve({ text: 'Next answer', stopReason: 'stop' });
    expect((await next).state.sessions[0]!.messages).toHaveLength(8);
  });

  it('distinguishes recovered cancellation from a subsequent terminal persistence failure', async () => {
    const f = fixture();
    const send = f.client.send('Hello');
    await f.generation();
    f.options.inference.cancel = vi
      .fn()
      .mockRejectedValueOnce(new Error('Busy'))
      .mockResolvedValue(undefined);
    await expect(f.client.cancel()).rejects.toThrow('Retry stopping');
    const save = f.options.storage.save;
    f.options.storage.save = async () => {
      throw new Error('Disk full');
    };
    const failed = expect(send).rejects.toThrow('Could not save');
    await expect(f.client.cancel()).rejects.toThrow('Could not save');
    await failed;
    const snapshot = await f.client.snapshot();
    expect(snapshot.cancellationError).toBeNull();
    expect(snapshot.persistenceError).toContain('Disk full');
    f.options.storage.save = save;
    expect((await f.client.retrySave()).activeRequestId).toBeNull();
  });

  it.each(['error', 'interrupted'] as const)(
    'preserves a terminal %s and its cause through a save retry',
    async (status) => {
      const f = fixture();
      const send = f.client.send('Hello');
      const generation = await f.generation();
      const save = f.options.storage.save;
      f.options.storage.save = async () => {
        throw new Error('Disk full');
      };
      const failed = expect(send).rejects.toThrow('Could not save');
      if (status === 'error') generation.reject(new Error('Model error'));
      else generation.resolve({ text: 'Partial', stopReason: 'cancelled' });
      await failed;
      const terminal = (await f.client.snapshot()).state.sessions[0]!.messages[1];
      f.options.storage.save = save;
      await f.client.retrySave();
      expect(f.saved().sessions[0]!.messages[1]).toEqual(terminal);
      expect(terminal!.status).toBe(status);
    },
  );

  it('rejects corrupt native model inventory references, duplicates, and unbounded metadata', () => {
    const model = { id: 'one', name: 'Model', sizeBytes: 1024 };
    expect(
      MobileModelInventorySchema.parse({ models: [model], selectedModelId: 'one' }).models,
    ).toEqual([model]);
    for (const inventory of [
      { models: [model], selectedModelId: 'missing' },
      { models: [model, model] },
      { models: [{ ...model, id: '../escape' }] },
      { models: [{ ...model, sizeBytes: 4 * 1024 ** 3 + 1 }] },
      { models: [{ ...model, name: 'x'.repeat(201) }] },
    ])
      expect(MobileModelInventorySchema.safeParse(inventory).success).toBe(false);
  });
});
