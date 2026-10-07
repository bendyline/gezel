import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  DEFAULT_NIGHT_SHIFT_WINDOW,
  type NightShiftReviewIntent,
  nightShiftWindowKey,
} from '@bendyline/gezel';
import { createTrustingFetch } from '@bendyline/gezel-client/node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isGitInstalled, runGit } from '../git/git.js';
import { findNightShiftOversightTask } from '../meester/night-shift-oversight.js';
import type { InferProjectDeps } from '../projects/infer-project.js';
import { type RunningService, startService } from '../service.js';

// A whole night against a booted daemon: a person adds a Pictures folder and a
// code folder, the window opens with no task waiting, the sweep indexes both,
// the shift drains, and the morning brings one card and one history record.
// The folders come out of it untouched.

const machine = vi.hoisted(() => ({ homedir: '' }));

// Same isolation as integration.test.ts: real inference, but against this
// fixture's home instead of the developer's own Documents and Pictures.
vi.mock('../projects/infer-project.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../projects/infer-project.js')>();
  const isolated = (deps: InferProjectDeps): InferProjectDeps => ({
    ...deps,
    homedir: machine.homedir,
    env: { GEZEL_MACHINE_SHARED_HOME: process.env.GEZEL_MACHINE_SHARED_HOME },
  });
  return {
    ...actual,
    inferProjectForPath: (
      deps: InferProjectDeps,
      request: Parameters<typeof actual.inferProjectForPath>[1],
    ) => actual.inferProjectForPath(isolated(deps), request),
  };
});

const PNG = Buffer.concat([
  Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x03, 0x20, 0x00, 0x00, 0x02, 0x58, 0x08, 0x02, 0x00, 0x00, 0x00,
  ]),
  Buffer.alloc(8),
]);

let svc: RunningService;
let root: string;
let pictures: string;
let code: string;
let baseUrl: string;
let httpFetch: typeof fetch;
let clock: number;

const at = (dayOffset: number, hour: number) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hour, 0).getTime();
};

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  root = await realpath(await mkdtemp(join(tmpdir(), 'gezel-night-e2e-')));
  machine.homedir = join(root, 'user-home');
  pictures = join(machine.homedir, 'Pictures');
  code = join(machine.homedir, 'code', 'allotment');
  await mkdir(join(pictures, '2026'), { recursive: true });
  for (let i = 0; i < 6; i++) await writeFile(join(pictures, '2026', `IMG_${i}.png`), PNG);
  await mkdir(join(code, 'src'), { recursive: true });
  await writeFile(join(code, 'package.json'), '{ "name": "allotment" }\n');
  await writeFile(join(code, 'README.md'), '# Allotment\n');
  for (const name of ['rota', 'plots', 'weather']) {
    await writeFile(join(code, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
  }
  if (await isGitInstalled()) {
    await runGit(['init', '-q'], { cwd: code });
    await runGit(['add', '-A'], { cwd: code });
    await runGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], {
      cwd: code,
    });
  }

  clock = at(0, 23);
  svc = await startService({
    home: join(root, 'gezel-home'),
    nightShiftNow: () => new Date(clock),
  });
  baseUrl = `${svc.cert ? 'https' : 'http'}://127.0.0.1:${svc.port}`;
  httpFetch = svc.cert ? createTrustingFetch({ cert: svc.cert.certPem }) : fetch;
}, 60_000);

afterAll(async () => {
  await svc?.stop();
  await rm(root, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
}, 30_000);

async function addFolder(path: string): Promise<string> {
  const res = await httpFetch(`${baseUrl}/api/projects/infer-for-path`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${svc.context.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, kind: 'folder', source: 'first-run', recruitCrew: true }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { project: { id: string } }).project.id;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    out.set(`${relative(dir, d)}/`, `dir ${(await lstat(d)).mtimeMs}`);
    for (const entry of await readdir(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else {
        const st = await lstat(abs);
        const hash = createHash('sha256')
          .update(await readFile(abs))
          .digest('hex');
        out.set(relative(dir, abs), `${st.size} ${st.mtimeMs} ${hash}`);
      }
    }
  };
  await walk(dir);
  return out;
}

describe('a night in the life', () => {
  it('runs with nothing queued, sweeps the added folders, and leaves one morning card', async () => {
    const ctx = svc.context;
    const windowKey = nightShiftWindowKey(new Date(clock), DEFAULT_NIGHT_SHIFT_WINDOW)!;
    // The nightly review pausing must not stop the night.
    const oversight = await findNightShiftOversightTask(ctx.store);
    expect(oversight).not.toBeNull();
    await ctx.tasks.setStatus('default', oversight!.num, 'paused');

    const before = { pictures: await snapshot(pictures), code: await snapshot(code) };
    const picturesId = await addFolder(pictures);
    const codeId = await addFolder(code);
    expect((await ctx.store.getProject(picturesId))?.properties?.['gezel.folderKind']).toBe(
      'pictures',
    );
    expect((await ctx.store.getProject(codeId))?.properties?.['gezel.folderKind']).toBe('code');

    await ctx.nightShift.tick();
    expect(ctx.nightShift.isActive()).toBe(true);

    await until(
      async () =>
        !ctx.indexEnrichment.isNightWorkRunning() &&
        (await ctx.contentIndex.hasIndex(picturesId)) &&
        (await ctx.contentIndex.hasIndex(codeId)),
    );
    await ctx.nightShift.tick();
    expect(ctx.nightShift.isActive()).toBe(false);

    clock = at(1, 7);
    await ctx.nightShift.tick();
    const reviewCards = async () =>
      (await ctx.store.listProjectQuestions('default')).filter(
        (q) => q.intent?.kind === 'night-shift-review',
      );
    const settled = () =>
      ctx.history.listEntries({ kinds: ['night-shift.window-settled'], include: 'events' });
    await until(async () => (await reviewCards()).length === 1 && (await settled()).length === 1);

    const [card] = await reviewCards();
    const intent = card!.intent as NightShiftReviewIntent;
    expect(intent.windowKey).toBe(windowKey);
    expect(intent.pausedReview).toEqual({ projectId: 'default', num: oversight!.num });
    expect(card!.prompt).toContain('Your nightly review paused');

    // A restart replaying the settle (here, another tick) adds nothing.
    await ctx.nightShift.tick();
    expect(await reviewCards()).toHaveLength(1);
    expect(await settled()).toHaveLength(1);

    expect(await snapshot(pictures)).toEqual(before.pictures);
    expect(await snapshot(code)).toEqual(before.code);
  }, 120_000);
});
