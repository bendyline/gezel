import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeBundledPnpmPath, resolvePnpmCommand, spawnPnpm } from './pnpm.js';

const originalPnpmPath = process.env.GEZEL_PNPM_PATH;
const originalNodePath = process.env.GEZEL_NODE_PATH;
let workRoot: string;

beforeEach(async () => {
  delete process.env.GEZEL_PNPM_PATH;
  delete process.env.GEZEL_NODE_PATH;
  workRoot = await mkdtemp(join(tmpdir(), 'gezel-pnpm-command-'));
});

afterEach(async () => {
  if (originalPnpmPath === undefined) delete process.env.GEZEL_PNPM_PATH;
  else process.env.GEZEL_PNPM_PATH = originalPnpmPath;
  if (originalNodePath === undefined) delete process.env.GEZEL_NODE_PATH;
  else process.env.GEZEL_NODE_PATH = originalNodePath;
  await rm(workRoot, { recursive: true, force: true });
});

describe('resolvePnpmCommand', () => {
  it('launches the bundled pnpm script through bundled Node', () => {
    process.env.GEZEL_PNPM_PATH = join(workRoot, 'pnpm-runtime', 'bin', 'pnpm.mjs');
    process.env.GEZEL_NODE_PATH = join(workRoot, 'node');

    expect(resolvePnpmCommand(['--version'])).toEqual({
      command: process.env.GEZEL_NODE_PATH,
      args: [process.env.GEZEL_PNPM_PATH, '--version'],
      shell: false,
      mode: 'node-script',
    });
  });
});

describe('spawnPnpm', () => {
  it('forces bundled Node to launch headlessly for the Windows machine service', () => {
    let captured:
      | {
          command: string;
          args: readonly string[];
          options: import('node:child_process').SpawnOptions;
        }
      | undefined;
    const spawnImpl = ((
      command: string,
      args: readonly string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      captured = { command, args, options };
      return new EventEmitter();
    }) as unknown as typeof import('node:child_process').spawn;

    spawnPnpm(
      {
        command: 'C:\\Program Files\\gezel\\node.exe',
        args: ['C:\\Program Files\\gezel\\pnpm.mjs', 'install'],
        shell: false,
        mode: 'node-script',
      },
      { cwd: workRoot, stdio: 'inherit' },
      spawnImpl,
    );

    expect(captured).toEqual({
      command: 'C:\\Program Files\\gezel\\node.exe',
      args: ['C:\\Program Files\\gezel\\pnpm.mjs', 'install'],
      options: {
        cwd: workRoot,
        stdio: 'inherit',
        shell: false,
        // DETACHED_PROCESS on Windows only; on POSIX `detached` means
        // setsid() and the option is deliberately not applied.
        ...(process.platform === 'win32' ? { detached: true } : {}),
      },
    });
  });

  it('keeps cmd quoting at the spawn boundary without detaching the shell fallback', () => {
    let captured:
      | {
          command: string;
          args: readonly string[];
          options: import('node:child_process').SpawnOptions;
        }
      | undefined;
    const spawnImpl = ((
      command: string,
      args: readonly string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      captured = { command, args, options };
      return new EventEmitter();
    }) as unknown as typeof import('node:child_process').spawn;

    spawnPnpm(
      {
        command: 'C:\\Program Files\\nodejs\\pnpm.cmd',
        args: ['install', '--prod'],
        shell: true,
        mode: 'executable',
      },
      { cwd: workRoot },
      spawnImpl,
    );

    expect(captured?.command).toBe('"C:\\Program Files\\nodejs\\pnpm.cmd" "install" "--prod"');
    expect(captured?.args).toEqual([]);
    expect(captured?.options).toMatchObject({ shell: true });
    expect(captured?.options.windowsHide).toBeUndefined();
    expect(captured?.options.detached).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'preserves piped output from the Windows shell fallback',
    async () => {
      const child = spawnPnpm(
        {
          command: process.execPath,
          args: ['-e', "process.stdout.write('pnpm-shell-output')"],
          shell: true,
          mode: 'path-fallback',
        },
        { cwd: workRoot, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });

      const [code] = await once(child, 'close');

      expect(code).toBe(0);
      expect(stdout).toBe('pnpm-shell-output');
    },
  );
});

describe('normalizeBundledPnpmPath', () => {
  it('redirects a missing legacy executable path to the adjacent JS entrypoint', async () => {
    const bundleDir = join(workRoot, 'pnpm-bundle');
    const entryPath = join(bundleDir, 'bin', 'pnpm.mjs');
    await mkdir(join(bundleDir, 'bin'), { recursive: true });
    await writeFile(entryPath, '// pnpm\n', 'utf8');
    process.env.GEZEL_PNPM_PATH = join(bundleDir, 'pnpm');

    expect(normalizeBundledPnpmPath()).toBe(entryPath);
    expect(process.env.GEZEL_PNPM_PATH).toBe(entryPath);
  });

  it('prefers the JS entrypoint even if an old standalone executable was left behind', async () => {
    const bundleDir = join(workRoot, 'pnpm-bundle');
    const legacyPath = join(bundleDir, 'pnpm');
    const entryPath = join(bundleDir, 'bin', 'pnpm.mjs');
    await mkdir(join(bundleDir, 'bin'), { recursive: true });
    await writeFile(legacyPath, 'old standalone\n', 'utf8');
    await writeFile(entryPath, '// pnpm\n', 'utf8');
    process.env.GEZEL_PNPM_PATH = legacyPath;

    expect(normalizeBundledPnpmPath()).toBe(entryPath);
    expect(process.env.GEZEL_PNPM_PATH).toBe(entryPath);
  });

  it('leaves an unrelated missing override unchanged', () => {
    const configured = join(workRoot, 'custom-pnpm');
    process.env.GEZEL_PNPM_PATH = configured;
    expect(normalizeBundledPnpmPath()).toBe(configured);
  });
});
