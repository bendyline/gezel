import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CityFile } from '@bendyline/gezel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CityFileStore, serializeCityFile } from './city-file.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-cityfile-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeStore(opts?: { noWorkspace?: boolean }): {
  store: CityFileStore;
  primary: string;
  fallback: string;
} {
  const primary = join(dir, 'ws', '.gezel', 'city.json');
  const fallback = join(dir, 'home', 'projects', 'p1', 'city.json');
  const store = new CityFileStore({
    workspaceDir: opts?.noWorkspace ? null : join(dir, 'ws'),
    primaryPath: opts?.noWorkspace ? null : primary,
    fallbackPath: fallback,
  });
  return { store, primary, fallback };
}

const someState = (seededAt: string): ((city: CityFile) => CityFile) => {
  return (city) => ({
    ...city,
    domains: {
      ...city.domains,
      code: {
        layoutVersion: 5,
        seededAt,
        anchors: [
          { path: 'src', region: 'NW', cx: 0.2, cy: 0.1, recordedAt: seededAt },
          { path: 'docs', region: 'SE', cx: 0.8, cy: 0.9, recordedAt: seededAt },
        ],
        journal: [
          { k: 'street', id: 'st:x', p: null, r: [1.234, 2, 3, 4] },
          {
            k: 'block',
            id: 'src/a.ts',
            p: 'src',
            h: 'h1',
            r: [0, 0, 10.05, 10],
            w: 42,
            a: seededAt,
          },
        ],
      },
    },
  });
};

describe('CityFileStore', () => {
  it('returns defaults when no file exists anywhere', async () => {
    const { store } = makeStore();
    const city = await store.read();
    expect(city.schemaVersion).toBe(1);
    expect(city.overrides).toEqual([]);
    expect(city.domains).toEqual({});
  });

  it('does not create a file on a background build, does on a user-facing one', async () => {
    const { store, primary } = makeStore();
    await store.update({ userFacing: false }, someState('2026-07-01T00:00:00Z'));
    await expect(stat(primary)).rejects.toThrow();

    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    const raw = await readFile(primary, 'utf8');
    expect(JSON.parse(raw).domains.code.layoutVersion).toBe(5);
  });

  it('updates an existing file even on background builds', async () => {
    const { store, primary } = makeStore();
    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    await store.update({ userFacing: false }, someState('2026-07-02T00:00:00Z'));
    const raw = await readFile(primary, 'utf8');
    expect(JSON.parse(raw).domains.code.seededAt).toBe('2026-07-02T00:00:00Z');
  });

  it('skips byte-identical writes (mtime stays put)', async () => {
    const { store, primary } = makeStore();
    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    const before = (await stat(primary)).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    expect((await stat(primary)).mtimeMs).toBe(before);
  });

  it('serializes deterministically regardless of input order, rounding journal rects', () => {
    const base = someState('2026-07-01T00:00:00Z')({
      schemaVersion: 1,
      about: 'x',
      overrides: [
        { path: 'zeta', region: 'N' },
        { path: 'alpha', region: 'S' },
      ],
      domains: {},
    });
    const shuffled: CityFile = {
      ...base,
      overrides: [...base.overrides].reverse(),
      domains: {
        code: {
          ...base.domains.code!,
          anchors: [...base.domains.code!.anchors].reverse(),
          journal: [...base.domains.code!.journal].reverse(),
        },
      },
    };
    const a = serializeCityFile(base);
    expect(serializeCityFile(shuffled)).toBe(a);
    expect(a).toContain('1.2');
    expect(a).not.toContain('1.234');
  });

  it('quarantines a corrupt file and recovers with defaults', async () => {
    const { store, primary } = makeStore();
    await mkdir(join(dir, 'ws', '.gezel'), { recursive: true });
    await writeFile(primary, '{ not json');
    const city = await store.read();
    expect(city.domains).toEqual({});
    const names = await readdir(join(dir, 'ws', '.gezel'));
    expect(names.some((n) => n.startsWith('city.json.corrupt-'))).toBe(true);
    expect(names.includes('city.json')).toBe(false);
  });

  it('treats a newer schemaVersion as read-only and never clobbers it', async () => {
    const { store, primary } = makeStore();
    await mkdir(join(dir, 'ws', '.gezel'), { recursive: true });
    const future = JSON.stringify({ schemaVersion: 99, overrides: [], domains: {} });
    await writeFile(primary, future);
    const result = await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    // The mutation result is still returned for in-memory use...
    expect(result.domains.code?.layoutVersion).toBe(5);
    // ...but the file on disk is untouched.
    expect(await readFile(primary, 'utf8')).toBe(future);
  });

  it('uses the fallback path when there is no workspace', async () => {
    const { store, fallback } = makeStore({ noWorkspace: true });
    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    expect(JSON.parse(await readFile(fallback, 'utf8')).domains.code.layoutVersion).toBe(5);
  });

  it('reads an existing fallback file when the workspace has none', async () => {
    const { store, fallback } = makeStore();
    await mkdir(join(dir, 'home', 'projects', 'p1'), { recursive: true });
    const state = someState('2026-07-01T00:00:00Z')({
      schemaVersion: 1,
      about: 'x',
      overrides: [],
      domains: {},
    });
    await writeFile(fallback, serializeCityFile(state));
    const city = await store.read();
    expect(city.domains.code?.layoutVersion).toBe(5);
    // Later writes keep targeting where the file was found.
    await store.update({ userFacing: false }, someState('2026-07-03T00:00:00Z'));
    expect(JSON.parse(await readFile(fallback, 'utf8')).domains.code.seededAt).toBe(
      '2026-07-03T00:00:00Z',
    );
  });

  it('serializes concurrent updates (no lost writes)', async () => {
    const { store, primary } = makeStore();
    await store.update({ userFacing: true }, someState('2026-07-01T00:00:00Z'));
    await Promise.all([
      store.update({ userFacing: false }, (c) => ({
        ...c,
        overrides: [...c.overrides, { path: 'one', region: 'N' as const }],
      })),
      store.update({ userFacing: false }, (c) => ({
        ...c,
        overrides: [...c.overrides, { path: 'two', region: 'S' as const }],
      })),
    ]);
    const raw = JSON.parse(await readFile(primary, 'utf8')) as CityFile;
    const paths = raw.overrides.map((o) => o.path).sort();
    expect(paths).toEqual(['one', 'two']);
  });
});
