import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getCliPresence } from './cli-detection.js';

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('getCliPresence', () => {
  it('recognizes explicit binary files without executing them', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-cli-presence-'));
    const claude = join(dir, 'claude.exe');
    const codex = join(dir, 'codex.cmd');
    await Promise.all([writeFile(claude, 'not an executable'), writeFile(codex, 'not a script')]);

    expect(
      getCliPresence(
        { anthropicCli: { binaryPath: claude }, codexCli: { binaryPath: codex } },
        { PATH: '' },
      ),
    ).toEqual({
      anthropicCli: { installed: true, path: claude },
      codexCli: { installed: true, path: codex },
    });
  });

  it('reuses a PATH lookup until it expires', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gezel-cli-presence-path-'));
    const env = { PATH: dir, PATHEXT: '.EXE' };
    const t0 = 1_000_000;
    expect(getCliPresence({}, env, t0).anthropicCli.installed).toBe(false);

    const claude = join(dir, process.platform === 'win32' ? 'claude.EXE' : 'claude');
    await writeFile(claude, 'not an executable');
    expect(getCliPresence({}, env, t0 + 5_000).anthropicCli.installed).toBe(false);
    expect(getCliPresence({}, env, t0 + 31_000).anthropicCli).toEqual({
      installed: true,
      path: claude,
    });
  });

  it('reports missing overrides without falling back to PATH', () => {
    const missing = join(tmpdir(), 'gezel-cli-presence-missing');
    const result = getCliPresence(
      { anthropicCli: { binaryPath: missing }, codexCli: { binaryPath: missing } },
      { PATH: '' },
    );

    expect(result.anthropicCli.installed).toBe(false);
    expect(result.anthropicCli.error).toContain('path is unavailable');
    expect(result.codexCli.installed).toBe(false);
    expect(result.codexCli.error).toContain('path is unavailable');
  });
});
