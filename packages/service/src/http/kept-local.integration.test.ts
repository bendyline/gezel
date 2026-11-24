import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningService, startService } from '../service.js';

/**
 * The same rules over a real daemon: real session tokens through the real
 * route guard, a script in the real sandbox, and the person's own credential.
 */

const EVENT = 'data/work/dentist.md';
const SECRET = 'Dentist on Tuesday at nine';
const PROJECT = 'default';

let svc: RunningService;
let home: string;
let baseUrl: string;
let httpFetch: typeof fetch;
const tokens = { person: '', cloud: '', local: '' };
const sessions = { cloud: '', local: '' };
const priorMock = process.env.GEZEL_MOCK_PROVIDER;

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-kept-live-'));
  svc = await startService({ home });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  tokens.person = svc.context.token;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
  const { store, chat, tokenStore } = svc.context;
  await store.updateProject(PROJECT, {
    connectors: [
      {
        id: 'calendar-google:ab12',
        type: 'calendar-google',
        displayName: 'Work',
        corpusDir: 'data/work',
        config: {},
      },
    ],
  });
  const root = store.projectArtifactsDir(PROJECT);
  await mkdir(join(root, 'data/work'), { recursive: true });
  await writeFile(join(root, EVENT), SECRET);
  await mkdir(join(root, 'reports'), { recursive: true });
  await writeFile(join(root, 'reports/open.md'), 'nothing private');
  for (const [who, provider] of [
    ['cloud', 'copilot'],
    ['local', 'ollama'],
  ] as const) {
    const gezel = await store.createGezel({
      name: who === 'cloud' ? 'Cleo' : 'Leo',
      role: 'Developer',
    });
    await store.updateGezelSettings(gezel.id, { provider });
    const session = await chat.createSession({ gezelId: gezel.id, projectId: PROJECT });
    sessions[who] = session.id;
    tokens[who] = tokenStore.issueSession({
      appId: `session:${session.id}`,
      projectId: PROJECT,
      gezelId: gezel.id,
      team: false,
    }).token;
  }
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  if (priorMock === undefined) delete process.env.GEZEL_MOCK_PROVIDER;
  else process.env.GEZEL_MOCK_PROVIDER = priorMock;
}, 30_000);

async function ask(who: keyof typeof tokens, method: string, path: string, body?: unknown) {
  const res = await httpFetch(`${baseUrl}/api/projects/${PROJECT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tokens[who]}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, text: await res.text() };
}

const read = (who: keyof typeof tokens) => ask(who, 'GET', `/artifacts/slice?path=${EVENT}`);
const script = (who: keyof typeof tokens, file: string) =>
  ask(who, 'POST', '/run-nodejs-script', { path: file, timeoutMs: 30_000 });

describe('a kept connection over a live daemon', () => {
  it('is read by the person and a gezel here, and by no cloud gezel', async () => {
    expect((await read('person')).text).toContain(SECRET);
    const cloud = await read('cloud');
    expect(cloud).toMatchObject({ status: 403 });
    expect(cloud.text).not.toContain(SECRET);

    expect(await svc.context.chat.keptLocalSources(sessions.local)).toEqual([]);
    expect((await read('local')).text).toContain(SECRET);
    expect((await svc.context.chat.keptLocalSources(sessions.local)).map((s) => s.name)).toEqual([
      'Work',
    ]);
  });

  it('is out of reach of a cloud gezel’s script, which still reads the rest', async () => {
    const artifacts = JSON.stringify(svc.context.store.projectArtifactsDir(PROJECT));
    await svc.context.store.writeProjectWorkspaceFile(
      PROJECT,
      'peek.mjs',
      `import { readFileSync, readdirSync } from 'node:fs';
const root = ${artifacts};
console.log(readFileSync(root + '/reports/open.md', 'utf8'));
for (const look of [() => readFileSync(root + '/${EVENT}', 'utf8'), () => readdirSync(root + '/data/work').join()]) {
  try { console.log(look()); } catch (err) { console.log('refused', err.code); }
}
`,
      undefined,
      { userInitiated: true },
    );
    const cloud = await script('cloud', 'peek.mjs');
    expect(cloud.text).toContain('nothing private');
    expect(cloud.text).not.toContain(SECRET);
    expect(cloud.text).not.toContain('dentist.md');
    expect(cloud.text).toContain('ERR_ACCESS_DENIED');

    const local = await script('local', 'peek.mjs');
    expect(local.text).toContain(SECRET);
  }, 90_000);

  it('opens for a cloud gezel when the person allows it, and closes again', async () => {
    const path = `/connectors/${encodeURIComponent('calendar-google:ab12')}`;
    expect((await ask('person', 'PATCH', path, { allowCloudModels: true })).status).toBe(200);
    expect((await read('cloud')).text).toContain(SECRET);
    expect((await ask('person', 'PATCH', path, { allowCloudModels: false })).status).toBe(200);
    expect((await read('cloud')).status).toBe(403);
    // Not a gezel's to change, on any model.
    for (const who of ['cloud', 'local'] as const) {
      expect((await ask(who, 'PATCH', path, { allowCloudModels: true })).status).toBe(403);
    }
  });
});
