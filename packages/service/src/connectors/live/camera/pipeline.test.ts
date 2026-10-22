import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CameraEvent } from '@bendyline/gezel';
import { parseCameraBindingConfig } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CapturesStore } from './captures-store.js';
import { CameraEventWriter } from './event-writer.js';
import { CameraPipeline } from './pipeline.js';
import { CameraReviewer } from './reviewer.js';
import { SIMULATED_SCENE, SimulatedFrameSource } from './simulator.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-camera-'));
  await mkdir(join(dir, 'artifacts'), { recursive: true });
  await mkdir(join(dir, 'quarantine'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function setup(over: { storage?: string; review?: boolean; questions?: boolean } = {}) {
  const events: CameraEvent[] = [];
  const statuses: unknown[] = [];
  let clock = Date.parse('2026-10-21T15:00:00');
  const config = parseCameraBindingConfig({
    device: 'simulator:mud-room',
    storage: over.storage ?? 'interesting',
    intervalSeconds: 5,
    review: over.review ?? true,
  });
  const ctrl = new AbortController();
  const captures = new CapturesStore({
    root: join(dir, 'private', 'captures', 'mud-room'),
    keepDays: 7,
    maxBytes: 1024 ** 3,
    now: () => clock,
    diskOk: async () => true,
  });
  const pipeline = new CameraPipeline({
    projectId: 'home',
    bindingId: 'cam1',
    cameraLabel: 'Mud room',
    config,
    captures,
    events: new CameraEventWriter({
      storageDir: join(dir, 'artifacts'),
      quarantineDir: join(dir, 'quarantine'),
      corpusDir: 'data/mud-room',
      bindingId: 'cam1',
      cameraLabel: 'Mud room',
      lookoutName: () => 'Cat on the floor',
    }),
    reviewer: new CameraReviewer({
      recognize: async () => {
        throw new Error('the simulator answers for itself');
      },
      available: async () => true,
      now: () => clock,
    }),
    lookouts: () => ({
      questions:
        over.questions === false
          ? []
          : [{ id: 'lk1', question: 'Is a cat squatting on the floor?' }],
      motion: false,
    }),
    reviewAllowed: () => true,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onRecordWritten: () => {},
    signal: ctrl.signal,
    now: () => clock,
  });
  const source = new SimulatedFrameSource();
  source.onFrame((f) => pipeline.feed(f));
  return {
    events,
    statuses,
    captures,
    pipeline,
    async run(seconds: number) {
      for (let i = 0; i < seconds * 2; i++) {
        clock += 500;
        source.tick(clock);
        // Let reviews and record writes settle between frames.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

const LOOP = SIMULATED_SCENE.reduce((s, x) => s + x.seconds, 0);

// Each test plays the whole simulated scene frame by frame. Alone that is
// under 2 s, but under the full CI suite on a 4-vCPU runner it reached 5.6 s
// and timed out against the unit project's default budget.
describe('CameraPipeline on the simulated mud room', { timeout: 30_000 }, () => {
  it('turns the cat scene into one episode, a yes while it squats, and an event record', async () => {
    const t = setup();
    await t.run(LOOP);
    await t.pipeline.close();

    const episodes = new Set(t.events.map((e) => e.episodeId));
    expect(episodes.size).toBe(1);
    expect(t.events[0]?.phase).toBe('started');
    expect(t.events.at(-1)?.phase).toBe('ended');

    const reviewed = t.events.filter((e) => e.phase === 'reviewed');
    expect(reviewed.length).toBeGreaterThanOrEqual(2);
    const yes = reviewed.filter((e) => e.review?.answers.lk1?.match);
    expect(yes.length).toBeGreaterThanOrEqual(1);
    expect(yes[0]?.review?.frame).toMatch(
      /^data\/mud-room\/events\/2026-10-21\/15\/attachments\/001\/keyframe-\d\.jpg$/,
    );

    const files = (await walk(join(dir, 'artifacts'))).map((f) => f.replace(/\\/g, '/'));
    const records = files.filter((f) => f.endsWith('.md'));
    expect(records).toHaveLength(1);
    const body = await readFile(records[0] as string, 'utf8');
    expect(body).toContain('kind: camera-event');
    expect(body).toContain('trust: untrusted-external');
    expect(body).toContain('Cat on the floor: yes');
    expect(body).toContain('squats');
    expect(body).not.toContain('![');
    expect(files.some((f) => f.endsWith('/episode.json'))).toBe(true);
    expect(files.filter((f) => /keyframe-\d\.jpg$/.test(f)).length).toBeLessThanOrEqual(3);

    // "Only interesting" keeps no picture stream.
    expect(await t.captures.list()).toEqual([]);
  });

  it('keeps a picture every interval under the interval policy', async () => {
    const t = setup({ storage: 'interval', questions: false });
    await t.run(30);
    await t.pipeline.close();
    const saved = await t.captures.list();
    expect(saved.length).toBeGreaterThanOrEqual(5);
    expect(saved.length).toBeLessThanOrEqual(7);
    expect(saved[0]?.path).toMatch(/^2026-10-21\/15\/\d{6}-\d{3}\.jpg$/);
  });

  it('keeps pictures only while something moves under the motion policy', async () => {
    const t = setup({ storage: 'motion', questions: false });
    await t.run(20);
    expect(await t.captures.list()).toEqual([]);
    await t.run(LOOP - 20);
    await t.pipeline.close();
    expect((await t.captures.list()).length).toBeGreaterThan(0);
  });

  it('writes a record for every episode when nothing reviews', async () => {
    const t = setup({ review: false });
    await t.run(LOOP);
    await t.pipeline.close();
    expect(t.events.some((e) => e.phase === 'reviewed')).toBe(false);
    const records = (await walk(join(dir, 'artifacts'))).filter((f) => f.endsWith('.md'));
    expect(records).toHaveLength(1);
    expect(t.events.find((e) => e.phase === 'started')?.recordPath).toBeDefined();
  });
});
