import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runPageCheck } from './runner.js';

/** Minimal ChildProcess stand-in for the spawn seam. */
function fakeChild(behavior: {
  stdout?: string;
  exitCode?: number;
  neverCloses?: boolean;
  spawnError?: string;
}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
    killed: boolean;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  queueMicrotask(() => {
    if (behavior.spawnError) {
      child.emit('error', new Error(behavior.spawnError));
      return;
    }
    if (behavior.stdout) child.stdout.emit('data', Buffer.from(behavior.stdout));
    if (!behavior.neverCloses) child.emit('close', behavior.exitCode ?? 0);
  });
  return child;
}

const BASE = {
  installPath: '/fake/install',
  browsersPath: '/fake/browsers',
  url: 'http://127.0.0.1:1/x.html',
};

describe('runPageCheck (spawn seam)', () => {
  it('parses the sentinel line and caps error output', async () => {
    const errors = Array.from({ length: 9 }, (_, i) => `pageerror: boom ${i} ${'x'.repeat(400)}`);
    const outcome = await runPageCheck({
      ...BASE,
      spawnImpl: (() =>
        fakeChild({
          stdout: `pnpm noise\nGEZEL_PAGE_CHECK_RESULT:${JSON.stringify({ ok: false, errors })}\n`,
        })) as never,
    });
    expect(outcome.ran).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors).toHaveLength(5);
    expect(outcome.errors?.[0]?.length).toBeLessThanOrEqual(301);
    expect(outcome.errors?.[0]?.endsWith('…')).toBe(true);
  });

  it('reports a clean page', async () => {
    const outcome = await runPageCheck({
      ...BASE,
      spawnImpl: (() =>
        fakeChild({
          stdout: `GEZEL_PAGE_CHECK_RESULT:${JSON.stringify({ ok: true, errors: [] })}\n`,
        })) as never,
    });
    expect(outcome).toEqual({ ran: true, ok: true, errors: [] });
  });

  it('treats a sentinel-less exit as no-signal, never a pass', async () => {
    const outcome = await runPageCheck({
      ...BASE,
      spawnImpl: (() => fakeChild({ stdout: 'ERR_PNPM_NOTHING_TO_RUN\n', exitCode: 1 })) as never,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.ok).toBeUndefined();
  });

  it('kills and reports no-signal on timeout', async () => {
    const outcome = await runPageCheck({
      ...BASE,
      timeoutMs: 6_000,
      spawnImpl: (() => fakeChild({ neverCloses: true })) as never,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toBe('timeout');
  }, 10_000);

  it('reports spawn errors as no-signal', async () => {
    const outcome = await runPageCheck({
      ...BASE,
      spawnImpl: (() => fakeChild({ spawnError: 'ENOENT pnpm' })) as never,
    });
    expect(outcome.ran).toBe(false);
    expect(outcome.reason).toContain('ENOENT');
  });
});

// ── Real-browser integration (gated) ──
//
// Reproduces the wild-caught incident end-to-end: a canvas page whose
// palette is 3-digit hex + a "+ '33'" alpha suffix — parses clean,
// throws `addColorStop('#0ff33')` on the first animation frame. The
// runner must catch it. Uses the repo's own playwright install
// (packages/app) and the developer/CI ms-playwright cache; skips
// wherever either is absent.
const APP_DIR = fileURLToPath(new URL('../../../app', import.meta.url));
const BROWSER_CACHES = [
  join(homedir(), 'Library/Caches/ms-playwright'),
  join(homedir(), '.cache/ms-playwright'),
];
const browsersPath = BROWSER_CACHES.find((p) => existsSync(p));
const canRunReal = existsSync(join(APP_DIR, 'node_modules')) && browsersPath !== undefined;

const BROKEN_PAGE = `<!DOCTYPE html>
<html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById('c').getContext('2d');
const color = '#0ff';
function frame() {
  const g = ctx.createLinearGradient(0, 0, 10, 10);
  g.addColorStop(0, color + '33');
  requestAnimationFrame(frame);
}
frame();
</script></body></html>`;

describe.skipIf(!canRunReal)('runPageCheck (real chromium)', () => {
  it('catches the addColorStop dead-frame incident', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(BROKEN_PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const outcome = await runPageCheck({
        installPath: APP_DIR,
        browsersPath: browsersPath!,
        url: `http://127.0.0.1:${port}/index.html`,
        settleMs: 700,
        timeoutMs: 45_000,
      });
      expect(outcome.ran).toBe(true);
      expect(outcome.ok).toBe(false);
      expect(outcome.errors?.join('\n')).toContain('addColorStop');
    } finally {
      server.close();
    }
  }, 60_000);
});
