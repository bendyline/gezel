import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SecurityStateCorruptionError,
  readSecurityJson,
  writeSecurityJson,
} from './security-json.js';

interface SecurityState {
  version: number;
  token: string;
}

function decodeState(raw: string): SecurityState {
  const value = JSON.parse(raw) as Partial<SecurityState>;
  if (value.version !== 1 || typeof value.token !== 'string') {
    throw new Error('invalid security state');
  }
  return { version: value.version, token: value.token };
}

describe('security JSON recovery', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-security-json-'));
    file = join(dir, 'grants.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null only when both primary and backup are absent', async () => {
    await expect(readSecurityJson(file, 'grant registry', decodeState)).resolves.toBeNull();
  });

  it('prefers a valid primary without consulting or rewriting a corrupt backup', async () => {
    const primary = '{"version":1,"token":"primary"}\n';
    await writeFile(file, primary);
    await writeFile(`${file}.bak`, 'corrupt');

    await expect(readSecurityJson(file, 'grant registry', decodeState)).resolves.toEqual({
      version: 1,
      token: 'primary',
    });
    await expect(readFile(`${file}.bak`, 'utf8')).resolves.toBe('corrupt');
  });

  it('repairs a corrupt primary from a valid backup', async () => {
    const backup = '{"version":1,"token":"backup"}\n';
    await writeFile(file, 'corrupt');
    await writeFile(`${file}.bak`, backup);

    await expect(readSecurityJson(file, 'grant registry', decodeState)).resolves.toEqual({
      version: 1,
      token: 'backup',
    });
    await expect(readFile(file, 'utf8')).resolves.toBe(backup);
  });

  it('repairs a missing primary from a valid backup', async () => {
    const backup = '{"version":1,"token":"backup-only"}\n';
    await writeFile(`${file}.bak`, backup);

    await expect(readSecurityJson(file, 'grant registry', decodeState)).resolves.toEqual({
      version: 1,
      token: 'backup-only',
    });
    await expect(readFile(file, 'utf8')).resolves.toBe(backup);
  });

  it('fails closed and preserves both files when neither snapshot validates', async () => {
    await writeFile(file, 'bad-primary');
    await writeFile(`${file}.bak`, 'bad-backup');

    const error = await readSecurityJson(file, 'grant registry', decodeState).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(SecurityStateCorruptionError);
    expect(error).toMatchObject({ label: 'grant registry', filePath: file });
    expect((error as Error).message).toContain('both the primary and backup failed validation');
    await expect(readFile(file, 'utf8')).resolves.toBe('bad-primary');
    await expect(readFile(`${file}.bak`, 'utf8')).resolves.toBe('bad-backup');
  });

  it('writes the same valid snapshot to the backup and primary', async () => {
    const content = '{"version":1,"token":"fresh"}\n';

    await writeSecurityJson(file, content);

    await expect(readFile(file, 'utf8')).resolves.toBe(content);
    await expect(readFile(`${file}.bak`, 'utf8')).resolves.toBe(content);
  });

  it.skipIf(process.platform === 'win32')('keeps both published snapshots private', async () => {
    await writeSecurityJson(file, '{"version":1,"token":"secret"}\n');

    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
  });
});
