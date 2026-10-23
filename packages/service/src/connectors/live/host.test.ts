import type {
  ChatEvent,
  ConnectorTypeManifest,
  GezelConfig,
  Project,
  ProjectConnectorBinding,
} from '@bendyline/gezel';
import { recordSuspensionForTests, resetSuspendClockForTests } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeWav, synthesizeClip } from '../../lookouts/sound-player.js';
import { liveGate } from './gating.js';
import { LiveConnectorHost } from './host.js';
import { clearLiveAdaptersForTests, registerLiveAdapter } from './registry.js';
import { type LiveAdapter, LiveAdapterError, type LiveRunContext } from './types.js';

const manifest = {
  kind: 'connector-type',
  id: 'camera-local',
  name: 'Webcam',
  driver: 'device',
  source: { adapterId: 'fake-camera', family: 'camera' },
} as unknown as ConnectorTypeManifest;

class FakeAdapter implements LiveAdapter {
  heartbeatTimeoutMs = 60_000;
  runs: LiveRunContext[] = [];
  fail: string | null = null;
  async run(ctx: LiveRunContext): Promise<void> {
    this.runs.push(ctx);
    if (this.fail) throw new LiveAdapterError(this.fail);
    ctx.heartbeat();
    ctx.report({ state: 'watching' });
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  }
}

function binding(over: Partial<ProjectConnectorBinding> = {}): ProjectConnectorBinding {
  return {
    id: 'cam1',
    type: 'camera-local',
    driver: 'device',
    displayName: 'Mud room',
    corpusDir: 'data/mud-room',
    config: { device: 'x' },
    ...over,
  };
}

function fixture(
  initial: {
    bindings?: ProjectConnectorBinding[];
    config?: Partial<GezelConfig>;
    project?: Partial<Project>;
  } = {},
) {
  let bindings = initial.bindings ?? [binding()];
  let config = { aiEngagementMode: 'proactive', ...initial.config } as GezelConfig;
  const persisted: Array<{ bindingId: string; patch: Record<string, unknown> }> = [];
  const events: ChatEvent[] = [];
  const adapter = new FakeAdapter();
  registerLiveAdapter('fake-camera', adapter);
  const project = () =>
    ({
      id: 'home',
      name: 'Home',
      status: 'active',
      connectors: bindings,
      ...initial.project,
    }) as Project;
  const host = new LiveConnectorHost({
    store: {
      listProjects: async () => [project()],
      getProject: async () => project() as never,
      readConfig: async () => config,
    },
    catalog: { get: async () => ({ manifest, sourceId: 'bundled' }) as never },
    persist: async (_p, bindingId, patch) => {
      persisted.push({ bindingId, patch });
      bindings = bindings.map((b) =>
        b.id === bindingId
          ? ({
              ...b,
              ...(patch.disabled ? { disabled: true, disabledReason: patch.disabledReason } : {}),
            } as ProjectConnectorBinding)
          : b,
      );
    },
    publishProject: (_p, e) => events.push(e),
    publishGlobal: (e) => events.push(e),
    timers: false,
  });
  return {
    host,
    adapter,
    events,
    persisted,
    setBindings: (next: ProjectConnectorBinding[]) => {
      bindings = next;
    },
    setConfig: (next: Partial<GezelConfig>) => {
      config = { ...config, ...next } as GezelConfig;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => resetSuspendClockForTests());
afterEach(() => clearLiveAdaptersForTests());

describe('LiveConnectorHost', () => {
  it('runs an enabled device binding and reports it watching', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    expect(f.adapter.runs).toHaveLength(1);
    expect(f.adapter.runs[0]?.label).toBe('Mud room');
    expect(f.host.statusFor('home', 'cam1')?.state).toBe('watching');
    expect(f.events.some((e) => e.type === 'cameras_watching' && e.cameras.length === 1)).toBe(
      true,
    );
    await f.host.stop();
  });

  it('stops a binding that is paused, and explains why', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    f.setBindings([binding({ disabled: true, disabledReason: 'user' })]);
    await f.host.reconcile();
    expect(f.adapter.runs[0]?.signal.aborted).toBe(true);
    expect(f.host.statusFor('home', 'cam1')).toMatchObject({ state: 'paused', reason: 'Paused.' });
    await f.host.stop();
  });

  it('holds every camera when engagement is off, and restarts on a config change', async () => {
    const f = fixture({ config: { aiEngagementMode: 'off' } });
    f.host.start();
    await f.host.reconcile();
    expect(f.adapter.runs).toHaveLength(0);
    expect(f.host.statusFor('home', 'cam1')?.state).toBe('held');
    f.setConfig({ aiEngagementMode: 'reactive' });
    await f.host.reconcile();
    await tick();
    expect(f.adapter.runs).toHaveLength(1);
    await f.host.stop();
  });

  it('restarts a run when the binding is reconfigured', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    f.setBindings([binding({ config: { device: 'x', sensitivity: 'high' } })]);
    await f.host.reconcile();
    await tick();
    expect(f.adapter.runs).toHaveLength(2);
    expect(f.adapter.runs[0]?.signal.aborted).toBe(true);
    expect(f.adapter.runs[1]?.signal.aborted).toBe(false);
    await f.host.stop();
  });

  it('shows a failure in plain words and keeps it on the binding', async () => {
    const f = fixture();
    f.adapter.fail = 'Another app is using the camera.';
    f.host.start();
    await f.host.reconcile();
    await tick();
    expect(f.host.statusFor('home', 'cam1')).toMatchObject({
      state: 'error',
      reason: 'Another app is using the camera.',
    });
    expect(f.persisted).toContainEqual({
      bindingId: 'cam1',
      patch: { lastError: 'Another app is using the camera.' },
    });
    await f.host.stop();
  });

  it('emergency stop pauses every camera until the person resumes it', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    expect(await f.host.emergencyStop()).toBe(1);
    expect(f.persisted).toContainEqual({
      bindingId: 'cam1',
      patch: { disabled: true, disabledReason: 'emergency-stop' },
    });
    expect(f.adapter.runs[0]?.signal.aborted).toBe(true);
    expect(f.host.statusFor('home', 'cam1')?.reason).toMatch(/emergency stop/);
    await f.host.stop();
  });

  it('starts every run fresh after the computer wakes', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    recordSuspensionForTests(60_000);
    await new Promise((r) => setTimeout(r, 700));
    expect(f.adapter.runs.length).toBeGreaterThanOrEqual(2);
    expect(f.adapter.runs[0]?.signal.aborted).toBe(true);
    await f.host.stop();
  });

  it('forgets a binding that was removed', async () => {
    const f = fixture();
    f.host.start();
    await f.host.reconcile();
    await tick();
    f.setBindings([]);
    await f.host.reconcile();
    expect(f.adapter.runs[0]?.signal.aborted).toBe(true);
    expect(f.host.statusFor('home', 'cam1')).toBeUndefined();
    await f.host.stop();
  });
});

describe('liveGate', () => {
  const base = {
    binding: {},
    project: { status: 'active' as const },
    engagementOff: false,
    network: false,
    allowConnectorData: false,
  };
  it('runs a webcam at any security level, and a network camera only with app network', () => {
    expect(liveGate(base)).toEqual({ run: true });
    expect(liveGate({ ...base, network: true })).toMatchObject({ run: false, state: 'held' });
    expect(liveGate({ ...base, network: true, allowConnectorData: true })).toEqual({ run: true });
  });
  it('keeps watching a stable project, but not an archived or shared one', () => {
    expect(liveGate({ ...base, project: { status: 'stable' } })).toEqual({ run: true });
    expect(liveGate({ ...base, project: { status: 'active', archived: true } })).toMatchObject({
      run: false,
    });
    expect(liveGate({ ...base, project: { status: 'readonly' } })).toMatchObject({ run: false });
    expect(liveGate({ ...base, project: { storageScope: 'machine-shared' } })).toMatchObject({
      run: false,
    });
  });
});

describe('lookout sounds', () => {
  it('synthesizes each clip into a valid, bounded WAV', () => {
    for (const clip of ['chime', 'alarm', 'whistle'] as const) {
      const samples = synthesizeClip(clip);
      expect(samples.length).toBeGreaterThan(0);
      expect(samples.length / 22_050).toBeLessThanOrEqual(3);
      expect(Math.max(...samples.map(Math.abs))).toBeLessThanOrEqual(1);
      const wav = encodeWav(samples);
      expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(wav.readUInt32LE(40)).toBe(samples.length * 2);
    }
  });
});
