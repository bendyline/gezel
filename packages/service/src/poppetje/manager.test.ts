import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelDir } from '@bendyline/gezel/paths';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PoppetjeManager } from './manager.js';

let home: string;
let manager: PoppetjeManager;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-poppetje-'));
  manager = new PoppetjeManager({ home });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('PoppetjeManager.get', () => {
  it('generates and persists when missing', async () => {
    expect(await manager.exists('imara')).toBe(false);
    const p = await manager.get('imara', 'Imara');
    expect(p.key).toBe('imara');
    expect(p.name).toBe('Imara');
    expect(await manager.exists('imara')).toBe(true);
  });

  it('is deterministic on first read (id alone produces the same poppetje)', async () => {
    const a = await manager.get('imara', 'Imara');
    // Re-init with a fresh home to prove determinism.
    const fresh = await mkdtemp(join(tmpdir(), 'gezel-poppetje-'));
    const other = new PoppetjeManager({ home: fresh });
    const b = await other.get('imara', 'Imara');
    expect(a).toEqual(b);
    await rm(fresh, { recursive: true, force: true });
  });

  it('returns the persisted struct on subsequent reads', async () => {
    const first = await manager.get('imara', 'Imara');
    const second = await manager.get('imara', 'Imara');
    expect(second).toEqual(first);
  });

  it('updates the name in-place when the gezel was renamed', async () => {
    await manager.get('imara', 'Imara');
    const renamed = await manager.get('imara', 'Imara the Meester');
    expect(renamed.name).toBe('Imara the Meester');
    // The wood-grain seed (key) stays anchored.
    expect(renamed.key).toBe('imara');
  });
});

describe('PoppetjeManager.reroll', () => {
  it('changes the slots but pins the key', async () => {
    const before = await manager.get('imara', 'Imara');
    const after = await manager.reroll('imara', 'Imara');
    expect(after.key).toBe('imara');
    // The deterministic-from-id init and a random reroll should rarely collide.
    expect(JSON.stringify(before)).not.toBe(JSON.stringify(after));
  });

  it('is deterministic when an explicit seed is supplied', async () => {
    const a = await manager.reroll('imara', 'Imara', { seed: 12345 });
    const b = await manager.reroll('imara', 'Imara', { seed: 12345 });
    expect(a).toEqual(b);
  });

  it('persists the new poppetje', async () => {
    const rolled = await manager.reroll('imara', 'Imara', { seed: 7 });
    const read = await manager.tryRead('imara');
    expect(read).toEqual(rolled);
  });

  it('never assigns beard or mustache to a female gezel across many seeds', async () => {
    // 50 distinct rerolls — odds of facial hair landing at least once is
    // overwhelming without the gate (~18% per roll). Facial hair lives in
    // its own slot now, so the gate guards `facialHair`, not `accessory`.
    for (let n = 0; n < 50; n++) {
      const p = await manager.reroll('luciana', 'Luciana', { seed: n, gender: 'female' });
      expect(p.facialHair).toBeNull();
    }
  });
});

describe('PoppetjeManager.set', () => {
  it('persists an explicit struct after validation', async () => {
    const initial = await manager.get('imara', 'Imara');
    // Force a specific override and confirm it round-trips.
    const replaced = { ...initial, hat: 'beanie' as const, expression: 'wink' as const };
    const saved = await manager.set('imara', 'Imara', replaced);
    expect(saved.hat).toBe('beanie');
    expect(saved.expression).toBe('wink');
    const read = await manager.tryRead('imara');
    expect(read?.hat).toBe('beanie');
  });

  it('forces the key field to the gezel id', async () => {
    const initial = await manager.get('imara', 'Imara');
    const tampered = { ...initial, key: 'attacker-id' };
    const saved = await manager.set('imara', 'Imara', tampered);
    expect(saved.key).toBe('imara');
  });
});

describe('PoppetjeManager.tryRead', () => {
  it('returns null when the file is absent', async () => {
    expect(await manager.tryRead('nonexistent')).toBeNull();
  });

  it('returns null and self-heals when the file is unparseable', async () => {
    await manager.get('imara', 'Imara');
    const file = join(gezelDir(home, 'imara'), 'poppetje.json');
    await writeFile(file, 'not json', 'utf8');
    expect(await manager.tryRead('imara')).toBeNull();
    // get() should still produce a valid struct via regen.
    const regen = await manager.get('imara', 'Imara');
    expect(regen.key).toBe('imara');
  });
});

describe('PoppetjeManager.remove + rename', () => {
  it('remove drops the file', async () => {
    await manager.get('imara', 'Imara');
    await manager.remove('imara');
    expect(await manager.exists('imara')).toBe(false);
  });

  it('rename repins the key and removes the old file', async () => {
    await manager.get('imara', 'Imara');
    await manager.rename('imara', 'imara-2', 'Imara');
    expect(await manager.exists('imara')).toBe(false);
    const renamed = await manager.tryRead('imara-2');
    expect(renamed?.key).toBe('imara-2');
  });
});

describe('PoppetjeManager file shape', () => {
  it('writes pretty-printed JSON for git-friendliness', async () => {
    await manager.get('imara', 'Imara');
    const raw = await readFile(join(gezelDir(home, 'imara'), 'poppetje.json'), 'utf8');
    expect(raw).toMatch(/\n/);
    expect(JSON.parse(raw)).toMatchObject({ key: 'imara', name: 'Imara' });
  });
});
