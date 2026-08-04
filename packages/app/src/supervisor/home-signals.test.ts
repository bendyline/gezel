import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHomeUsageSignals, readHostingPin, writeHostingPin } from './home-signals.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-home-signals-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('readHomeUsageSignals', () => {
  it('treats a missing or empty home as never used', async () => {
    expect((await readHomeUsageSignals(home)).everUsed).toBe(false);
    expect((await readHomeUsageSignals(join(home, 'nope'))).everUsed).toBe(false);
  });

  it('treats the auto-created system crew + default project as never used', async () => {
    // Boot creates the whole crew (Meester, Klerk, Boekwachter) and the
    // default project on every daemon start — none of that is evidence a
    // person worked here.
    await mkdir(join(home, 'gezels', 'fenton', 'sessions'), { recursive: true });
    await mkdir(join(home, 'gezels', 'adler'), { recursive: true });
    await mkdir(join(home, 'gezels', 'meriem'), { recursive: true });
    await mkdir(join(home, 'projects', 'default'), { recursive: true });
    const signals = await readHomeUsageSignals(home);
    expect(signals).toMatchObject({
      gezelCount: 3,
      projectCount: 1,
      hasAnySession: false,
      everUsed: false,
    });
  });

  it('flags a home with any persisted session as used', async () => {
    await mkdir(join(home, 'gezels', 'fenton', 'sessions'), { recursive: true });
    await writeFile(join(home, 'gezels', 'fenton', 'sessions', 'abc.json'), '{}');
    expect((await readHomeUsageSignals(home)).everUsed).toBe(true);
  });

  it('flags a project beyond the auto-created default as used', async () => {
    await mkdir(join(home, 'projects', 'default'), { recursive: true });
    await mkdir(join(home, 'projects', 'squisq'), { recursive: true });
    expect((await readHomeUsageSignals(home)).everUsed).toBe(true);
  });
});

describe('hosting pin', () => {
  it('defaults to auto when config is missing or malformed', async () => {
    expect(await readHostingPin(home)).toBe('auto');
    await writeFile(join(home, 'config.json'), 'not json');
    expect(await readHostingPin(home)).toBe('auto');
    await writeFile(join(home, 'config.json'), JSON.stringify({ hosting: 'bogus' }));
    expect(await readHostingPin(home)).toBe('auto');
  });

  it('round-trips a written pin and preserves other config fields', async () => {
    await writeFile(
      join(home, 'config.json'),
      JSON.stringify({ provider: 'llama-cpp', firstRunCompleted: true }),
    );
    expect(await writeHostingPin(home, 'per-user')).toBe(true);
    expect(await readHostingPin(home)).toBe('per-user');
    const parsed = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(parsed.provider).toBe('llama-cpp');
    expect(parsed.firstRunCompleted).toBe(true);
    expect(parsed.hosting).toBe('per-user');
  });

  it('creates config.json when absent', async () => {
    expect(await writeHostingPin(home, 'per-user')).toBe(true);
    expect(await readHostingPin(home)).toBe('per-user');
  });
});
