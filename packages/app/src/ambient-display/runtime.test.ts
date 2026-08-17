import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ambientDir, ambientDisplayStateFile } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AmbientDisplayModule, SavedWallpaper } from './index.js';
import { applyLatest, disable, enable, readDisplayState } from './runtime.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-ambient-runtime-'));
  await mkdir(ambientDir(home), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function fakeModule(
  overrides: Partial<AmbientDisplayModule> = {},
): AmbientDisplayModule & { applied: string[] } {
  const applied: string[] = [];
  return {
    applied,
    capability: async () => ({ supported: true, canRestore: true }),
    getCurrentWallpaper: async () => '/prior/wallpaper.jpg',
    setWallpaper: async (path: string) => {
      applied.push(path);
    },
    restoreWallpaper: vi.fn(async (_saved: SavedWallpaper) => undefined),
    ...overrides,
  };
}

async function seedDated(name: string): Promise<void> {
  await writeFile(join(ambientDir(home), name), `bytes-of-${name}`);
}

describe('applyLatest', () => {
  it('copies the newest dated PNG into a slot and applies the slot path', async () => {
    await seedDated('dashboard-20260817-0900.png');
    await seedDated('dashboard-20260817-1000.png');
    const module = fakeModule();

    const result = await applyLatest({ home, module });
    expect(result.applied).toBe(true);
    expect(module.applied).toEqual([join(ambientDir(home), 'applied-a.png')]);
    expect(await readFile(join(ambientDir(home), 'applied-a.png'), 'utf8')).toBe(
      'bytes-of-dashboard-20260817-1000.png',
    );
    const state = await readDisplayState(home);
    expect(state.lastApplied).toMatchObject({
      source: 'dashboard-20260817-1000.png',
      slot: 'applied-a.png',
    });
  });

  it('alternates slots so consecutive applies never reuse a path', async () => {
    await seedDated('dashboard-20260817-0900.png');
    const module = fakeModule();
    await applyLatest({ home, module });
    await seedDated('dashboard-20260817-1000.png');
    await applyLatest({ home, module });
    expect(module.applied).toEqual([
      join(ambientDir(home), 'applied-a.png'),
      join(ambientDir(home), 'applied-b.png'),
    ]);
  });

  it('skips when the newest image is already applied, unless forced', async () => {
    await seedDated('dashboard-20260817-0900.png');
    const module = fakeModule();
    await applyLatest({ home, module });
    expect((await applyLatest({ home, module })).reason).toBe('unchanged');
    expect(module.applied).toHaveLength(1);
    expect((await applyLatest({ home, module }, { force: true })).applied).toBe(true);
    expect(module.applied).toHaveLength(2);
  });

  it('reports no-image and unsupported without touching the OS', async () => {
    const module = fakeModule();
    expect((await applyLatest({ home, module })).reason).toBe('no-image');

    await seedDated('dashboard-20260817-0900.png');
    const unsupported = fakeModule({
      capability: async () => ({ supported: false, reason: 'unknown-desktop', canRestore: false }),
    });
    expect((await applyLatest({ home, module: unsupported })).reason).toBe('unsupported');
    expect(unsupported.applied).toEqual([]);
  });
});

describe('enable / disable', () => {
  it('captures the previous wallpaper once, and never overwrites the capture', async () => {
    await seedDated('dashboard-20260817-0900.png');
    const module = fakeModule();
    await enable({ home, module });
    let state = await readDisplayState(home);
    expect(state.restore?.value).toBe('/prior/wallpaper.jpg');

    // Second enable while our own slot is current must keep the original.
    module.getCurrentWallpaper = async () => join(ambientDir(home), 'applied-a.png');
    await enable({ home, module });
    state = await readDisplayState(home);
    expect(state.restore?.value).toBe('/prior/wallpaper.jpg');
  });

  it('restores on disable and clears state either way', async () => {
    await seedDated('dashboard-20260817-0900.png');
    const module = fakeModule();
    await enable({ home, module });

    const result = await disable({ home, module });
    expect(result.restored).toBe(true);
    expect(module.restoreWallpaper).toHaveBeenCalledWith(
      expect.objectContaining({ value: '/prior/wallpaper.jpg' }),
    );
    expect(await readDisplayState(home)).toEqual({});
  });

  it('reports nothing-captured when the wallpaper was unreadable at enable', async () => {
    await seedDated('dashboard-20260817-0900.png');
    const module = fakeModule({ getCurrentWallpaper: async () => null });
    await enable({ home, module });
    const result = await disable({ home, module });
    expect(result).toEqual({ restored: false, reason: 'nothing-captured' });
  });

  it('survives a corrupt state file', async () => {
    await writeFile(ambientDisplayStateFile(home), 'not-json');
    expect(await readDisplayState(home)).toEqual({});
  });
});
