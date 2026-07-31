import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NET_BLOCK_PRELOAD,
  type SandboxRunResult,
  canApplyLinuxSystemdSandbox,
  isSilentMacSandboxStartupFailure,
  runInSandbox,
  selectDenyNetBoundary,
} from './runner.js';

let scratch = '';
let preloadPath = '';

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'gezel-sandbox-network-test-'));
  preloadPath = join(scratch, 'net-block.mjs');
  await writeFile(preloadPath, NET_BLOCK_PRELOAD, 'utf8');
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('denyNet boundary selection', () => {
  it('fails closed without an OS or runtime boundary', () => {
    expect(
      selectDenyNetBoundary({
        platform: 'win32',
        macSandboxAvailable: false,
      }),
    ).toBe('unavailable');
    expect(
      selectDenyNetBoundary({
        platform: 'linux',
        macSandboxAvailable: false,
        linuxSystemdSandboxAvailable: false,
      }),
    ).toBe('unavailable');
  });

  it('accepts only an available macOS Seatbelt boundary', () => {
    expect(
      selectDenyNetBoundary({
        platform: 'darwin',
        macSandboxAvailable: true,
      }),
    ).toBe('macos-seatbelt');
    expect(
      selectDenyNetBoundary({
        platform: 'linux',
        macSandboxAvailable: true,
        linuxSystemdSandboxAvailable: false,
      }),
    ).toBe('unavailable');
  });

  it('accepts a probed Linux systemd address-family boundary', () => {
    expect(
      selectDenyNetBoundary({
        platform: 'linux',
        macSandboxAvailable: false,
        linuxSystemdSandboxAvailable: true,
      }),
    ).toBe('linux-systemd');
  });

  it('does not start user code when this runtime has no strong boundary', async () => {
    if (process.platform === 'darwin') return;
    if (process.platform === 'linux' && (await canApplyLinuxSystemdSandbox())) return;

    const marker = join(scratch, 'should-not-exist.txt');
    const entry = join(scratch, 'untrusted.mjs');
    await writeFile(
      entry,
      `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(marker)}, 'ran');\n`,
      'utf8',
    );

    const result = await runInSandbox({
      entry,
      cwd: scratch,
      input: '',
      denyNet: true,
    });

    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain('denyNet requires an enforceable OS network boundary');
    await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs provenance-trusted work without the OS boundary, JS neutralizer still armed', async () => {
    if (process.platform === 'darwin') return;
    if (process.platform === 'linux' && (await canApplyLinuxSystemdSandbox())) return;

    const marker = join(scratch, 'trusted-ran.txt');
    const entry = join(scratch, 'trusted.mjs');
    // The trusted lane must EXECUTE the child (unlike the fail-closed case
    // above) while the defense-in-depth preload keeps raw network APIs
    // neutered — record what fetch() actually does to prove both at once.
    await writeFile(
      entry,
      `import { writeFile } from 'node:fs/promises';
let fetchError = 'fetch-was-not-blocked';
try {
  await fetch('http://127.0.0.1:9/');
} catch (err) {
  fetchError = String(err && err.message);
}
await writeFile(${JSON.stringify(marker)}, fetchError);
`,
      'utf8',
    );

    const result = await runInSandbox({
      entry,
      cwd: scratch,
      input: '',
      denyNet: true,
      allowMissingNetBoundary: true,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const recorded = await readFile(marker, 'utf8');
    expect(recorded).toContain('network access is disabled in this sandbox');
  });

  it('executes without AF_INET access when the Linux systemd boundary is available', async () => {
    if (process.platform !== 'linux' || !(await canApplyLinuxSystemdSandbox())) return;

    const marker = join(scratch, 'linux-boundary-ran.txt');
    const entry = join(scratch, 'linux-boundary.mjs');
    await writeFile(
      entry,
      `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(marker)}, JSON.stringify(process.env));\n`,
      'utf8',
    );

    const priorSecret = process.env.GEZEL_TEST_SHOULD_NOT_LEAK;
    process.env.GEZEL_TEST_SHOULD_NOT_LEAK = 'parent-secret';

    let result: SandboxRunResult;
    try {
      result = await runInSandbox({
        entry,
        cwd: scratch,
        input: '',
        denyNet: true,
        extraEnv: { GEZEL_TEST_VISIBLE: 'yes' },
      });
    } finally {
      if (priorSecret === undefined) delete process.env.GEZEL_TEST_SHOULD_NOT_LEAK;
      else process.env.GEZEL_TEST_SHOULD_NOT_LEAK = priorSecret;
    }

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    await expect(stat(marker)).resolves.toBeTruthy();
    const childEnv = JSON.parse(await readFile(marker, 'utf8')) as Record<string, string>;
    expect(childEnv.GEZEL_SANDBOX).toBe('1');
    expect(childEnv.GEZEL_TEST_VISIBLE).toBe('yes');
    expect(childEnv.GEZEL_TEST_SHOULD_NOT_LEAK).toBeUndefined();
    expect(childEnv.WINDOWPATH).toBeUndefined();
  });
});

describe('trusted macOS Seatbelt startup fallback classifier', () => {
  it('recognizes only the silent pre-execution exit shape on macOS', () => {
    const silent: SandboxRunResult = {
      exitCode: 1,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
    };
    expect(isSilentMacSandboxStartupFailure(silent, 'darwin')).toBe(true);
    expect(isSilentMacSandboxStartupFailure(silent, 'linux')).toBe(false);
    expect(
      isSilentMacSandboxStartupFailure({ ...silent, stderr: 'script failed\n' }, 'darwin'),
    ).toBe(false);
    expect(isSilentMacSandboxStartupFailure({ ...silent, timedOut: true }, 'darwin')).toBe(false);
  });
});

describe('denyNet JS defense-in-depth preload', () => {
  it('blocks callback, promise, Resolver, and named-export DNS APIs', async () => {
    const code = String.raw`
      import dns, { lookup as namedLookup, resolve4 as namedResolve4 } from 'node:dns';
      import dnsPromises, {
        lookup as namedPromiseLookup,
        resolve4 as namedPromiseResolve4,
      } from 'node:dns/promises';

      const checks = [
        ['dns.lookup', () => dns.lookup('127.0.0.1', () => {})],
        ['named dns.lookup', () => namedLookup('127.0.0.1', () => {})],
        ['dns.resolve4', () => dns.resolve4('example.invalid', () => {})],
        ['named dns.resolve4', () => namedResolve4('example.invalid', () => {})],
        [
          'dns.Resolver.resolve4',
          () => new dns.Resolver().resolve4('example.invalid', () => {}),
        ],
        ['dns/promises.lookup', () => dnsPromises.lookup('127.0.0.1')],
        ['named dns/promises.lookup', () => namedPromiseLookup('127.0.0.1')],
        ['dns/promises.resolve4', () => dnsPromises.resolve4('example.invalid')],
        ['named dns/promises.resolve4', () => namedPromiseResolve4('example.invalid')],
        [
          'dns/promises.Resolver.resolve4',
          () => new dnsPromises.Resolver().resolve4('example.invalid'),
        ],
      ];

      let blocked = 0;
      for (const [name, invoke] of checks) {
        try {
          invoke();
          console.error('not blocked: ' + name);
        } catch (error) {
          if (!String(error).includes('network access is disabled')) {
            console.error('wrong error for ' + name + ': ' + String(error));
            continue;
          }
          blocked += 1;
        }
      }
      console.log('blocked=' + blocked);
      process.exitCode = blocked === checks.length ? 0 : 2;
    `;

    const result = await runNode(process.execPath, [
      `--import=${pathToFileURL(preloadPath).href}`,
      '--input-type=module',
      '-e',
      code,
    ]);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('blocked=10');
  });

  it('preserves the bidirectional fd-3 RPC pipe', async () => {
    const code = String.raw`
      import { writeSync } from 'node:fs';
      import net from 'node:net';
      writeSync(3, Buffer.from('ping\n'));
      const rpc = new net.Socket({ fd: 3, readable: true, writable: true });
      rpc.setEncoding('utf8');
      rpc.once('data', (data) => {
        console.log('rpc=' + data.trim());
        rpc.end();
      });
    `;

    const result = await runNode(
      process.execPath,
      [`--import=${pathToFileURL(preloadPath).href}`, '--input-type=module', '-e', code],
      (child) => {
        const rpc = child.stdio[3] as (NodeJS.ReadableStream & NodeJS.WritableStream) | null;
        rpc?.once('data', (chunk: Buffer) => {
          expect(chunk.toString('utf8')).toBe('ping\n');
          rpc.end('pong\n');
        });
      },
    );

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    expect(result.stdout).toContain('rpc=pong');
  });
});

async function runNode(
  command: string,
  args: string[],
  onSpawn?: (child: ChildProcess) => void,
): Promise<SandboxRunResult> {
  return await new Promise<SandboxRunResult>((resolve) => {
    const child = spawn(command, args, {
      stdio: onSpawn ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    onSpawn?.(child);

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 2000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        signal,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}
