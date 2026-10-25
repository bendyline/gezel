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
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { bootTraceEnabled, startBootTrace } from './chrome-trace.js';

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
      // The seeded world is an established install: no first-use hold on its
      // background indexing, no first-use quiet on its night reports.
      process.env.GEZEL_DISABLE_FIRST_USE_GRACE = '1';

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
    async ({ page, daemon, browser, browserName }, use, testInfo) => {
      const hangMarker = join(
        testInfo.project.outputDir,
        '.renderer-hangs',
        `${testInfo.testId}-${testInfo.repeatEachIndex}`,
      );
      if (
        testInfo.retry > 0 &&
        !(await stat(hangMarker).then(
          () => true,
          () => false,
        ))
      ) {
        throw new Error(
          'Not retried: retries are only for the known renderer hang, and the previous attempt failed for another reason. Read that attempt.',
        );
      }
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
      page.on('crash', () => push('[renderer] crashed'));
      // Enabled before the page runs: a renderer already spinning in JS never
      // services Debugger.enable, but an enabled debugger's pause interrupts it.
      const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
      // A page already paused answers neither evaluate nor a second pause, which
      // the probe below cannot tell from a blocked thread. An enabled debugger
      // also pauses near the heap limit (reason OOM) instead of crashing.
      let probing = false;
      let pausedBeforeProbe = false;
      cdp?.on('Debugger.paused', (event) => {
        if (probing) return;
        pausedBeforeProbe = true;
        push(`[debugger] page paused (reason ${event.reason}) before the probe:`);
        for (const frame of event.callFrames.slice(0, 15))
          push(`[debugger]   ${formatFrame(frame)}`);
      });
      await cdp?.send('Debugger.enable');
      const started = cdp && bootTraceEnabled() ? await startBootTrace(browser, page) : null;
      if (typeof started === 'string') push(started);
      const bootTrace = typeof started === 'string' ? null : started;
      await use(undefined);
      try {
        if (testInfo.status !== testInfo.expectedStatus) {
          // A blank page whose goto never reaches `load` recorded nothing above
          // (2026-10-02). Its trace showed every request after the bundle as
          // pending, which fits two causes: a renderer stuck in JS (Chromium
          // reports responses from the renderer) or daemon requests that never
          // answer, holding Chrome's six connections per origin so the lazy
          // chunks behind `load` never go out. Ask each side directly.
          probing = true;
          const renderer = cdp ? await probeRenderer(page, cdp) : [];
          const daemonLines = await probeDaemon(daemon);
          for (const line of [...renderer, ...daemonLines]) push(line);
          if (!pausedBeforeProbe && isRendererHang(renderer, daemonLines)) {
            await mkdir(dirname(hangMarker), { recursive: true });
            await writeFile(hangMarker, `${testInfo.title}\n`, 'utf8');
            testInfo.annotations.push({
              type: 'renderer-hang',
              description: "Chromium's renderer blocked before the page loaded; retried once",
            });
            push('[retry] the known renderer hang; Playwright retries this test once');
            const stacks = await nativeStacks();
            if (stacks) {
              const stacksPath = testInfo.outputPath('native-stacks.txt');
              await writeFile(stacksPath, stacks, 'utf8');
              await testInfo.attach('native-stacks', {
                path: stacksPath,
                contentType: 'text/plain',
              });
            }
            if (bootTrace) {
              const tracePath = testInfo.outputPath('chrome-trace.json.gz');
              const { kept, lines: summary } = await bootTrace.save(tracePath);
              for (const line of summary) push(line);
              if (kept) {
                await testInfo.attach('chrome-trace', {
                  path: tracePath,
                  contentType: 'application/gzip',
                });
              }
            }
          }
        }
      } finally {
        await bootTrace?.discard();
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
  // Six CI hangs through 2026-10-23 stopped at the Home chunk's import() with
  // an idle daemon and a page that answered nothing. Sample processes before
  // the pause below, which would stop a spinning loop and hide it.
  const processes = await probeProcesses(page);
  // The paused stack names the loop; no pause means it is stuck outside JS,
  // unless a `[debugger] page paused` line shows it was already paused.
  const paused = new Promise<string[]>((resolvePaused) => {
    cdp.once('Debugger.paused', (event) => {
      resolvePaused(event.callFrames.slice(0, 15).map((f) => `[renderer]   ${formatFrame(f)}`));
    });
  });
  void cdp.send('Debugger.pause').catch(() => {});
  const frames = await withTimeout(paused);
  if (!frames) {
    return [
      `[renderer] did not answer evaluate or a debugger pause within ${PROBE_TIMEOUT_MS}ms`,
      ...processes,
    ];
  }
  return ['[renderer] unresponsive; main thread paused in:', ...frames, ...processes];
}

function formatFrame(frame: {
  functionName: string;
  url: string;
  location: { lineNumber: number; columnNumber?: number };
}): string {
  const { lineNumber, columnNumber } = frame.location;
  return `at ${frame.functionName || '<anonymous>'} (${frame.url}:${lineNumber + 1}:${(columnNumber ?? 0) + 1})`;
}

const CPU_SAMPLE_MS = 1_000;
const MAX_RENDERERS = 3;
// A renderer runs about 20 threads. List them all: the stuck one can be idle on
// CPU, and the I/O thread that wakes the main thread showed nothing when only
// busy threads were listed (2026-10-23).
const MAX_THREADS = 40;
// /proc counts CPU in clock ticks, 100 per second on Linux.
const MS_PER_TICK = 10;

interface ThreadSample {
  tid: number;
  name: string;
  state: string;
  ticks: number;
  wchan: string;
}

interface RendererThreads {
  at: number;
  renderers: Map<number, ThreadSample[]>;
}

/**
 * A page that answers nothing fits three causes with different fixes: the
 * browser process is hung (CDP goes silent), the page's main thread spins (its
 * CPU climbs), or it is blocked on a lock or IPC (its CPU stays flat). Sample
 * the browser's view and, on Linux, the renderer's threads over one second.
 */
async function probeProcesses(page: Page): Promise<string[]> {
  const browser = page.context().browser();
  const session = browser ? await withTimeout(browser.newBrowserCDPSession()) : null;
  const readCpu = async () => {
    if (!session) return null;
    const info = await withTimeout(session.send('SystemInfo.getProcessInfo'));
    return info?.processInfo ?? null;
  };
  try {
    const cpuBefore = await readCpu();
    const pids = await rendererPids(cpuBefore);
    const threadsBefore = await readRendererThreads(pids);
    await new Promise((resolveSample) => setTimeout(resolveSample, CPU_SAMPLE_MS));
    const [cpuAfter, threadsAfter] = await Promise.all([readCpu(), readRendererThreads(pids)]);
    return [
      formatBrowserCpu(session !== null, cpuBefore, cpuAfter),
      ...formatRendererThreads(threadsBefore, threadsAfter),
    ];
  } finally {
    await session?.detach().catch(() => {});
  }
}

type ProcessCpu = { type: string; id: number; cpuTime: number };

function formatBrowserCpu(
  opened: boolean,
  before: ProcessCpu[] | null,
  after: ProcessCpu[] | null,
): string {
  if (!opened) {
    return `[browser] did not open a CDP session within ${PROBE_TIMEOUT_MS}ms; the browser process is not answering`;
  }
  if (!before || !after) {
    return `[browser] SystemInfo.getProcessInfo did not answer within ${PROBE_TIMEOUT_MS}ms; the browser process is not answering`;
  }
  const start = new Map(before.map((p) => [`${p.type}:${p.id}`, p.cpuTime]));
  const busy = after
    .map((p) => ({
      label: `${p.type} ${p.id}`,
      ms: Math.round((p.cpuTime - (start.get(`${p.type}:${p.id}`) ?? p.cpuTime)) * 1000),
    }))
    .sort((a, b) => b.ms - a.ms)
    .map((p) => `${p.label} ${p.ms}ms`);
  return `[browser] responsive; CPU over ${CPU_SAMPLE_MS}ms: ${busy.join(', ')}`;
}

async function readRendererThreads(pids: number[]): Promise<RendererThreads | null> {
  if (process.platform !== 'linux') return null;
  try {
    const renderers = new Map<number, ThreadSample[]>();
    for (const pid of pids) {
      const threads: ThreadSample[] = [];
      for (const tid of await readdir(`/proc/${pid}/task`).catch(() => [])) {
        const stat = await readFile(`/proc/${pid}/task/${tid}/stat`, 'utf8').catch(() => null);
        const parsed = stat ? parseStat(stat) : null;
        if (!parsed) continue;
        const wchan = (
          await readFile(`/proc/${pid}/task/${tid}/wchan`, 'utf8').catch(() => '')
        ).trim();
        threads.push({
          tid: Number(tid),
          name: parsed.name,
          state: parsed.state,
          ticks: parsed.ticks,
          wchan: wchan === '0' ? '' : wchan,
        });
      }
      renderers.set(pid, threads);
    }
    return { at: performance.now(), renderers };
  } catch {
    return null;
  }
}

/**
 * The browser's renderers, newest first: the stuck page's renderer started after
 * any spare one. The browser names them; walking this worker's process tree
 * covers a browser that did not answer.
 */
async function rendererPids(processes: ProcessCpu[] | null): Promise<number[]> {
  if (process.platform !== 'linux') return [];
  const named: number[] = [];
  for (const { type, id } of processes ?? []) {
    if (type === 'renderer' && (await isRenderer(id))) named.push(id);
  }
  const pids = named.length > 0 ? named : await descendantRenderers();
  return pids.sort((a, b) => b - a).slice(0, MAX_RENDERERS);
}

/**
 * A zygote-forked renderer rewrites its title into one space-separated string,
 * so `--type=renderer` is never a NUL-separated argument of its own. Matching
 * it as one found no renderer on the first CI hang (2026-10-23).
 */
async function isRenderer(pid: number): Promise<boolean> {
  const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
  return cmdline.includes('--type=renderer');
}

/**
 * This worker's own renderers: each worker launches its own browser, so they
 * descend from this process, and `--type=renderer` excludes the daemon's children.
 */
async function descendantRenderers(): Promise<number[]> {
  const parents = new Map<number, number>();
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => null);
    const parsed = stat ? parseStat(stat) : null;
    if (parsed) parents.set(Number(entry), parsed.ppid);
  }
  const isDescendant = (pid: number) => {
    for (let at = parents.get(pid); at !== undefined && at > 1; at = parents.get(at)) {
      if (at === process.pid) return true;
    }
    return false;
  };
  const pids: number[] = [];
  for (const pid of parents.keys()) {
    if (isDescendant(pid) && (await isRenderer(pid))) pids.push(pid);
  }
  return pids;
}

/**
 * Every thread's native stack in the hung renderer and its browser process, for
 * a local Linux repro with gdb installed (GEZEL_E2E_NATIVE_STACKS=1). Off in CI.
 */
async function nativeStacks(): Promise<string | null> {
  if (process.platform !== 'linux' || !process.env.GEZEL_E2E_NATIVE_STACKS) return null;
  const [renderer] = await rendererPids(null);
  if (!renderer) return 'no renderer process to attach to\n';
  // The browser is the nearest ancestor without a --type (the zygote has one).
  let browser = renderer;
  for (let hops = 0; hops < 4; hops++) {
    const stat = await readFile(`/proc/${browser}/stat`, 'utf8').catch(() => null);
    const parent = stat ? parseStat(stat)?.ppid : undefined;
    if (!parent) break;
    browser = parent;
    const cmdline = await readFile(`/proc/${browser}/cmdline`, 'utf8').catch(() => '');
    if (!cmdline.includes('--type=')) break;
  }
  const sections: string[] = [];
  for (const [label, pid] of [
    ['renderer', renderer],
    ['browser', browser],
  ] as const) {
    const result = await new Promise<string>((resolveStacks) => {
      execFile(
        'gdb',
        ['-batch', '-p', String(pid), '-ex', 'set pagination off', '-ex', 'thread apply all bt 30'],
        { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
        (error, stdout, stderr) =>
          resolveStacks(error && !stdout ? `gdb failed: ${error.message}\n${stderr}` : stdout),
      );
    });
    sections.push(`===== ${label} ${pid} =====\n${result}`);
  }
  return sections.join('\n');
}

/** Parse /proc/<pid>/stat, whose name field may itself hold spaces and parentheses. */
function parseStat(
  stat: string,
): { name: string; state: string; ppid: number; ticks: number } | null {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = stat.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  const ticks = Number(fields[11]) + Number(fields[12]);
  if (!fields[0] || Number.isNaN(ppid) || Number.isNaN(ticks)) return null;
  return { name: stat.slice(open + 1, close), state: fields[0], ppid, ticks };
}

function formatRendererThreads(
  before: RendererThreads | null,
  after: RendererThreads | null,
): string[] {
  if (!before || !after) return [];
  if (after.renderers.size === 0) return ['[renderer] no renderer process found in /proc'];
  const elapsed = Math.round(after.at - before.at);
  const lines: string[] = [];
  for (const [pid, threads] of after.renderers) {
    const start = new Map((before.renderers.get(pid) ?? []).map((t) => [t.tid, t.ticks]));
    const sampled = threads.map((t) => ({
      ...t,
      ms: (t.ticks - (start.get(t.tid) ?? t.ticks)) * MS_PER_TICK,
    }));
    const main = sampled.find((t) => t.tid === pid);
    if (main) {
      // An idle main thread also sleeps on a futex while it waits for tasks, so
      // "asleep" alone cannot tell idle from stuck; the threads below can.
      const share = elapsed > 0 ? main.ms / elapsed : 0;
      const verdict =
        share >= 0.5 ? 'spinning' : share < 0.05 && main.state !== 'R' ? 'asleep' : 'partly busy';
      const wchan = main.wchan ? `, wchan ${main.wchan}` : '';
      lines.push(
        `[renderer ${pid}] main thread ${verdict}: state ${main.state}, ${main.ms}ms CPU in ${elapsed}ms${wchan}`,
      );
    }
    const others = sampled
      .filter((t) => t.tid !== pid)
      .sort((a, b) => b.ms - a.ms || a.name.localeCompare(b.name))
      .slice(0, MAX_THREADS);
    for (const t of others) {
      const wchan = t.wchan ? ` wchan ${t.wchan}` : '';
      lines.push(`[renderer ${pid}]   ${t.name} ${t.state} ${t.ms}ms${wchan}`);
    }
  }
  return lines;
}

/**
 * Chromium's renderer sometimes stops answering while booting the page, with no
 * JS running (2026-10: nine CI hits across six spec files, never locally). The
 * browser and the daemon still answer. Nothing in the page can cause or clear
 * it, so only this exact signature earns a retry; any other failure, including
 * a renderer paused or spinning in our own code, still fails the run.
 */
function isRendererHang(renderer: string[], daemon: string[]): boolean {
  return (
    renderer[0]?.startsWith('[renderer] did not answer evaluate') === true &&
    renderer.some((line) => line.startsWith('[browser] responsive')) &&
    daemon[0]?.startsWith('[daemon] responsive; 0 item(s)') === true
  );
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
