import { describe, expect, it } from 'vitest';
import { ChatModelInstallRegistry } from './install-registry.js';

type TestEvent = { type: string; error?: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('ChatModelInstallRegistry', () => {
  it('keeps the install running after every subscriber detaches', async () => {
    const gate = deferred();
    let sawFinally = false;
    let doneHookFired = false;
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      run: async function* () {
        try {
          yield { type: 'progress' };
          await gate.promise;
          yield { type: 'done' };
        } finally {
          sawFinally = true;
        }
      },
      onDone: () => {
        doneHookFired = true;
      },
    });

    registry.start('m', undefined);
    await tick();
    const seen: string[] = [];
    const unsubscribe = registry.subscribe('m', (e) => seen.push(e.type));
    expect(unsubscribe).not.toBeNull();
    expect(seen).toEqual(['progress']);

    // The consumer "disconnects" mid-download — the install must keep going.
    unsubscribe?.();
    gate.resolve();
    await tick();
    expect(sawFinally).toBe(true);
    expect(doneHookFired).toBe(true);
    expect(registry.get('m')).toMatchObject({ finished: true });
    expect(registry.get('m')?.error).toBeUndefined();
  });

  it('replays the last progress and terminal events to a late subscriber', async () => {
    const gate = deferred();
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      run: async function* () {
        yield { type: 'progress' };
        yield { type: 'verifying' };
        await gate.promise;
        yield { type: 'done' };
      },
    });
    registry.start('m', undefined);
    await tick();

    const midway: string[] = [];
    registry.subscribe('m', (e) => midway.push(e.type));
    expect(midway).toEqual(['verifying']);

    gate.resolve();
    await tick();
    const afterTerminal: string[] = [];
    registry.subscribe('m', (e) => afterTerminal.push(e.type));
    expect(afterTerminal).toEqual(['verifying', 'done']);
  });

  it('start is idempotent while an install is in flight', async () => {
    const gate = deferred();
    let runs = 0;
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      run: async function* () {
        runs += 1;
        yield { type: 'progress' };
        await gate.promise;
        yield { type: 'done' };
      },
    });
    expect(registry.start('m', undefined)).toEqual({ alreadyRunning: false });
    await tick();
    expect(registry.start('m', undefined)).toEqual({ alreadyRunning: true });
    gate.resolve();
    await tick();
    expect(runs).toBe(1);
  });

  it('cancel unwinds the generator mid-download and surfaces a terminal error', async () => {
    let sawFinally = false;
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      run: async function* () {
        try {
          // Endless download loop — only cancel can end this install.
          while (true) {
            yield { type: 'progress' };
            await tick();
          }
        } finally {
          sawFinally = true;
        }
      },
    });
    registry.start('m', undefined);
    await tick();
    const seen: TestEvent[] = [];
    registry.subscribe('m', (e) => seen.push(e));

    expect(registry.cancel('m')).toBe(true);
    await tick();
    await tick();
    expect(sawFinally).toBe(true);
    expect(seen.at(-1)).toMatchObject({ type: 'error', error: 'install cancelled' });
    expect(registry.get('m')).toMatchObject({ finished: true, error: 'install cancelled' });
    expect(registry.cancel('m')).toBe(false);
  });

  it('a crashing job surfaces a synthesized error event', async () => {
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      // biome-ignore lint/correctness/useYield: the crash-before-first-yield path is the point
      run: async function* () {
        throw new Error('disk exploded');
      },
    });
    registry.start('m', undefined);
    await tick();
    const seen: TestEvent[] = [];
    registry.subscribe('m', (e) => seen.push(e));
    expect(seen).toEqual([{ type: 'error', error: 'disk exploded' }]);
    expect(registry.get('m')).toMatchObject({ finished: true, error: 'disk exploded' });
  });
});

describe('ChatModelInstallRegistry — polled views', () => {
  it('active() lists running installs with their latest progress and describe() adds the events', async () => {
    const gate = deferred();
    const registry = new ChatModelInstallRegistry<TestEvent, undefined>({
      engine: 'test',
      run: async function* () {
        yield { type: 'progress' };
        await gate.promise;
        yield { type: 'done' };
      },
      finishedTtlMs: 50,
    });
    registry.start('m', undefined);
    await tick();
    expect(registry.active().map((a) => [a.id, a.lastEvent?.type])).toEqual([['m', 'progress']]);
    const described = registry.describe('m');
    expect(described?.finished).toBe(false);
    expect(described?.lastEvent?.type).toBe('progress');
    expect(described?.terminalEvent).toBeNull();

    gate.resolve();
    await tick();
    await tick();
    expect(registry.active()).toEqual([]);
    expect(registry.describe('m')?.terminalEvent?.type).toBe('done');

    // The finished entry lingers only for the configured TTL.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(registry.describe('m')).toBeNull();
  });
});
