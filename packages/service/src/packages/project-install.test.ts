import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PnpmResult, runPnpm } from './pnpm.js';
import { addProjectPackage } from './project-install.js';

vi.mock('./pnpm.js', () => ({ runPnpm: vi.fn() }));

const success: PnpmResult = {
  ok: true,
  code: 0,
  stdout: 'installed',
  stderr: '',
  log: 'installed',
};
function failed(message: string): PnpmResult {
  return { ok: false, code: 1, stdout: message, stderr: '', log: message };
}

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'gezel-project-install-'));
  vi.mocked(runPnpm).mockReset().mockResolvedValue(success);
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('project dependency repair', () => {
  it.each([
    'ERR_PNPM_UNEXPECTED_STORE',
    'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE',
    'ERR_PNPM_MODULES_BREAKING_CHANGE',
    'ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF',
    'ERR_PNPM_HOIST_PATTERN_DIFF',
    'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF',
    'ERR_PNPM_NODE_LINKER_DIFF',
  ])('repairs %s once and resumes the approved add', async (code) => {
    vi.mocked(runPnpm).mockResolvedValueOnce(failed(`\u001b[31m ${code}\u001b[0m Old layout`));
    const registry = 'https://mirror.example/npm/';
    const result = await addProjectPackage('esbuild', { cwd, registry });

    expect(result.ok).toBe(true);
    expect(result.log).toContain(code);
    expect(runPnpm).toHaveBeenNthCalledWith(
      2,
      [
        'install',
        `--config.registry=${registry}`,
        '--no-frozen-lockfile',
        '--config.confirmModulesPurge=false',
        '--config.recursive-install=false',
      ],
      { cwd, lifecycle: 'ignore' },
    );
    expect(vi.mocked(runPnpm).mock.calls[2]).toEqual(vi.mocked(runPnpm).mock.calls[0]);
    expect(runPnpm).toHaveBeenCalledTimes(3);
  });

  it.each(['ERR_PNPM_FETCH_404', 'ERR_PNPM_TARBALL_INTEGRITY', 'ERR_PNPM_UNSUPPORTED_ENGINE'])(
    'surfaces %s without attempting a repair',
    async (code) => {
      vi.mocked(runPnpm).mockResolvedValueOnce(failed(`${code} Cannot install`));
      const result = await addProjectPackage('missing', { cwd });
      expect(result.error).toContain(`${code} Cannot install`);
      expect(runPnpm).toHaveBeenCalledTimes(1);
    },
  );

  it('reports the repair failure and does not retry add', async () => {
    vi.mocked(runPnpm)
      .mockResolvedValueOnce(failed('ERR_PNPM_UNEXPECTED_STORE Old store'))
      .mockResolvedValueOnce(failed('ERR_PNPM_FETCH_401 Authentication failed'));
    const result = await addProjectPackage('esbuild', { cwd });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Dependency repair failed');
    expect(result.error).toContain('ERR_PNPM_FETCH_401');
    expect(result.log).toContain('ERR_PNPM_UNEXPECTED_STORE');
    expect(runPnpm).toHaveBeenCalledTimes(2);
  });

  it('does not loop if the retried add still fails compatibility', async () => {
    const mismatch = failed('ERR_PNPM_UNEXPECTED_STORE Old store');
    vi.mocked(runPnpm)
      .mockResolvedValueOnce(mismatch)
      .mockResolvedValueOnce(success)
      .mockResolvedValueOnce(mismatch);
    const result = await addProjectPackage('esbuild', { cwd });
    expect(result.error).toContain('Package install after dependency repair failed');
    expect(runPnpm).toHaveBeenCalledTimes(3);
  });

  it('bounds and redacts the detailed error', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    vi.mocked(runPnpm).mockResolvedValueOnce(
      failed(`ERR_PNPM_FETCH_401 ${token}\n${'x'.repeat(8000)}`),
    );
    const result = await addProjectPackage('esbuild', { cwd });
    expect(result.error).toContain('[REDACTED]');
    expect(result.error).not.toContain(token);
    expect(result.error!.length).toBeLessThan(3100);
  });

  it('serializes overlapping installs through the complete repair', async () => {
    let release!: (value: PnpmResult) => void;
    const firstResult = new Promise<PnpmResult>((resolve) => {
      release = resolve;
    });
    vi.mocked(runPnpm).mockReturnValueOnce(firstResult);
    const first = addProjectPackage('first', { cwd });
    await vi.waitFor(() => expect(runPnpm).toHaveBeenCalledTimes(1));
    const second = addProjectPackage('second', { cwd });
    release(failed('ERR_PNPM_UNEXPECTED_STORE Old store'));
    await Promise.all([first, second]);
    expect(vi.mocked(runPnpm).mock.calls.map(([args]) => args)).toEqual([
      ['add', '--', 'first'],
      expect.arrayContaining(['install']),
      ['add', '--', 'first'],
      ['add', '--', 'second'],
    ]);
  });

  it('does not start or repair an aborted install', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await addProjectPackage('esbuild', { cwd, signal: controller.signal });
    expect(result.ok).toBe(false);
    expect(runPnpm).not.toHaveBeenCalled();
  });
});
