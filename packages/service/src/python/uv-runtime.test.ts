import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UvRuntime, versionGte } from './uv-runtime.js';

/**
 * Fake child-process and exec so we can drive UvRuntime's detection
 * without any real Python or uv on the test host.
 */
interface FakeExecCall {
  cmd: string;
}
interface FakeSpawnCall {
  command: string;
  args: string[];
}

function makeFakes(behavior: {
  exec: (cmd: string) => { stdout: string; stderr: string } | Error;
  spawn: (
    command: string,
    args: string[],
  ) => {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    afterExit?: () => void | Promise<void>;
  };
}) {
  const execCalls: FakeExecCall[] = [];
  const spawnCalls: FakeSpawnCall[] = [];

  const exec = ((
    cmd: string,
    _opts: unknown,
    cb: (err: Error | null, out: { stdout: string; stderr: string }) => void,
  ) => {
    execCalls.push({ cmd });
    const result = behavior.exec(cmd);
    if (result instanceof Error) {
      cb(result, { stdout: '', stderr: '' });
    } else {
      cb(null, result);
    }
    return {} as unknown;
  }) as unknown as ConstructorParameters<typeof UvRuntime>[0]['exec'];

  const spawn = ((command: string, args: string[]) => {
    spawnCalls.push({ command, args });
    const plan = behavior.spawn(command, args);
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter | null;
      stderr: EventEmitter | null;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(async () => {
      if (plan.stdout) child.stdout?.emit('data', Buffer.from(plan.stdout));
      if (plan.stderr) child.stderr?.emit('data', Buffer.from(plan.stderr));
      await plan.afterExit?.();
      child.emit('exit', plan.exitCode);
    });
    return child as unknown as ReturnType<typeof import('node:child_process').spawn>;
  }) as unknown as ConstructorParameters<typeof UvRuntime>[0]['spawn'];

  return { exec, spawn, execCalls, spawnCalls };
}

describe('versionGte', () => {
  it('accepts equal versions', () => {
    expect(versionGte('3.10', '3.10')).toBe(true);
    expect(versionGte('3.10.4', '3.10.4')).toBe(true);
  });
  it('accepts higher minor', () => {
    expect(versionGte('3.11', '3.10')).toBe(true);
    expect(versionGte('3.11.0', '3.10.9')).toBe(true);
  });
  it('rejects lower minor', () => {
    expect(versionGte('3.9', '3.10')).toBe(false);
    expect(versionGte('3.9.18', '3.10')).toBe(false);
  });
  it('handles missing patch in minimum', () => {
    expect(versionGte('3.10.5', '3.10')).toBe(true);
  });
});

describe('UvRuntime — installer detection precedence', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-uv-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('prefers bundled uv without probing PATH or system Python', async () => {
    const bundled = join(home, 'fake-uv');
    await writeFile(bundled, '#!/bin/sh\necho uv 0.5.99', { mode: 0o755 });
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd.includes('fake-uv')) return { stdout: 'uv 0.5.99', stderr: '' };
        return new Error(`unexpected system-runtime probe: ${cmd}`);
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: bundled,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });

    const desc = await uv.describeRuntime();

    expect(desc.source).toBe('bundled-uv');
    expect(desc.uvVersion).toBe('0.5.99');
    expect(desc.installerPath).toBe(bundled);
    expect(fakes.execCalls.map((call) => call.cmd)).toEqual([`"${bundled}" --version`]);
  });

  it('uses system uv when no bundled runtime is available', async () => {
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return { stdout: 'uv 0.5.12', stderr: '' };
        return new Error('not found');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const desc = await uv.describeRuntime();
    expect(desc.source).toBe('system-uv');
    expect(desc.uvVersion).toBe('0.5.12');
  });

  it('falls back to system python when uv missing but python3 ≥ 3.10', async () => {
    // The production `systemPythonCandidates()` returns
    // `['python3', 'python']` on POSIX and `['python', 'py -3']` on
    // Windows. Stub every name so the test exercises both candidate
    // lists without hard-coding the platform.
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return new Error('not found');
        if (
          cmd === 'python3 --version' ||
          cmd === 'python --version' ||
          cmd === 'py -3 --version'
        ) {
          return { stdout: 'Python 3.11.6', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const desc = await uv.describeRuntime();
    expect(desc.source).toBe('system-python');
    expect(desc.pythonVersion).toBe('3.11.6');
  });

  it('rejects system python when below minimum version', async () => {
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return new Error('not found');
        if (cmd === 'python3 --version') return { stdout: 'Python 3.8.10', stderr: '' };
        if (cmd === 'python --version') return new Error('not found');
        return new Error('not found');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const desc = await uv.describeRuntime();
    expect(desc.source).toBeNull();
    expect(desc.reason).toContain('Python runtime unavailable');
  });

  it('uses bundled uv even when system runtimes would also work', async () => {
    const bundled = join(home, 'fake-uv');
    await writeFile(bundled, '#!/bin/sh\necho uv 0.5.99', { mode: 0o755 });
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd.includes('fake-uv')) return { stdout: 'uv 0.5.99', stderr: '' };
        if (cmd === 'uv --version') return { stdout: 'uv 0.6.0', stderr: '' };
        if (cmd === 'python3 --version' || cmd === 'python --version') {
          return { stdout: 'Python 3.12.1', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: bundled,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const desc = await uv.describeRuntime();
    expect(desc.source).toBe('bundled-uv');
    expect(desc.uvVersion).toBe('0.5.99');
    expect(desc.installerPath).toBe(bundled);
    expect(fakes.execCalls.map((call) => call.cmd)).toEqual([`"${bundled}" --version`]);
  });

  it('reports bundledUvAvailable=false when the bundled path is missing on disk', async () => {
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return { stdout: 'uv 0.5.12', stderr: '' };
        return new Error('nope');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: join(home, 'does-not-exist'),
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const desc = await uv.describeRuntime();
    expect(desc.bundledUvAvailable).toBe(false);
  });
});

describe('UvRuntime — ensureVenv', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-uv-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates a venv via system uv and installs pinned packages', async () => {
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return { stdout: 'uv 0.5.12', stderr: '' };
        if (cmd.includes('python') && cmd.includes('--version')) {
          return { stdout: 'Python 3.11.7', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: (_command, args) => ({
        exitCode: 0,
        afterExit: async () => {
          // Simulate uv creating the python binary inside the venv when
          // called with `venv <path>`.
          const venvArg = args.find((a) => a.includes('mlx') && !a.startsWith('--'));
          if (args.includes('venv') && venvArg) {
            const binDir =
              process.platform === 'win32' ? join(venvArg, 'Scripts') : join(venvArg, 'bin');
            await mkdir(binDir, { recursive: true });
            const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
            await writeFile(join(binDir, pyName), '#!/bin/sh\necho Python 3.11.7');
          }
        },
      }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const handle = await uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] });

    expect(handle.source).toBe('system-uv');
    expect(handle.packages).toEqual(['mlx-lm==0.25.3']);
    expect(handle.venvRoot).toBe(join(home, 'engines', 'uv', 'venvs', 'mlx'));
    expect(existsSync(join(handle.venvRoot, 'uv.json'))).toBe(true);

    const venvCall = fakes.spawnCalls.find((c) => c.args.includes('venv'));
    expect(venvCall?.command).toBe('uv');
    expect(venvCall?.args).toContain(handle.venvRoot);
    expect(venvCall?.args).toContain('--python');

    const installCall = fakes.spawnCalls.find((c) => c.args.includes('install'));
    expect(installCall?.args).toContain('mlx-lm==0.25.3');
    expect(installCall?.args).toContain('--python');
  });

  it('reuses an existing venv when packages match', async () => {
    // Seed a valid manifest + python binary so ensureVenv takes the fast path.
    const venvRoot = join(home, 'engines', 'uv', 'venvs', 'mlx');
    const binDir = process.platform === 'win32' ? join(venvRoot, 'Scripts') : join(venvRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
    await writeFile(join(binDir, pyName), '#!/bin/sh');
    const manifest = {
      version: 1,
      name: 'mlx',
      source: 'system-uv' as const,
      pythonVersion: '3.11.7',
      uvVersion: '0.5.12',
      packages: ['mlx-lm==0.25.3'],
      installedAt: '2026-04-01T00:00:00.000Z',
      installerPath: 'uv',
    };
    await writeFile(join(venvRoot, 'uv.json'), JSON.stringify(manifest), 'utf8');

    const fakes = makeFakes({
      exec: () => new Error('should not probe'),
      spawn: () => ({ exitCode: 99 }), // would fail loudly if called
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const handle = await uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] });
    expect(handle.packages).toEqual(['mlx-lm==0.25.3']);
    expect(fakes.spawnCalls).toHaveLength(0);
    expect(fakes.execCalls).toHaveLength(0);
  });

  it('re-installs when requested packages differ from manifest', async () => {
    const venvRoot = join(home, 'engines', 'uv', 'venvs', 'mlx');
    const binDir = process.platform === 'win32' ? join(venvRoot, 'Scripts') : join(venvRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
    await writeFile(join(binDir, pyName), '#!/bin/sh');
    const manifest = {
      version: 1,
      name: 'mlx',
      source: 'system-uv' as const,
      pythonVersion: '3.11.7',
      uvVersion: '0.5.12',
      packages: ['mlx-lm==0.25.3'],
      installedAt: '2026-04-01T00:00:00.000Z',
      installerPath: 'uv',
    };
    await writeFile(join(venvRoot, 'uv.json'), JSON.stringify(manifest), 'utf8');

    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return { stdout: 'uv 0.5.12', stderr: '' };
        if (cmd.includes('python') && cmd.includes('--version')) {
          return { stdout: 'Python 3.11.7', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: () => ({ exitCode: 0 }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const handle = await uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.26.0'] });
    expect(handle.packages).toEqual(['mlx-lm==0.26.0']);
    // pip install runs; no 'venv' call needed because the venv's python already exists.
    const installCall = fakes.spawnCalls.find((c) => c.args.includes('install'));
    expect(installCall?.args).toContain('mlx-lm==0.26.0');
  });

  it('uses python -m venv + pip on the system-python branch', async () => {
    // The first system-python candidate differs by platform: `python3`
    // on POSIX, `python` on Windows. Stub both names + the venv-python
    // probe so the test exercises whichever the host code picks.
    const sysPyName = process.platform === 'win32' ? 'python' : 'python3';
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return new Error('not found');
        if (cmd === 'python3 --version' || cmd === 'python --version') {
          return { stdout: 'Python 3.11.6', stderr: '' };
        }
        if (cmd.includes('venvs') && cmd.includes('--version')) {
          return { stdout: 'Python 3.11.6', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: (_command, args) => ({
        exitCode: 0,
        afterExit: async () => {
          const venvArg = args[args.length - 1];
          if (args.includes('venv') && venvArg?.includes('venvs')) {
            const binDir =
              process.platform === 'win32' ? join(venvArg, 'Scripts') : join(venvArg, 'bin');
            await mkdir(binDir, { recursive: true });
            const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
            await writeFile(join(binDir, pyName), '#!/bin/sh');
          }
        },
      }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });
    const handle = await uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm'] });
    expect(handle.source).toBe('system-python');
    const venvCall = fakes.spawnCalls.find((c) => c.args.includes('venv'));
    expect(venvCall?.command).toBe(sysPyName);
    expect(venvCall?.args).toEqual(['-m', 'venv', handle.venvRoot]);
    const installCall = fakes.spawnCalls.find((c) => c.args.includes('pip'));
    expect(installCall?.args).toEqual([
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      'mlx-lm',
    ]);
    // The pip-install call goes through the venv's python, not the system one.
    expect(installCall?.command).toBe(handle.pythonPath);
  });

  it('rejects unsafe venv names', async () => {
    const uv = new UvRuntime({ home, bundledUvBin: null, onLog: () => {} });
    await expect(uv.ensureVenv({ name: '../etc', packages: [] })).rejects.toThrow(
      /unsafe venv name/,
    );
    await expect(uv.removeVenv('../etc')).rejects.toThrow(/unsafe venv name/);
  });

  it('serializes concurrent ensureVenv calls for the same name (creates once)', async () => {
    // The install-time warm and the lazy first-chat call can both fire
    // ensureVenv('mlx', …) on a cold machine. Without per-name
    // serialization both miss the manifest fast-path and run
    // createVenv() — which rm -rf's the dir — clobbering each other. The
    // lock makes the second call observe the first's finished venv.
    const fakes = makeFakes({
      exec: (cmd) => {
        if (cmd === 'uv --version') return { stdout: 'uv 0.5.12', stderr: '' };
        if (cmd.includes('python') && cmd.includes('--version')) {
          return { stdout: 'Python 3.11.7', stderr: '' };
        }
        return new Error('not found');
      },
      spawn: (_command, args) => ({
        exitCode: 0,
        afterExit: async () => {
          const venvArg = args.find((a) => a.includes('mlx') && !a.startsWith('--'));
          if (args.includes('venv') && venvArg) {
            const binDir =
              process.platform === 'win32' ? join(venvArg, 'Scripts') : join(venvArg, 'bin');
            await mkdir(binDir, { recursive: true });
            const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
            await writeFile(join(binDir, pyName), '#!/bin/sh\necho Python 3.11.7');
          }
        },
      }),
    });
    const uv = new UvRuntime({
      home,
      bundledUvBin: null,
      exec: fakes.exec,
      spawn: fakes.spawn,
      onLog: () => {},
    });

    const [a, b] = await Promise.all([
      uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] }),
      uv.ensureVenv({ name: 'mlx', packages: ['mlx-lm==0.25.3'] }),
    ]);

    expect(a.venvRoot).toBe(b.venvRoot);
    // Exactly one venv-create spawn — the second call took the fast path.
    const venvCreates = fakes.spawnCalls.filter((c) => c.args.includes('venv'));
    expect(venvCreates).toHaveLength(1);
  });

  it('listVenvs enumerates created venvs', async () => {
    const venvRoot = join(home, 'engines', 'uv', 'venvs', 'mlx');
    await mkdir(venvRoot, { recursive: true });
    await writeFile(
      join(venvRoot, 'uv.json'),
      JSON.stringify({
        version: 1,
        name: 'mlx',
        source: 'system-uv',
        pythonVersion: '3.11.7',
        packages: ['mlx-lm==0.25.3'],
        installedAt: '2026-04-01T00:00:00.000Z',
        installerPath: 'uv',
      }),
      'utf8',
    );
    const uv = new UvRuntime({ home, bundledUvBin: null, onLog: () => {} });
    const venvs = await uv.listVenvs();
    expect(venvs).toHaveLength(1);
    expect(venvs[0]?.name).toBe('mlx');
    expect(venvs[0]?.pythonVersion).toBe('3.11.7');
    expect(venvs[0]?.packages).toEqual(['mlx-lm==0.25.3']);
  });
});

describe('VenvHandle.binPath', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-uv-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolves per-platform console script paths', async () => {
    const venvRoot = join(home, 'engines', 'uv', 'venvs', 'mlx');
    const binDir = process.platform === 'win32' ? join(venvRoot, 'Scripts') : join(venvRoot, 'bin');
    await mkdir(binDir, { recursive: true });
    const pyName = process.platform === 'win32' ? 'python.exe' : 'python';
    await writeFile(join(binDir, pyName), '#!/bin/sh');
    await writeFile(
      join(venvRoot, 'uv.json'),
      JSON.stringify({
        version: 1,
        name: 'mlx',
        source: 'system-uv',
        pythonVersion: '3.11.7',
        packages: [],
        installedAt: '2026-04-01T00:00:00.000Z',
        installerPath: 'uv',
      }),
      'utf8',
    );
    const uv = new UvRuntime({ home, bundledUvBin: null, onLog: () => {} });
    const [handle] = await uv.listVenvs();
    expect(handle).toBeDefined();
    const resolved = handle?.binPath('mlx_lm.server');
    if (process.platform === 'win32') {
      expect(resolved).toBe(join(binDir, 'mlx_lm.server.exe'));
    } else {
      expect(resolved).toBe(join(binDir, 'mlx_lm.server'));
    }
  });
});
