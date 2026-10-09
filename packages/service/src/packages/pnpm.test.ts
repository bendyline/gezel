import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INSTALL_GUARD_FLAGS,
  normalizeBundledPnpmPath,
  resolvePnpmCommand,
  runPnpm,
  spawnPnpm,
} from './pnpm.js';

const BUNDLED_PNPM = fileURLToPath(
  new URL('../../../app/dist/pnpm-bundle/bin/pnpm.mjs', import.meta.url),
);

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

describe('runPnpm install guard', () => {
  it('prepends every guard flag to install-class runs, and none to allowed runs', async () => {
    const fakePnpm = join(workRoot, 'fake-pnpm.mjs');
    await writeFile(fakePnpm, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    process.env.GEZEL_PNPM_PATH = fakePnpm;
    process.env.GEZEL_NODE_PATH = process.execPath;

    const guarded = await runPnpm(['add', '--', 'zod@^4'], { cwd: workRoot });
    expect(JSON.parse(guarded.stdout)).toEqual([...INSTALL_GUARD_FLAGS, 'add', '--', 'zod@^4']);
    expect(INSTALL_GUARD_FLAGS).toEqual(
      expect.arrayContaining(['--ignore-scripts', '--ignore-pnpmfile']),
    );

    const allowed = await runPnpm(['config', 'get', 'registry'], {
      cwd: workRoot,
      lifecycle: 'allow',
    });
    expect(JSON.parse(allowed.stdout)).toEqual(['config', 'get', 'registry']);
  });

  it.runIf(existsSync(BUNDLED_PNPM))(
    'keeps a planted pnpmfile inert under the bundled pnpm',
    async () => {
      const project = join(workRoot, 'planted');
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, 'package.json'),
        JSON.stringify({ name: 'planted', version: '1.0.0', private: true }),
      );
      for (const name of ['.pnpmfile.cjs', '.pnpmfile.mjs']) {
        const marker = JSON.stringify(join(project, `RAN-${name}`));
        await writeFile(
          join(project, name),
          name.endsWith('.mjs')
            ? `import fs from 'node:fs';\nfs.writeFileSync(${marker}, 'x');\nexport const hooks = {};\n`
            : `require('node:fs').writeFileSync(${marker}, 'x');\nmodule.exports = { hooks: {} };\n`,
        );
      }
      process.env.GEZEL_PNPM_PATH = BUNDLED_PNPM;
      process.env.GEZEL_NODE_PATH = process.execPath;

      const result = await runPnpm(['install', '--offline'], { cwd: project });

      expect(result.ok, result.log).toBe(true);
      expect(existsSync(join(project, 'RAN-.pnpmfile.cjs'))).toBe(false);
      expect(existsSync(join(project, 'RAN-.pnpmfile.mjs'))).toBe(false);
    },
    60_000,
  );
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
        ...(process.platform === 'win32' ? { windowsHide: true } : {}),
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
    expect(captured?.options.windowsHide).toBe(process.platform === 'win32' ? true : undefined);
    expect(captured?.options.detached).toBeUndefined();
  });

  it('leads a process group on POSIX only when asked, never on Windows', () => {
    const captured: import('node:child_process').SpawnOptions[] = [];
    const spawnImpl = ((
      _command: string,
      _args: readonly string[],
      options: import('node:child_process').SpawnOptions,
    ) => {
      captured.push(options);
      return new EventEmitter();
    }) as unknown as typeof import('node:child_process').spawn;
    const invocation = {
      command: process.execPath,
      args: ['pnpm.mjs', 'exec', 'playwright'],
      shell: false,
      mode: 'node-script' as const,
    };

    spawnPnpm(invocation, { cwd: workRoot, processGroup: true }, spawnImpl);
    spawnPnpm(invocation, { cwd: workRoot }, spawnImpl);

    expect(captured[0]?.detached).toBe(process.platform === 'win32' ? undefined : true);
    expect(captured[0]).not.toHaveProperty('processGroup');
    expect(captured[1]?.detached).toBeUndefined();
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
