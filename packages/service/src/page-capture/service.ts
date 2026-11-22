/**
 * The daemon side of page capture. Opens one capture session per sync pass:
 * a browser session (filter proxy + capture worker process) where a
 * sandboxed browser can run, else a text-only session that says why. One
 * browser session runs at a time install-wide; a second pass waits for it.
 * `cancelAll` kills every running worker, which is how the network setting,
 * emergency stop and shutdown stop captures mid-page.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAwakeTimeout, createLogger } from '@bendyline/gezel';
import { findServiceBundleResource } from '@bendyline/gezel-inference/internal/utils/service-worker-entry';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { browserScriptEnv } from '../sandbox/runner.js';
import type { WorkerReply, WorkerRequest } from './capture-worker.js';
import {
  DEFAULT_PAGE_NETWORK_BUDGET,
  FilterProxy,
  type FilterProxyOptions,
  SIGN_IN_NETWORK_BUDGET,
} from './filter-proxy.js';
import { HttpCaptureSession } from './http-session.js';
import { resolveCaptureChromium } from './launch-policy.js';
import {
  type CaptureSession,
  type CaptureSessionOptions,
  CaptureUnavailableError,
  type PageCaptureOutcome,
  type PageCaptureRequest,
  type PageCapturer,
  type StorageStateLike,
} from './types.js';

const log = createLogger('page-capture');

/** Awake-time budget for one page, over the worker's own timeouts. */
const PAGE_BUDGET_MS = 60_000;
const OPEN_BUDGET_MS = 45_000;
/** How long a browser that failed to start is left alone before trying again. */
const RETRY_BROWSER_AFTER_MS = 60 * 60_000;

export interface PageCaptureServiceOptions {
  home: string;
  /** Re-read before every page; false means the network setting is off. */
  isAllowed: () => Promise<boolean>;
  /** Text-only transport (tests). */
  fetchImpl?: typeof fetch;
  /** Test seams for the filter proxy; production passes none. */
  proxyTestOptions?: Pick<FilterProxyOptions, 'resolve' | 'allowLoopbackPorts'>;
  /** Resolve the browser to use (tests). */
  resolveBrowser?: () => Promise<string | null>;
}

/** A sign-in window the person drives. */
export interface SignInWindow {
  readonly windowClosed: boolean;
  currentUrl(): Promise<string | undefined>;
  storageState(): Promise<StorageStateLike | undefined>;
  close(): Promise<void>;
}

export interface CaptureBrowserStatus {
  available: boolean;
  reason?: string;
}

export class PageCaptureService implements PageCapturer {
  private slot: Promise<void> = Promise.resolve();
  private readonly live = new Set<BrowserCaptureSession>();
  private failed: { executable: string; reason: string; at: number } | null = null;

  constructor(private readonly opts: PageCaptureServiceOptions) {}

  async open(session: CaptureSessionOptions): Promise<CaptureSession> {
    if (!(await this.opts.isAllowed())) {
      throw new CaptureUnavailableError(
        'Saving web pages is off at this security level. Turn on App network in Settings → Security & compliance.',
      );
    }
    const text = (reason?: string) => new HttpCaptureSession(session, this.opts.fetchImpl, reason);
    if (!session.browser) return text();
    if (process.env.GEZEL_CAPTURE_BROWSER === 'off') {
      return text('The browser is turned off for page capture on this computer.');
    }
    const executable = await (
      this.opts.resolveBrowser ?? (() => resolveCaptureChromium(this.opts.home))
    )();
    if (!executable) {
      return text(
        'The browser Gezel uses is still being set up; pages are saved as text until it is ready.',
      );
    }
    if (
      this.failed &&
      this.failed.executable === executable &&
      Date.now() - this.failed.at < RETRY_BROWSER_AFTER_MS
    ) {
      return text(this.failed.reason);
    }
    const release = await this.acquire();
    if (session.signal?.aborted) {
      release();
      throw new CaptureUnavailableError('Stopped.');
    }
    let browser: BrowserCaptureSession;
    try {
      browser = await BrowserCaptureSession.start({
        executable,
        options: session,
        home: this.opts.home,
        isAllowed: this.opts.isAllowed,
        ...(this.opts.proxyTestOptions ? { proxyTestOptions: this.opts.proxyTestOptions } : {}),
      });
    } catch (err) {
      release();
      const detail = err instanceof Error ? err.message : String(err);
      const reason = `The browser could not start safely here, so pages are saved as text (${detail.slice(0, 160)}).`;
      this.failed = { executable, reason, at: Date.now() };
      log.warn(`capture browser unavailable: ${detail}`);
      return text(reason);
    }
    this.failed = null;
    this.live.add(browser);
    browser.onClosed = () => {
      this.live.delete(browser);
      release();
    };
    return browser;
  }

  /** Whether captures run in a browser here, as of the last attempt. */
  browserStatus(): CaptureBrowserStatus {
    if (process.env.GEZEL_CAPTURE_BROWSER === 'off') {
      return {
        available: false,
        reason: 'The browser is turned off for page capture on this computer.',
      };
    }
    if (this.failed) return { available: false, reason: this.failed.reason };
    return { available: true };
  }

  /** Kill every running capture and sign-in window now. */
  cancelAll(reason: string): void {
    for (const s of this.live) s.kill(reason);
    for (const w of this.signIns) w.kill(reason);
  }

  private readonly signIns = new Set<BrowserCaptureSession>();

  /**
   * Open a visible browser window for the person to sign in to a site. Same
   * browser, proxy and sandbox as captures; it does not take the capture
   * slot, since a person may keep it open for minutes. Gezel sends it no
   * input; the person drives it.
   */
  async openSignIn(opts: {
    startUrl: string;
    host: string;
    privateHosts: readonly string[];
  }): Promise<SignInWindow> {
    if (!(await this.opts.isAllowed())) {
      throw new CaptureUnavailableError('Signing in to sites is off at this security level.');
    }
    if (process.env.GEZEL_CAPTURE_BROWSER === 'off') {
      throw new CaptureUnavailableError(
        'The browser is turned off for page capture on this computer.',
      );
    }
    const executable = await (
      this.opts.resolveBrowser ?? (() => resolveCaptureChromium(this.opts.home))
    )();
    if (!executable) {
      throw new CaptureUnavailableError(
        'The browser Gezel uses is still being set up. Try again in a few minutes.',
      );
    }
    const window = await BrowserCaptureSession.start({
      executable,
      options: { privateHosts: opts.privateHosts, browser: true, allowScriptPost: true },
      home: this.opts.home,
      isAllowed: this.opts.isAllowed,
      headed: { startUrl: opts.startUrl, host: opts.host },
      ...(this.opts.proxyTestOptions ? { proxyTestOptions: this.opts.proxyTestOptions } : {}),
    });
    this.signIns.add(window);
    window.onClosed = () => this.signIns.delete(window);
    return window;
  }

  private acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = this.slot.then(() => release);
    this.slot = this.slot.then(() => next);
    return ready;
  }
}

interface Pending {
  resolve: (reply: WorkerReply) => void;
  reject: (err: Error) => void;
}

class BrowserCaptureSession implements CaptureSession {
  readonly render = 'browser' as const;
  onClosed: (() => void) | null = null;
  private child: ChildProcess | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private openWaiter: Pending | null = null;
  private relaunched = false;
  private closed = false;
  private stopReason: string | null = null;
  private removeAbort: (() => void) | null = null;

  private constructor(
    private readonly args: {
      executable: string;
      options: CaptureSessionOptions;
      home: string;
      isAllowed: () => Promise<boolean>;
      proxyTestOptions?: Pick<FilterProxyOptions, 'resolve' | 'allowLoopbackPorts'>;
      /** A visible window for signing in, not a capture session. */
      headed?: { startUrl: string; host: string };
    },
    private readonly proxy: FilterProxy,
    private readonly profileDir: string,
  ) {}

  static async start(args: BrowserCaptureSession['args']): Promise<BrowserCaptureSession> {
    const extraPorts = args.options.privateHosts
      .map((h) => Number(/:(\d+)$/.exec(h)?.[1]))
      .filter((p) => Number.isInteger(p) && p > 0);
    const proxy = await FilterProxy.start({
      privateHosts: args.options.privateHosts.map((h) => h.replace(/:\d+$/, '')),
      allowScriptPost: args.options.allowScriptPost,
      extraPorts,
      ...(args.proxyTestOptions ?? {}),
    });
    // The proxy refuses everything until a page begins. A capture begins one
    // per request; a sign-in window has no requests of its own, so its page
    // (the site the person signs in to) begins before the window opens.
    // Without this every connection the window made was refused.
    if (args.headed) proxy.beginPage(args.headed.host, SIGN_IN_NETWORK_BUDGET);
    const profileDir = await mkdtemp(join(tmpdir(), 'gezel-capture-'));
    const session = new BrowserCaptureSession(args, proxy, profileDir);
    try {
      await session.launch();
    } catch (err) {
      await session.teardown();
      throw err;
    }
    if (args.options.signal) {
      const onAbort = () => session.kill('stopped');
      args.options.signal.addEventListener('abort', onAbort, { once: true });
      session.removeAbort = () => args.options.signal?.removeEventListener('abort', onAbort);
    }
    return session;
  }

  private async launch(): Promise<void> {
    // Built only: the worker's relative imports do not resolve from source.
    const entry = findServiceBundleResource(import.meta.url, ['page-capture/capture-worker.js']);
    if (!entry) throw new Error('the capture worker is not built');
    const env: Record<string, string> = browserScriptEnv(process.env);
    for (const k of Object.keys(env)) {
      if (/^(https?|all|no)_proxy$/i.test(k)) delete env[k];
    }
    env.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersDir(this.args.home);
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const node = process.env.GEZEL_NODE_PATH || process.execPath;
    const child = spawn(node, [entry], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
      windowsHide: true,
    });
    this.child = child;
    child.stderr?.on('data', (d: Buffer) =>
      log.debug(`worker: ${d.toString('utf8').slice(0, 400)}`),
    );
    child.stdout?.on('data', () => {});
    child.on('message', (raw) => this.onMessage(raw as WorkerReply));
    child.on('exit', (code, sig) => this.onExit(code, sig));
    // A spawn that fails (a bad GEZEL_NODE_PATH, EAGAIN) emits 'error' and
    // may never emit 'exit'. Unheard, it is an uncaught exception, and the
    // daemon exits on one.
    child.on('error', (err) => {
      log.warn(`capture worker failed: ${err.message}`);
      if (this.child === child) this.failWorker(err);
    });
    const deadline = createAwakeTimeout(OPEN_BUDGET_MS);
    try {
      const reply = await new Promise<WorkerReply>((resolve, reject) => {
        this.openWaiter = { resolve, reject };
        deadline.signal.addEventListener(
          'abort',
          () => reject(new Error('the browser took too long to start')),
          {
            once: true,
          },
        );
        this.post({
          type: 'open',
          executablePath: this.args.executable,
          proxyServer: `http://127.0.0.1:${this.proxy.port}`,
          profileDir: this.profileDir,
          ...(this.args.options.storageState
            ? { storageState: this.args.options.storageState }
            : {}),
          allowScriptPost: this.args.options.allowScriptPost,
          signedIn: Boolean(this.args.options.storageState),
          ...(this.args.headed
            ? {
                headed: true,
                startUrl: this.args.headed.startUrl,
                signInHost: this.args.headed.host,
              }
            : {}),
        });
      });
      if (reply.type === 'open-failed') throw new Error(reply.message);
      if (reply.type === 'opened')
        log.info(
          `capture browser ${reply.version} started (sandbox confirmed: ${reply.sandboxVerified})`,
        );
    } finally {
      this.openWaiter = null;
      deadline.dispose();
    }
  }

  private post(msg: WorkerRequest): void {
    if (!this.child?.connected) throw new Error('the capture worker is not running');
    this.child.send(msg);
  }

  /** The person closed the sign-in window themselves. */
  windowClosed = false;

  private onMessage(msg: WorkerReply): void {
    if (msg.type === 'window-closed') {
      this.windowClosed = true;
      return;
    }
    if (msg.type === 'opened' || msg.type === 'open-failed') {
      this.openWaiter?.resolve(msg);
      return;
    }
    if (msg.type === 'result' || msg.type === 'storage-state' || msg.type === 'current-url') {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        p.resolve(msg);
      }
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.failWorker(
      new Error(this.stopReason ?? `the browser stopped (${code ?? signal ?? 'unknown'})`),
    );
  }

  private failWorker(err: Error): void {
    this.child = null;
    this.openWaiter?.reject(err);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private request(msg: WorkerRequest & { id: number }, budgetMs: number): Promise<WorkerReply> {
    const deadline = createAwakeTimeout(budgetMs);
    return new Promise<WorkerReply>((resolve, reject) => {
      const done = () => deadline.dispose();
      this.pending.set(msg.id, {
        resolve: (r) => {
          done();
          resolve(r);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      deadline.signal.addEventListener(
        'abort',
        () => {
          this.pending.delete(msg.id);
          // A page that outlives its budget takes the browser with it; the
          // next page gets a fresh one.
          this.child?.kill();
          reject(new Error('the page took too long'));
        },
        { once: true },
      );
      try {
        this.post(msg);
      } catch (err) {
        this.pending.delete(msg.id);
        done();
        reject(err as Error);
      }
    });
  }

  async capture(req: PageCaptureRequest): Promise<PageCaptureOutcome> {
    if (this.closed || this.stopReason) {
      return { ok: false, kind: 'unavailable', message: this.stopReason ?? 'Stopped.' };
    }
    if (!(await this.args.isAllowed())) {
      return {
        ok: false,
        kind: 'unavailable',
        message: 'Saving web pages is off at this security level.',
      };
    }
    if (!this.child) {
      // One relaunch per pass after a crash or a page that ran out of time.
      if (this.relaunched)
        return { ok: false, kind: 'unavailable', message: 'The browser stopped during this pass.' };
      this.relaunched = true;
      try {
        await this.launch();
      } catch (err) {
        return {
          ok: false,
          kind: 'unavailable',
          message: `The browser could not restart: ${(err as Error).message}`,
        };
      }
    }
    let host = '';
    try {
      host = new URL(req.url).hostname;
    } catch {
      return { ok: false, kind: 'failed', message: 'Not a web address.' };
    }
    this.proxy.beginPage(host, DEFAULT_PAGE_NETWORK_BUDGET);
    const id = this.nextId++;
    try {
      const reply = await this.request(
        {
          type: 'capture',
          id,
          url: req.url,
          screenshots: Math.max(0, Math.min(6, req.screenshots)),
          maxImages: Math.max(0, Math.min(12, req.maxImages)),
          stagingDir: req.stagingDir,
          scopes: req.scopes ?? [],
          pageTimeoutMs: PAGE_BUDGET_MS - 15_000,
        },
        PAGE_BUDGET_MS,
      );
      if (reply.type !== 'result')
        return { ok: false, kind: 'failed', message: 'The browser gave no result.' };
      return reply.outcome;
    } catch (err) {
      return { ok: false, kind: 'failed', message: (err as Error).message };
    } finally {
      const stats = this.proxy.endPage();
      if (stats.overBudget)
        log.info(
          `capture of ${host} hit its network budget (${stats.bytes} bytes, ${stats.connections} connections)`,
        );
    }
  }

  /** The address the most recent tab shows (sign-in windows). */
  async currentUrl(): Promise<string | undefined> {
    if (!this.child) return undefined;
    const reply = await this.request({ type: 'current-url', id: this.nextId++ }, 15_000).catch(
      () => null,
    );
    return reply?.type === 'current-url' ? reply.url : undefined;
  }

  async storageState(): Promise<StorageStateLike | undefined> {
    if (!this.child) return undefined;
    const reply = await this.request({ type: 'storage-state', id: this.nextId++ }, 15_000).catch(
      () => null,
    );
    return reply?.type === 'storage-state'
      ? (reply.state as StorageStateLike | undefined)
      : undefined;
  }

  /** Stop now: kill the worker and refuse further captures. */
  kill(reason: string): void {
    this.stopReason = reason;
    this.child?.kill();
    void this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeAbort?.();
    const child = this.child;
    if (child?.connected) {
      try {
        child.send({ type: 'close' } satisfies WorkerRequest);
      } catch {
        /* already gone */
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          child.kill();
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    } else {
      child?.kill();
    }
    await this.teardown();
    this.onClosed?.();
  }

  private async teardown(): Promise<void> {
    // A browser that failed to start leaves its worker running; a host
    // without Chrome's sandbox retried hourly and piled up idle workers.
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
    await this.proxy.close().catch(() => {});
    await rm(this.profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
