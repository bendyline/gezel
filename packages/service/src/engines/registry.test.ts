import { describe, expect, it } from 'vitest';
import { EngineBinaryRegistry, engineInstallPhase } from './registry.js';
import type { EngineResolveEvent, EngineResolveResult, ResolveEngineOptions } from './resolver.js';

type ResolveImpl = (
  opts: ResolveEngineOptions,
) => AsyncGenerator<EngineResolveEvent, EngineResolveResult, void>;

/** A fake resolver that yields the given events (optionally pausing on a gate). */
function fakeResolve(events: EngineResolveEvent[], gate?: Promise<void>): ResolveImpl {
  return async function* () {
    if (gate) await gate;
    for (const e of events) yield e;
    return {
      binPath: '/x/llama-server',
      cached: false,
      signature: { status: 'unsigned' },
      version: '9',
      assetPlatformKey: 'k',
    };
  };
}

/** Collect events for `key` until a terminal one (or the registry GCs it). */
function collect(reg: EngineBinaryRegistry, key: string): Promise<EngineResolveEvent[]> {
  return new Promise((resolve) => {
    const events: EngineResolveEvent[] = [];
    const unsub = reg.subscribe(key, (e) => {
      events.push(e);
      if (e.type === 'done' || e.type === 'error') {
        unsub?.();
        resolve(events);
      }
    });
    if (!unsub) resolve(events);
  });
}

describe('EngineBinaryRegistry', () => {
  it('dedups concurrent ensure() calls for the same engine+variant', () => {
    // Gate keeps the resolve in flight so the second ensure() sees it running.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reg = new EngineBinaryRegistry({
      home: '/tmp/x',
      resolveImpl: fakeResolve([{ type: 'done', binPath: '/x', cached: false }], gate),
    });
    const a = reg.ensure('llama-server', 'cpu');
    const b = reg.ensure('llama-server', 'cpu');
    expect(a.alreadyRunning).toBe(false);
    expect(b.alreadyRunning).toBe(true);
    expect(a.key).toBe(b.key);
    release();
    reg.clear();
  });

  it('treats different variants as separate jobs', () => {
    const reg = new EngineBinaryRegistry({
      home: '/tmp/x',
      resolveImpl: fakeResolve(
        [{ type: 'done', binPath: '/x', cached: false }],
        new Promise(() => {}),
      ),
    });
    const cpu = reg.ensure('llama-server', 'cpu');
    const cuda = reg.ensure('llama-server', 'cuda');
    expect(cpu.key).not.toBe(cuda.key);
    expect(cuda.alreadyRunning).toBe(false);
    reg.clear();
  });

  it('streams progress then a terminal done, and records binPath', async () => {
    const reg = new EngineBinaryRegistry({
      home: '/tmp/x',
      resolveImpl: fakeResolve([
        { type: 'progress', bytesWritten: 50, totalBytes: 100 },
        { type: 'verifying', what: 'sha256' },
        { type: 'done', binPath: '/cache/llama-server', cached: false },
      ]),
    });
    const { key } = reg.ensure('llama-server', 'cpu');
    const events = await collect(reg, key);
    expect(events.some((e) => e.type === 'done')).toBe(true);
    expect(reg.get(key)?.binPath).toBe('/cache/llama-server');
    reg.clear();
  });

  it('records unpacking progress on the snapshot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reg = new EngineBinaryRegistry({
      home: '/tmp/x',
      resolveImpl: async function* () {
        yield { type: 'progress', bytesWritten: 100, totalBytes: 100 };
        yield { type: 'extracting', bytesWritten: 30, totalBytes: 120 };
        await gate;
        yield { type: 'done', binPath: '/cache/llama-server', cached: false };
        return {
          binPath: '/cache/llama-server',
          cached: false,
          signature: { status: 'unsigned' },
          version: '9',
          assetPlatformKey: 'k',
        };
      },
    });
    const { key } = reg.ensure('llama-server', 'cuda');
    await new Promise((r) => setTimeout(r, 0));

    const snapshot = reg.get(key);
    expect(snapshot).toMatchObject({
      phase: 'extracting',
      extracted: { bytesWritten: 30, totalBytes: 120 },
    });
    expect(snapshot && engineInstallPhase(snapshot)).toBe('is unpacking (25%)');

    release();
    await collect(reg, key);
    reg.clear();
  });

  it('describes each install phase in plain words', () => {
    const base = { bytesWritten: 40, totalBytes: 160 };
    expect(engineInstallPhase({ ...base, phase: 'downloading' })).toBe('is downloading (25%)');
    expect(engineInstallPhase({ ...base, phase: 'verifying' })).toBe('is being checked');
    expect(
      engineInstallPhase({
        ...base,
        phase: 'extracting',
        extracted: { bytesWritten: 0, totalBytes: 0 },
      }),
    ).toBe('is unpacking');
  });

  it('surfaces a terminal error on the snapshot', async () => {
    const reg = new EngineBinaryRegistry({
      home: '/tmp/x',
      resolveImpl: fakeResolve([{ type: 'error', error: 'no token while private' }]),
    });
    const { key } = reg.ensure('llama-server', 'cpu');
    const events = await collect(reg, key);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(reg.get(key)?.error).toMatch(/no token/);
    reg.clear();
  });
});
