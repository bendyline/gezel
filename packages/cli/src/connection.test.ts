import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fileTokenStorage,
  normalizeServiceUrl,
  resolveCliAppId,
  shouldTrySystemService,
  validateGlobals,
} from './connection.js';

const originalHome = process.env.GEZEL_HOME;
const homes: string[] = [];

afterEach(async () => {
  if (originalHome === undefined) delete process.env.GEZEL_HOME;
  else process.env.GEZEL_HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('system-service selection', () => {
  it('tries the machine service by default', () => {
    expect(shouldTrySystemService({}, {})).toBe(true);
  });

  it.each([
    [{ connect: 'https://example.test' }, {}],
    [{ standalone: true }, {}],
    [{ home: 'D:\\alternate' }, {}],
    [{}, { GEZEL_HOME: 'D:\\alternate' }],
    [{}, { GEZEL_DEV: '1' }],
  ])('skips the machine service for an explicit override', (globals, env) => {
    expect(shouldTrySystemService(globals, env)).toBe(false);
  });

  it('rejects contradictory or incomplete connection flags', () => {
    expect(() => validateGlobals({ connect: 'https://example.test', standalone: true })).toThrow(
      /cannot be used together/,
    );
    expect(() => validateGlobals({ token: 'secret' })).toThrow(/requires --connect/);
    expect(() => validateGlobals({ connect: 'not a url' })).toThrow(/Invalid --connect URL/);
  });

  it('normalizes explicit service URLs without accepting embedded credentials', () => {
    expect(normalizeServiceUrl('https://example.test:443/')).toBe('https://example.test');
    expect(() => normalizeServiceUrl('https://user:secret@example.test')).toThrow(
      /must not contain credentials/,
    );
  });
});

describe('CLI grant token storage', () => {
  it('uses a stable per-installation app id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-cli-id-'));
    homes.push(home);
    process.env.GEZEL_HOME = home;

    const first = await resolveCliAppId();
    const second = await resolveCliAppId();

    expect(first).toBe(second);
    expect(first).toMatch(/^gezel-cli\.[0-9a-f-]{36}$/);
  });

  it('persists tokens per service origin and supports revocation cleanup', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-cli-token-'));
    homes.push(home);
    process.env.GEZEL_HOME = home;

    const first = fileTokenStorage('https://127.0.0.1:6228');
    const second = fileTokenStorage('https://remote.example');
    await first.save('gezel-cli', 'local-token');
    await second.save('gezel-cli', 'remote-token');

    await expect(first.load('gezel-cli')).resolves.toBe('local-token');
    await expect(second.load('gezel-cli')).resolves.toBe('remote-token');
    await first.remove('gezel-cli');
    await expect(first.load('gezel-cli')).resolves.toBeNull();
    await expect(second.load('gezel-cli')).resolves.toBe('remote-token');
  });
});
