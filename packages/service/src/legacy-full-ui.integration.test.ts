import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const serviceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const daemonEntry = join(serviceDir, 'dist', 'bin', 'gezeld.js');
const bundledUiIndex = join(serviceDir, 'dist', 'ui', 'index.html');

let daemon: ChildProcessWithoutNullStreams | null = null;
let home: string | null = null;

afterEach(async () => {
  if (daemon?.exitCode === null) {
    daemon.kill('SIGTERM');
    await waitForExit(daemon, 10_000);
  }
  daemon = null;
  if (home) await rm(home, { recursive: true, force: true }).catch(() => {});
  home = null;
}, 15_000);

describe('legacy-full packaged UI discovery', () => {
  it('serves the bundled UI without GEZEL_UI_DIR', async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-legacy-full-ui-'));
    // Any established product directory keeps an upgraded system service in
    // legacy-full mode instead of relabeling its data as engine-only.
    await mkdir(join(home, 'projects', 'default'), { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GEZEL_HOME: home,
      GEZEL_PORT: '0',
      GEZEL_SERVICE_ROLE: 'machine-engine',
      GEZEL_SYSTEM_SCOPE: '1',
      GEZEL_MOCK_PROVIDER: '1',
      GEZEL_INSECURE_TRANSPORT: '1',
      GEZEL_DISABLE_BACKGROUND_ENRICH: '1',
    };
    delete env.GEZEL_UI_DIR;

    let stderr = '';
    daemon = spawn(process.execPath, [daemonEntry], {
      cwd: serviceDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    daemon.stderr.setEncoding('utf8');
    daemon.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const port = await waitForPort(home, daemon, () => stderr);
    const baseUrl = `http://127.0.0.1:${port}`;
    const health = await waitForHealth(baseUrl, daemon, () => stderr);
    expect(health.serviceRole).toBe('legacy-full');

    const response = await fetch(`${baseUrl}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toBe(await readFile(bundledUiIndex, 'utf8'));
    expect(html).not.toContain('The web UI bundle was not included with this build.');
  }, 30_000);
});

async function waitForPort(
  serviceHome: string,
  child: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<number> {
  const portPath = join(serviceHome, 'runtime', 'port');
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    assertRunning(child, diagnostics);
    try {
      const port = Number.parseInt((await readFile(portPath, 'utf8')).trim(), 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // The runtime directory is published only after the listener is bound.
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${portPath}\n${diagnostics()}`);
}

async function waitForHealth(
  baseUrl: string,
  child: ChildProcessWithoutNullStreams,
  diagnostics: () => string,
): Promise<{ serviceRole?: string }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    assertRunning(child, diagnostics);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return (await response.json()) as { serviceRole?: string };
    } catch {
      // The port file and listener can become observable a few milliseconds
      // apart, especially on Windows; retry until the bounded deadline.
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${baseUrl}/api/health\n${diagnostics()}`);
}

function assertRunning(child: ChildProcessWithoutNullStreams, diagnostics: () => string): void {
  if (child.exitCode !== null) {
    throw new Error(`gezeld exited early with code ${child.exitCode}\n${diagnostics()}`);
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolveExit) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      resolveExit();
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolveExit();
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
