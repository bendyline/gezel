import { mkdtemp, rm } from 'node:fs/promises';
/**
 * The whole embedding story, against a real daemon this test hosts: connect,
 * install an AI App, work in the project it produced, chat with its gezel, and
 * have a tool this process implements be callable from that chat.
 *
 * Uses Gezel's mock provider, so no credentials and no model download.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packGezappFromSource } from '@bendyline/gezel-service/gezapp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetHostStateForTest } from './host-service.js';
import { type Gezel, type GezelProject, connectOrHost } from './host.js';

const REPO_ROOT = new URL('../../../', import.meta.url).pathname;
const SAMPLE_APP = join(REPO_ROOT, 'examples/apps/example-journal');

let root: string;
let gezel: Gezel;
let projectFolder: string;
let appPackage: Uint8Array;

const priorMockFlag = process.env.GEZEL_MOCK_PROVIDER;
const priorHome = process.env.GEZEL_HOME;

/** Applying the same shipped package is how an app opens on every launch. */
function ensureJournal(): Promise<GezelProject> {
  return gezel.ensureProject({ package: appPackage, folder: projectFolder });
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  root = await mkdtemp(join(tmpdir(), 'gezel-host-int-'));
  process.env.GEZEL_HOME = join(root, 'user-gezel');
  projectFolder = join(root, 'journal');

  const packed = await packGezappFromSource(SAMPLE_APP);
  appPackage = new Uint8Array(packed.buffer);

  gezel = await connectOrHost({
    appId: 'sdk-host-test',
    appName: 'SDK Host Test',
    adoptUserDaemon: false,
    host: { home: join(root, 'app-home') },
  });
  // Mock mode pins `copilot`, whose SDK runs its own tool loop and therefore
  // never sees app tools. A hosted app runs an on-device engine, so route to
  // the bridge-backed mock that behaves the way those do.
  await gezel.client.updateConfig({ provider: 'openai' });
}, 120_000);

afterAll(async () => {
  await gezel?.close();
  resetHostStateForTest();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  if (priorMockFlag === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMockFlag;
  if (priorHome === undefined) delete process.env.GEZEL_HOME;
  else process.env.GEZEL_HOME = priorHome;
}, 60_000);

describe('hosting Gezel inside an application', () => {
  it("hosts a daemon in this process, in the app's own home", async () => {
    expect(gezel.mode).toBe('hosted');
    expect(gezel.hosting).toBe(true);
    expect(gezel.daemon.home).toBe(join(root, 'app-home'));
    // Its own home, not the user's: an app's projects never turn up in the
    // user's workshop.
    expect(gezel.daemon.home).not.toContain('user-gezel');
    await expect(gezel.client.health()).resolves.toMatchObject({ ok: true });
  }, 60_000);

  it('installs the AI App and hands back the project it made', async () => {
    const project = await ensureJournal();

    expect(project.app?.id).toBe('example-journal');
    expect(project.id).toBeTruthy();
    expect(Object.keys(project.gezels)).toContain('example-journal-keeper');
    expect(project.leadGezelId).toBe(project.gezels['example-journal-keeper']);

    const record = await gezel.client.getProject(project.id);
    expect(record.workingDir).toBe(projectFolder);
    expect(record.projectType?.id).toBe('example-journal');
  }, 120_000);

  it('is idempotent: a second launch adopts the same project and crew', async () => {
    const first = await ensureJournal();
    const second = await ensureJournal();

    expect(second.id).toBe(first.id);
    expect(second.gezels).toEqual(first.gezels);
    expect(second.app?.imported).toBe(false);
  }, 120_000);

  it('opens a project that already exists, without the package', async () => {
    const applied = await ensureJournal();
    const reopened = await gezel.openProject(applied.id);

    expect(reopened.id).toBe(applied.id);
    expect(reopened.gezels['example-journal-keeper']).toBe(
      applied.gezels['example-journal-keeper'],
    );
  }, 120_000);

  it('binds a folder to a project with no AI App at all', async () => {
    // An application that ships no .gezapp still wants somewhere to work.
    const plain = await gezel.ensureProject({ folder: join(root, 'plain') });
    expect(plain.id).toBeTruthy();
    expect(plain.app).toBeUndefined();

    const record = await gezel.client.getProject(plain.id);
    expect(record.workingDir).toBe(join(root, 'plain'));
    expect(record.projectType).toBeUndefined();
  }, 120_000);

  it("chats with the project's gezel by role", async () => {
    const project = await ensureJournal();
    const chat = await project.openChat({ role: 'example-journal-keeper' });
    expect(chat.gezelId).toBe(project.gezels['example-journal-keeper']);

    const seen: string[] = [];
    for await (const event of chat.send('Hello.')) seen.push(event.type);
    expect(seen).toContain('done');

    // The same thread is resumed on the next launch, not a fresh empty one.
    const again = await project.openChat({ role: 'example-journal-keeper' });
    expect(again.sessionId).toBe(chat.sessionId);
  }, 120_000);

  it('runs a tool this application implements', async () => {
    const project = await ensureJournal();
    const awarded: number[] = [];
    const registration = await project.registerTools({
      tools: [
        {
          name: 'add_travel_points',
          description: 'Award travel points to the traveller.',
          inputSchema: {
            type: 'object',
            properties: { points: { type: 'number' } },
            required: ['points'],
          },
          handler: async ({ points }: Record<string, unknown>) => {
            awarded.push(Number(points));
            return `awarded ${points} points`;
          },
        },
      ],
    });

    try {
      await registration.ready;
      const relays = await gezel.client.listAppToolRelays();
      expect(relays.relays[0]?.bindings[0]?.tools).toEqual(['add_travel_points']);

      // The tool is on the session's real tool surface, and invoking it
      // reaches this process and comes back. Whether a model chooses to call
      // it is the service suite's business; that it can is this one's.
      const chat = await project.openChat({ role: 'example-journal-keeper' });
      const tools = await gezel.client.listSessionTools(chat.sessionId);
      expect(tools.tools.map((tool: { name: string }) => tool.name)).toContain('add_travel_points');

      const result = await gezel.client.invokeSessionTool(chat.sessionId, 'add_travel_points', {
        points: 7,
      });
      expect(result.text).toContain('awarded 7 points');
      expect(awarded).toEqual([7]);
    } finally {
      await registration.close();
    }
  }, 120_000);
});
