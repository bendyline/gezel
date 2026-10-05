/**
 * The composed Playwright test for the browser UX suite. Specs import `test` +
 * `expect` from here.
 *
 * What it wires up:
 *  - `daemon` (worker-scoped): boots an in-process gezel service in web-UI mode
 *    on an ephemeral port with a fresh temp home, mock provider, plain HTTP, and
 *    seeds a deterministic world. Mirrors packages/service/src/web-ui-mode.test.ts.
 *    The single-instance lock is per-home, so per-worker temp homes parallelize.
 *  - `baseURL` override: every `page.goto('/')` targets this worker's daemon.
 *  - `context` override: an init script (runs before the SPA) pre-seeds the auth
 *    token into localStorage (api.ts reads it synchronously at module load),
 *    freezes the clock, and kills animations/caret for stable screenshots.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GezelClient } from '@bendyline/gezel-client';
import {
  type RunningService,
  type UnexpectedHttpErrorEvent,
  startService,
} from '@bendyline/gezel-service';
import { type CDPSession, type Page, test as base, expect } from '@playwright/test';
import { FIXED_CLOCK_MS } from '../helpers/determinism.js';
import { type SeedWorld, seed } from '../helpers/seed.js';

const _dirname = dirname(fileURLToPath(import.meta.url));
// packages/app/e2e-web/fixtures -> packages/ui/dist (the browser UI bundle the daemon serves)
const UI_DIR = resolve(_dirname, '../../../ui/dist');

export interface DaemonInfo {
  baseURL: string;
  token: string;
  home: string;
  world: SeedWorld | null;
  unexpectedHttpErrors: UnexpectedHttpErrorEvent[];
}

interface WorkerFixtures {
  daemonGroup: string;
  daemon: DaemonInfo;
}
interface TestFixtures {
  world: SeedWorld | null;
  browserDiagnostics: undefined;
  daemonErrors: undefined;
}

/**
 * Keep the diagnostics buffer bounded so a console-spamming page can't
 * balloon a test attachment; 800 lines is far more than any boot
 * failure needs.
 */
const MAX_DIAGNOSTIC_LINES = 800;

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // A distinct group gives a mutating spec its own worker and seeded daemon,
  // so it cannot change later specs' conversations or task-runner state.
  daemonGroup: ['gallery', { scope: 'worker', option: true }],
  daemon: [
    async ({ daemonGroup }, use, workerInfo) => {
      // Set before startService reads them. Mock provider implies skip-bootstrap
      // (no model downloads); insecure transport serves plain HTTP a browser can
      // connect to; file secrets avoids OS-keychain prompts in CI.
      process.env.GEZEL_MOCK_PROVIDER = '1';
      process.env.GEZEL_INSECURE_TRANSPORT = '1';
      process.env.GEZEL_SKIP_SYSTEM_BOOTSTRAP = '1';
      process.env.GEZEL_SECRETS_BACKEND = 'file';
      // The fixture seeds the one memory the gallery needs explicitly. Keep
      // post-chat extraction off so MockProvider cannot persist its echoed
      // extraction prompt or start embedding work after a test has begun.
      process.env.GEZEL_DISABLE_MEMORY_EXTRACTION = '1';
      process.env.GEZEL_DISABLE_EMBEDDINGS = '1';

      const home = await mkdtemp(
        join(tmpdir(), `gezel-web-e2e-${daemonGroup}-w${workerInfo.workerIndex}-`),
      );
      // Keep scheduled/background work from changing the seeded world mid-capture.
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          aiEngagementMode: 'reactive',
          nightShift: { enabled: false },
        }),
      );
      // Some subsystems read GEZEL_HOME from env rather than the passed option;
      // keep them aligned with the per-worker temp home.
      process.env.GEZEL_HOME = home;
      // Keep an installed machine broker and its shared roster out of this
      // supposedly fresh world. Without both overrides, a local smoke run can
      // mount real machine-shared projects and start unrelated background work.
      process.env.GEZEL_DISABLE_MACHINE_ENGINE = '1';
      process.env.GEZEL_MACHINE_SHARED_HOME = join(home, 'machine-shared');
      const unexpectedHttpErrors: UnexpectedHttpErrorEvent[] = [];
      let svc: RunningService | undefined;
      try {
        svc = await startService({
          home,
          webUi: true,
          uiDir: UI_DIR,
          onUnexpectedHttpError: (event) => unexpectedHttpErrors.push(event),
        });
        if (svc.cert !== null) {
          throw new Error('expected plain HTTP (cert === null) under GEZEL_INSECURE_TRANSPORT=1');
        }
        const token = svc.webUiToken;
        if (!token) throw new Error('expected a per-launch web-UI token');
        const baseURL = `http://127.0.0.1:${svc.port}`;
        await waitForHealth(baseURL);

        // The seeded world represents an already configured install. Copilot's
        // availability probe checks the host SDK even when chat uses the mock,
        // which can send the browser into first-run setup mid-test. Use the
        // mocked OpenAI provider with an inert credential instead.
        const client = new GezelClient({ baseUrl: baseURL, token });
        await client.updateConfig({ provider: 'openai', openaiApiKey: 'sk-e2e-openai' });

        let world: SeedWorld | null = null;
        if (process.env.GEZEL_SEED !== '0') {
          world = await seed(client, svc.context.store);
        }
        if (unexpectedHttpErrors.length > 0) {
          throw new Error(formatUnexpectedHttpErrors('while seeding', unexpectedHttpErrors));
        }

        await use({ baseURL, token, home, world, unexpectedHttpErrors });
      } finally {
        // The in-process service loads native modules (llama-cpp probe, etc.);
        // shutting them down can be noisy at process exit. Never let a teardown
        // hiccup hide the test result.
        await svc?.stop().catch(() => {});
        await rm(home, { recursive: true, force: true }).catch(() => {});
      }
    },
    { scope: 'worker' },
  ],

  // Point every navigation at this worker's daemon.
  baseURL: async ({ daemon }, use) => {
    await use(daemon.baseURL);
  },

  // Pre-seed auth + determinism into every context before the first navigation.
  context: async ({ context, daemon }, use) => {
    await context.addInitScript(
      (args: { fixedMs: number; token: string }) => {
        // Freeze the clock so the greeting band + relative timestamps are stable.
        const RealDate = Date;
        class FrozenDate extends RealDate {
          constructor(...a: unknown[]) {
            if (a.length === 0) super(args.fixedMs);
            else super(...(a as ConstructorParameters<typeof Date>));
          }
          static now() {
            return args.fixedMs;
          }
        }
        (FrozenDate as unknown as { UTC: unknown }).UTC = RealDate.UTC;
        (FrozenDate as unknown as { parse: unknown }).parse = RealDate.parse;
        (window as unknown as { Date: unknown }).Date = FrozenDate;

        // Seed Math.random (mulberry32) so render-time randomness — e.g. the
        // composer's rotating placeholder — is stable across runs. Poppetje
        // avatars seed from the gezel key, not Math.random, so this is safe.
        let s = 0x9e3779b9;
        Math.random = () => {
          s |= 0;
          s = (s + 0x6d2b79f5) | 0;
          let t = Math.imul(s ^ (s >>> 15), 1 | s);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };

        // api.ts resolves the token from localStorage at module load.
        try {
          window.localStorage.setItem('gezel:token', args.token);
        } catch {
          /* storage disabled — fall through */
        }

        // Kill transitions/animations/caret for byte-stable captures. Force
        // zero-width scrollbars as well: macOS can expose either overlay or
        // classic scrollbars depending on the host preference, and a classic
        // scrollbar changes the width of scrollbar-gutter: stable layouts.
        // The content remains scrollable; only the platform-owned chrome is
        // suppressed in browser tests.
        const css =
          '*{transition:none !important;animation:none !important;caret-color:transparent !important;scroll-behavior:auto !important;scrollbar-width:none !important}' +
          '*::-webkit-scrollbar{width:0 !important;height:0 !important}';
        const inject = () => {
          const style = document.createElement('style');
          style.setAttribute('data-e2e-determinism', '');
          style.textContent = css;
          (document.head || document.documentElement).appendChild(style);
        };
        if (document.head) inject();
        else document.addEventListener('DOMContentLoaded', inject);
      },
      { fixedMs: FIXED_CLOCK_MS, token: daemon.token },
    );
    await use(context);
  },

  world: async ({ daemon }, use) => {
    await use(daemon.world);
  },

  // The browser can stay visually healthy while an API request throws in the
  // daemon. Observe the service's HTTP error boundary directly so every
  // unexpected 5xx fails the smoke test that triggered it.
  daemonErrors: [
    async ({ daemon }, use, testInfo) => {
      const start = daemon.unexpectedHttpErrors.length;
      await use(undefined);
      const errors = daemon.unexpectedHttpErrors.slice(start);
      if (errors.length === 0) return;

      const detail = formatUnexpectedHttpErrors('during the test', errors);
      const outPath = testInfo.outputPath('daemon-errors.txt');
      await writeFile(outPath, `${detail}\n`, 'utf8');
      await testInfo.attach('daemon-errors', {
        path: outPath,
        contentType: 'text/plain',
      });
      throw new Error(detail);
    },
    { auto: true },
  ],

  // Capture browser console output, uncaught page errors, and failed
  // network requests for every test, and attach them when the test
  // fails. Motivated by the flake class where three specs
  // timed out on a completely blank page at goto('/') — the failure
  // screenshot showed only the body background and nothing recorded
  // WHY the SPA never mounted (a pageerror or a failed bundle fetch
  // would have named the cause). Auto so every spec gets it without
  // opting in.
  browserDiagnostics: [
    async ({ page, daemon }, use, testInfo) => {
      const lines: string[] = [];
      const push = (line: string) => {
        if (lines.length < MAX_DIAGNOSTIC_LINES) lines.push(line);
        else if (lines.length === MAX_DIAGNOSTIC_LINES)
          lines.push(`… truncated at ${MAX_DIAGNOSTIC_LINES} lines`);
      };
      page.on('console', (msg) => {
        push(`[console.${msg.type()}] ${msg.text()}`);
      });
      page.on('pageerror', (err) => {
        push(`[pageerror] ${err.stack ?? err.message}`);
      });
      page.on('requestfailed', (req) => {
        push(
          `[requestfailed] ${req.method()} ${req.url()} — ${req.failure()?.errorText ?? 'unknown'}`,
        );
      });
      // Enabled before the page runs: a renderer already spinning in JS never
      // services Debugger.enable, but an enabled debugger's pause interrupts it.
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Debugger.enable');
      await use(undefined);
      if (testInfo.status !== testInfo.expectedStatus) {
        // A blank page whose goto never reaches `load` recorded nothing above
        // (2026-10-02). Its trace showed every request after the bundle as
        // pending, which fits two causes: a renderer stuck in JS (Chromium
        // reports responses from the renderer) or daemon requests that never
        // answer, holding Chrome's six connections per origin so the lazy
        // chunks behind `load` never go out. Ask each side directly.
        for (const line of await probeRenderer(page, cdp)) push(line);
        for (const line of await probeDaemon(daemon)) push(line);
      }
      if (testInfo.status !== testInfo.expectedStatus && lines.length > 0) {
        // Attach by path (not body) so the text survives in
        // test-results/<test>/ for post-hoc inspection — body-only
        // attachments live solely in the reporter stream and are gone
        // once the terminal scrolls.
        const outPath = testInfo.outputPath('browser-diagnostics.txt');
        await writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');
        await testInfo.attach('browser-diagnostics', {
          path: outPath,
          contentType: 'text/plain',
        });
      }
    },
    { auto: true },
  ],
});

export { expect };
export type { Page };

async function waitForHealth(baseURL: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${baseURL}/api/health`);
      if (res.ok) return;
    } catch {
      /* daemon not bound yet */
    }
    if (Date.now() > deadline)
      throw new Error(`daemon /api/health not ready within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const PROBE_TIMEOUT_MS = 3_000;
const STUCK_REQUEST_MS = 1_000;

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), PROBE_TIMEOUT_MS)),
  ]);
}

async function probeRenderer(page: Page, cdp: CDPSession): Promise<string[]> {
  if (page.isClosed()) return ['[renderer] page already closed'];
  const state = await withTimeout(
    page.evaluate(() => ({
      readyState: document.readyState,
      resources: performance.getEntriesByType('resource').length,
    })),
  );
  if (state) {
    return [
      `[renderer] responsive: readyState=${state.readyState}, ${state.resources} resource(s) finished`,
    ];
  }
  // The paused stack names the loop; no pause means it is stuck outside JS.
  const paused = new Promise<string[]>((resolvePaused) => {
    cdp.once('Debugger.paused', (event) => {
      resolvePaused(
        event.callFrames
          .slice(0, 15)
          .map(
            (f) =>
              `[renderer]   at ${f.functionName || '<anonymous>'} (${f.url}:${f.location.lineNumber + 1}:${(f.location.columnNumber ?? 0) + 1})`,
          ),
      );
    });
  });
  void cdp.send('Debugger.pause').catch(() => {});
  const frames = await withTimeout(paused);
  if (!frames) {
    return [`[renderer] did not answer evaluate or a debugger pause within ${PROBE_TIMEOUT_MS}ms`];
  }
  return ['[renderer] unresponsive; main thread paused in:', ...frames];
}

async function probeDaemon(daemon: DaemonInfo): Promise<string[]> {
  const client = new GezelClient({ baseUrl: daemon.baseURL, token: daemon.token });
  const perf = await withTimeout(client.getPerfSnapshot());
  if (!perf) return [`[daemon] /api/system/perf did not answer within ${PROBE_TIMEOUT_MS}ms`];
  const stuck = perf.inflight.filter((work) => work.durationMs >= STUCK_REQUEST_MS);
  return [
    `[daemon] responsive; ${stuck.length} item(s) in flight for ${STUCK_REQUEST_MS}ms or more`,
    ...stuck.map((work) => `[daemon]   ${work.label} ${Math.round(work.durationMs)}ms`),
  ];
}

function formatUnexpectedHttpErrors(phase: string, errors: UnexpectedHttpErrorEvent[]): string {
  return [
    `Unexpected daemon HTTP error${errors.length === 1 ? '' : 's'} ${phase}:`,
    ...errors.map(
      (event) =>
        `- ${event.kind} ${event.status} ${event.method} ${event.path} (${event.requestId}): ${event.detail}`,
    ),
  ].join('\n');
}
