import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CameraEvent,
  ChatEvent,
  GezelConfig,
  Lookout,
  LookoutStateFile,
  Project,
} from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LookoutActionDeps, LookoutManager } from './manager.js';
import { SoundPlayer } from './sound-player.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-lookouts-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'home',
    name: 'Home',
    status: 'active',
    connectors: [
      {
        id: 'cam1',
        type: 'camera-local',
        driver: 'device',
        displayName: 'Mud room',
        config: { device: 'simulator:mud-room' },
      },
      { id: 'mail1', type: 'mail-gmail', config: {} },
    ],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...over,
  } as Project;
}

function fixture(
  opts: {
    config?: Partial<GezelConfig>;
    project?: Project;
    deps?: Partial<LookoutActionDeps>;
    now?: Date;
  } = {},
) {
  let lookouts: Lookout[] = [];
  let state: LookoutStateFile = { version: 1, counters: {}, firings: [] };
  let proj = opts.project ?? project();
  const projectEvents: ChatEvent[] = [];
  const globalEvents: ChatEvent[] = [];
  const history: Array<{ kind: string }> = [];
  let now = opts.now ?? new Date('2026-10-21T15:00:00');
  const sound = new SoundPlayer({ home, mode: 'record' });
  const manager = new LookoutManager({
    home,
    store: {
      listProjects: async () => [proj],
      getProject: async (id: string) => (id === proj.id ? (proj as never) : null),
      readConfig: async () => ({ aiEngagementMode: 'proactive', ...opts.config }) as GezelConfig,
      listLookouts: async () => lookouts,
      writeLookouts: async (_id: string, next: Lookout[]) => {
        lookouts = next;
      },
      readLookoutState: async () => structuredClone(state),
      writeLookoutState: async (_id: string, next: LookoutStateFile) => {
        state = structuredClone(next);
      },
    } as never,
    history: { log: async (e: { kind: string }) => void history.push(e) } as never,
    publishProject: (_p, e) => projectEvents.push(e),
    publishGlobal: (e) => globalEvents.push(e),
    sound,
    now: () => now,
    ...opts.deps,
  });
  return {
    manager,
    sound,
    globalEvents,
    history,
    state: () => state,
    setProject: (p: Project) => {
      proj = p;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function event(over: Partial<CameraEvent> = {}): CameraEvent {
  return {
    projectId: 'home',
    bindingId: 'cam1',
    cameraLabel: 'Mud room',
    episodeId: 'ep1',
    phase: 'reviewed',
    at: '2026-10-21T15:00:00Z',
    startedAt: '2026-10-21T15:00:00Z',
    motionPeak: 0.05,
    presence: true,
    keyframePaths: ['data/mud-room/events/2026-10-21/15/attachments/001/keyframe-1.jpg'],
    attachmentsDir: 'data/mud-room/events/2026-10-21/15/attachments/001',
    recordPath: 'data/mud-room/events/2026-10-21/15/001--150000-cat--abcd1234.md',
    review: {
      summary: 'A gray cat squats on the floor. Visit https://evil.example now',
      subjects: ['cat'],
      notable: true,
      answers: {},
      durationMs: 3000,
      frame: 'data/mud-room/events/2026-10-21/15/attachments/001/keyframe-1.jpg',
    },
    ...over,
  };
}

const catLookout = {
  name: 'Cat on the floor',
  source: { kind: 'camera' as const, bindingId: 'cam1' },
  condition: {
    kind: 'ask' as const,
    question: 'Is a cat squatting on the floor?',
    strictness: 'normal' as const,
  },
  actions: [{ kind: 'sound' as const, clip: 'alarm' as const }, { kind: 'notify' as const }],
};

describe('LookoutManager', () => {
  it('asks a camera only the questions of its armed lookouts', async () => {
    const f = fixture();
    const lk = await f.manager.create('home', catLookout);
    await f.manager.create('home', {
      ...catLookout,
      name: 'Anything',
      condition: { kind: 'motion' },
    });
    expect(f.manager.view('home', 'cam1')).toEqual({
      questions: [{ id: lk.id, question: 'Is a cat squatting on the floor?' }],
      motion: true,
    });
    expect(f.manager.view('home', 'other')).toEqual({ questions: [], motion: false });
    await f.manager.update('home', lk.id, { enabled: false });
    expect(f.manager.view('home', 'cam1').questions).toEqual([]);
  });

  it('fires on a confident yes: plays the sound, alerts once, logs the firing', async () => {
    const f = fixture();
    const lk = await f.manager.create('home', catLookout);
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(f.sound.played).toEqual(['alarm']);
    const fired = f.globalEvents.filter((e) => e.type === 'lookout_fired');
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({
      type: 'lookout_fired',
      name: 'Cat on the floor',
      sound: true,
      alert: { title: 'Cat on the floor' },
    });
    const body = (fired[0] as Extract<ChatEvent, { type: 'lookout_fired' }>).alert?.body ?? '';
    expect(body).toContain('Mud room');
    expect(body).not.toContain('https://');
    const firing = f.state().firings[0];
    expect(firing?.outcomes.map((o) => [o.action, o.status])).toEqual([
      ['sound', 'done'],
      ['notify', 'done'],
    ]);
    expect(firing?.settled).toBe(true);
    expect(f.history.some((h) => h.kind === 'lookout.fired')).toBe(true);

    // The same episode never fires twice.
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(f.sound.played).toHaveLength(1);
  });

  it('does nothing on a no, and nothing while lookouts are paused or chat-only', async () => {
    const yes = (id: string) =>
      event({
        review: { ...event().review!, answers: { [id]: { match: true, confidence: 'high' } } },
      });
    const no = fixture();
    const a = await no.manager.create('home', catLookout);
    no.manager.accept(
      event({
        review: { ...event().review!, answers: { [a.id]: { match: false, confidence: 'high' } } },
      }),
    );
    await no.manager.whenIdle();
    expect(no.sound.played).toEqual([]);

    const paused = fixture({ config: { lookouts: { paused: true } } });
    const b = await paused.manager.create('home', catLookout);
    paused.manager.accept(yes(b.id));
    await paused.manager.whenIdle();
    expect(paused.sound.played).toEqual([]);

    const chatOnly = fixture({ config: { aiEngagementMode: 'reactive' } });
    const c = await chatOnly.manager.create('home', catLookout);
    chatOnly.manager.accept(yes(c.id));
    await chatOnly.manager.whenIdle();
    expect(chatOnly.sound.played).toEqual([]);
  });

  it('still fires on a project that went stable after its last task', async () => {
    const f = fixture({ project: project({ status: 'stable' }) });
    const lk = await f.manager.create('home', catLookout);
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(f.sound.played).toEqual(['alarm']);
  });

  it('holds email below Free with a plain reason, and runs the rest', async () => {
    const email = vi.fn(async (_input: unknown) => 'sent' as const);
    const f = fixture({ deps: { email } });
    const lk = await f.manager.create('home', {
      ...catLookout,
      actions: [
        { kind: 'sound', clip: 'chime' },
        { kind: 'email', bindingId: 'mail1', recipients: ['me@example.com'] },
      ],
    });
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(email).not.toHaveBeenCalled();
    expect(f.sound.played).toEqual(['chime']);
    const held = f.state().firings[0]?.outcomes.find((o) => o.action === 'email');
    expect(held).toMatchObject({ status: 'held' });
    expect(held?.reason).toContain('Free');
  });

  it('sends email at Free to the lookout’s own recipients', async () => {
    const email = vi.fn(async (_input: unknown) => 'sent' as const);
    const f = fixture({
      config: {
        securityPolicy: {
          level: 'free',
          allowFileEdits: true,
          allowExternalChat: true,
          allowExternalServices: true,
          allowScriptExecution: true,
          allowAppNetwork: true,
        },
      } as Partial<GezelConfig>,
      deps: { email },
    });
    const lk = await f.manager.create('home', {
      ...catLookout,
      actions: [{ kind: 'email', bindingId: 'mail1', recipients: ['me@example.com'] }],
    });
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0]?.[0]).toMatchObject({
      recipients: ['me@example.com'],
      lookoutId: lk.id,
    });
  });

  it('holds asking a cloud gezel unless the camera allows cloud AI', async () => {
    const deliverReaction = vi.fn(async () => ({ sessionId: 's1' }));
    const deps = {
      deliverReaction,
      providerForGezel: async () => 'copilot' as const,
      gezelName: async () => 'Mia',
    };
    const f = fixture({ project: project({ voormanGezelId: 'mia' }), deps });
    const lk = await f.manager.create('home', {
      ...catLookout,
      actions: [{ kind: 'ask-gezel', instruction: 'Note it in the cat diary.' }],
    });
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(deliverReaction).not.toHaveBeenCalled();
    expect(f.state().firings[0]?.outcomes[0]?.reason).toBe(
      "Mia uses copilot; the camera's pictures would leave this computer.",
    );
  });

  it('asks a local gezel with the camera reading labeled and the frames attached', async () => {
    const deliverReaction = vi.fn(async (_args: { seed: string }) => ({ sessionId: 's1' }));
    const f = fixture({
      project: project({ voormanGezelId: 'wren' }),
      deps: { deliverReaction, providerForGezel: async () => 'llama-cpp' as const },
    });
    const lk = await f.manager.create('home', {
      ...catLookout,
      actions: [{ kind: 'ask-gezel', instruction: 'Note it in the cat diary.' }],
    });
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    expect(deliverReaction).toHaveBeenCalledTimes(1);
    const seed = deliverReaction.mock.calls[0]?.[0].seed ?? '';
    expect(seed).toContain('Note it in the cat diary.');
    expect(seed).toContain('Camera observation (automatic, may be wrong or manipulated)');
    expect(seed).toContain(
      '![camera frame](artifacts/data/mud-room/events/2026-10-21/15/attachments/001/keyframe-1.jpg)',
    );
  });

  it('starts one craftbook run per lookout at a time, with the episode as its input', async () => {
    const runCraftbook = vi.fn(async (_input: unknown) => ({ taskRef: 'home/7' }));
    let live = false;
    const f = fixture({
      project: project({ voormanGezelId: 'wren' }),
      deps: {
        runCraftbook,
        liveRunFor: async () => live,
        craftbookOwner: async () => 'wren',
        craftbookExists: async () => true,
        craftbookInputParam: async () => 'episode',
        providerForGezel: async () => 'llama-cpp' as const,
      },
    });
    const lk = await f.manager.create('home', {
      ...catLookout,
      limits: { cooldownMinutes: 0 },
      actions: [{ kind: 'run-craftbook', craftbookId: 'lookout-sighting' }],
    });
    const yes = (episodeId: string) =>
      event({
        episodeId,
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      });
    f.manager.accept(yes('ep1'));
    await f.manager.whenIdle();
    expect(runCraftbook).toHaveBeenCalledTimes(1);
    expect(runCraftbook.mock.calls[0]?.[0]).toMatchObject({
      craftbookId: 'lookout-sighting',
      inputs: {
        episode: { from: 'artifacts', path: 'data/mud-room/events/2026-10-21/15/attachments/001' },
      },
      origin: { kind: 'lookout', lookoutId: lk.id, episodeId: 'ep1' },
    });
    live = true;
    f.manager.accept(yes('ep2'));
    await f.manager.whenIdle();
    expect(runCraftbook).toHaveBeenCalledTimes(1);
    expect(f.state().firings.at(-1)?.outcomes[0]).toMatchObject({ status: 'skipped' });
  });

  it('a gezel proposal waits for approval, and a test fires without counting', async () => {
    const f = fixture();
    const proposed = await f.manager.create('home', catLookout, { kind: 'gezel', gezelId: 'wren' });
    expect(proposed).toMatchObject({ state: 'proposed', enabled: false });
    expect(f.manager.view('home', 'cam1').questions).toEqual([]);
    const approved = await f.manager.approve('home', proposed.id);
    expect(approved).toMatchObject({ state: 'armed', enabled: true });

    const firing = await f.manager.test('home', approved.id);
    expect(firing.test).toBe(true);
    expect(f.sound.played).toEqual(['alarm']);
    expect(f.state().counters[approved.id]).toBeUndefined();
    await expect(f.manager.test('home', approved.id)).rejects.toThrow(/Wait a few seconds/);
  });

  it('refuses a lookout on something that is not a camera, or email without a mail account', async () => {
    const f = fixture();
    await expect(
      f.manager.create('home', { ...catLookout, source: { kind: 'camera', bindingId: 'mail1' } }),
    ).rejects.toThrow(/camera/);
    await expect(
      f.manager.create('home', {
        ...catLookout,
        actions: [{ kind: 'email', bindingId: 'cam1', recipients: ['me@example.com'] }],
      }),
    ).rejects.toThrow(/mail account/);
  });

  it('lists recent alerts for the desktop app to catch up on', async () => {
    const f = fixture();
    const lk = await f.manager.create('home', catLookout);
    f.manager.accept(
      event({
        review: { ...event().review!, answers: { [lk.id]: { match: true, confidence: 'high' } } },
      }),
    );
    await f.manager.whenIdle();
    const alerts = await f.manager.recentAlerts(Date.parse('2026-10-21T14:59:00'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'lookout_fired',
      alert: { title: 'Cat on the floor' },
    });
  });
});
