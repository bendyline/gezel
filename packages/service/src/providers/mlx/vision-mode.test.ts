import { describe, expect, it, vi } from 'vitest';
import { nativeVisionEnabledFor, nativeVisionPreferenceFor } from '../vision-capability.js';
import { MlxEngineGate } from './engine-gate.js';
import { TOOL_IMAGES_MESSAGE } from './tool-image-retention.js';
import {
  MlxVisionMode,
  describeVisionNeed,
  mlxCacheFingerprint,
  resolveMlxVisionPolicy,
  unseenToolImagesNote,
} from './vision-mode.js';

/**
 * A supervisor double that launches through `takeLaunch`, exactly as
 * build-provider's `resolveLaunch` does, and records the order of events.
 */
function fakeEngine(
  mode: MlxVisionMode,
  opts: { running?: boolean; failVisionLaunch?: boolean; width?: number } = {},
) {
  const events: string[] = [];
  let running = false;
  let disposed = false;
  const supervisor = {
    lifecycleSnapshot: () => ({ running }),
    ensureRunning: vi.fn(async () => {
      if (running) return;
      const vision = mode.takeLaunch();
      events.push(vision ? 'launch:vision' : 'launch:text');
      if (vision && opts.failVisionLaunch) throw new Error('no image processor');
      running = true;
    }),
    stop: vi.fn(async () => {
      events.push('stop');
      running = false;
    }),
  };
  const gate = new MlxEngineGate(opts.width ?? 2);
  mode.bindEngine(supervisor, gate, () => disposed);
  return {
    events,
    supervisor,
    gate,
    dispose: () => {
      disposed = true;
    },
    idleStop: () => {
      running = false;
    },
    start: () => supervisor.ensureRunning(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MLX vision policy', () => {
  it('defaults to on-demand and lets an explicit per-model choice win', () => {
    const policy = (preference: 'on' | 'off' | 'default', hasVisionTower = true) =>
      resolveMlxVisionPolicy({ preference, hasVisionTower });
    expect(policy('default')).toBe('on-demand');
    expect(policy('on')).toBe('always');
    expect(policy('off')).toBe('never');
    expect(policy('on', false)).toBe('never');
    expect(policy('default', false)).toBe('never');
  });

  it('reads the per-model preference as three states without moving the llama.cpp default', () => {
    const cfg = { 'qwen-on': true, 'qwen-off': false };
    expect(nativeVisionPreferenceFor(cfg, 'qwen-on')).toBe('on');
    expect(nativeVisionPreferenceFor(cfg, 'qwen-off')).toBe('off');
    expect(nativeVisionPreferenceFor(cfg, 'other')).toBe('default');
    expect(nativeVisionPreferenceFor(undefined, undefined)).toBe('default');
    expect(nativeVisionEnabledFor(cfg, 'other')).toBe(true);
    expect(nativeVisionEnabledFor(cfg, 'qwen-off')).toBe(false);
    expect(nativeVisionEnabledFor(cfg, undefined)).toBe(false);
  });

  it('decides each launch: text by default, vision when asked or always-on', () => {
    expect(new MlxVisionMode('on-demand').takeLaunch()).toBe(false);
    expect(new MlxVisionMode('always').takeLaunch()).toBe(true);
    expect(new MlxVisionMode('never').takeLaunch()).toBe(false);
  });

  it('keeps text-tower caches on the historical fingerprint and segments vision ones', () => {
    expect(mlxCacheFingerprint('abc123', false)).toBe('abc123');
    expect(mlxCacheFingerprint('abc123', true)).not.toBe('abc123');
  });

  it('names why a request needs the vision tower', () => {
    const history = [
      { role: 'user', content: 'what is this?', images: ['x'] },
      { role: 'assistant', content: 'a cat' },
      { role: 'user', content: 'and now?' },
    ];
    expect(describeVisionNeed(history.slice(1), 0)).toBeUndefined();
    expect(describeVisionNeed(history, 2)).toContain('earlier in the conversation');
    expect(describeVisionNeed(history.slice(0, 1), 0)).toContain('attached to this message');
    expect(
      describeVisionNeed([{ role: 'user', content: TOOL_IMAGES_MESSAGE, images: ['a', 'b'] }], 5),
    ).toContain('a tool returned 2 image(s)');
  });
});

describe('MlxVisionMode switching', () => {
  it('starts text-only and reloads once into vision when a request carries pixels', async () => {
    const mode = new MlxVisionMode('on-demand', 'qwen3.8-27b');
    const engine = fakeEngine(mode);
    await engine.start();
    expect(engine.events).toEqual(['launch:text']);

    await expect(mode.ensureVision('1 image(s) attached to this message')).resolves.toBe(true);
    expect(engine.events).toEqual(['launch:text', 'stop', 'launch:vision']);
    expect(mode.active).toBe(true);

    await expect(mode.ensureVision('another image')).resolves.toBe(true);
    expect(engine.supervisor.stop).toHaveBeenCalledTimes(1);
  });

  it('waits for another session in flight, and holds later requests until the reload', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode, { width: 1 });
    await engine.start();
    const releaseInFlight = await engine.gate.acquire('other-session');

    const switching = mode.ensureVision('image');
    const later = engine.gate.acquire('later-request').then((release) => {
      engine.events.push('later-request');
      release();
    });
    await flush();
    expect(engine.supervisor.stop).not.toHaveBeenCalled();

    releaseInFlight();
    await switching;
    await later;
    expect(engine.events).toEqual(['launch:text', 'stop', 'launch:vision', 'later-request']);
  });

  it('launches a stopped engine straight into vision without a reload', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode);
    await expect(mode.ensureVision('image')).resolves.toBe(true);
    expect(engine.events).toEqual(['launch:vision']);
    expect(engine.supervisor.stop).not.toHaveBeenCalled();
  });

  it('shares one reload between concurrent requests', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode);
    await engine.start();
    await Promise.all([mode.ensureVision('a'), mode.ensureVision('b'), mode.ensureVision('c')]);
    expect(engine.supervisor.stop).toHaveBeenCalledTimes(1);
    expect(engine.events).toEqual(['launch:text', 'stop', 'launch:vision']);
  });

  it('starts the next engine process text-only after an idle stop', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode);
    await mode.ensureVision('image');
    engine.idleStop();
    await engine.start();
    expect(engine.events).toEqual(['launch:vision', 'launch:text']);
    expect(mode.active).toBe(false);
  });

  it('honors an explicit opt-in from the first launch, with no reload', async () => {
    const mode = new MlxVisionMode(
      resolveMlxVisionPolicy({ preference: 'on', hasVisionTower: true }),
    );
    const engine = fakeEngine(mode);
    await engine.start();
    await expect(mode.ensureVision('image')).resolves.toBe(true);
    expect(engine.events).toEqual(['launch:vision']);
  });

  it('honors an explicit opt-out: never loads the tower and replaces pixels with a note', async () => {
    const mode = new MlxVisionMode(
      resolveMlxVisionPolicy({ preference: 'off', hasVisionTower: true }),
    );
    const engine = fakeEngine(mode);
    await engine.start();
    const messages = [
      { role: 'user', content: 'what is this?', images: ['eA=='] },
      { role: 'user', content: TOOL_IMAGES_MESSAGE, images: ['eA=='] },
    ];
    const prepared = await mode.prepareRequest(messages, 0);
    expect(prepared.some((m) => 'images' in m)).toBe(false);
    expect(prepared[0]?.content).toContain('what is this?');
    expect(prepared[0]?.content).toContain('running without image input');
    expect(prepared[1]?.content).not.toContain(TOOL_IMAGES_MESSAGE);
    expect(engine.events).toEqual(['launch:text']);
    expect(mode.capable).toBe(false);
  });

  it('falls back to text-only when the vision tower fails to load', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode, { failVisionLaunch: true });
    await engine.start();
    await expect(mode.ensureVision('image')).resolves.toBe(false);
    expect(engine.events).toEqual(['launch:text', 'stop', 'launch:vision', 'launch:text']);
    expect(mode.capable).toBe(false);
    await expect(
      mode.prepareRequest([{ role: 'user', content: 'see', images: ['eA=='] }], 0),
    ).resolves.toEqual([expect.not.objectContaining({ images: expect.anything() })]);
  });

  it('never relaunches an engine whose provider was retired', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode);
    await engine.start();
    engine.dispose();
    await mode.ensureVision('image');
    expect(engine.events).toEqual(['launch:text']);
  });

  it('lets a cancelled turn stop waiting while the reload still completes', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode, { width: 1 });
    await engine.start();
    const releaseInFlight = await engine.gate.acquire('other-session');
    const cancel = new AbortController();
    const waiting = mode.ensureVision('image', cancel.signal);
    cancel.abort();
    await expect(waiting).rejects.toThrow();
    releaseInFlight();
    await vi.waitFor(() => expect(engine.events).toContain('launch:vision'));
  });

  it('passes text-only requests through untouched', async () => {
    const mode = new MlxVisionMode('on-demand');
    const engine = fakeEngine(mode);
    const messages = [{ role: 'user', content: 'hello' }];
    await expect(mode.prepareRequest(messages, 0)).resolves.toBe(messages);
    expect(engine.events).toEqual([]);
  });
});

describe('unseenToolImagesNote', () => {
  it('reports success and the dropped pixels, and is empty when nothing was dropped', () => {
    expect(unseenToolImagesNote(0)).toBe('');
    expect(unseenToolImagesNote(2)).toContain('The tool succeeded');
    expect(unseenToolImagesNote(2)).toContain('2 image(s)');
  });
});
