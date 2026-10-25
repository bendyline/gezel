/**
 * A Chromium trace of each test's page boot, kept only when the boot hits the
 * known renderer hang. That hang's main thread waits in native code: 0 ms CPU,
 * no answer to evaluate or to a debugger pause, a futex in /proc. Neither the
 * debugger nor /proc can name the wait, and CI's Chrome has no symbols for gdb.
 * A trace event's begin is written when its scope opens, and Chromium copies a
 * blocked thread's unflushed buffer when the trace stops, so the slices still
 * open on the renderer's main thread name the call it is stuck in.
 *
 * Every hang so far came before the page's first `load`, so the trace stops
 * there: a healthy boot pays for a second or two of tracing, not the whole test.
 */
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Browser, CDPSession, Page } from '@playwright/test';

const gzipAsync = promisify(gzip);

const CATEGORIES = [
  // Every task each thread runs, with the code that posted it.
  'toplevel',
  // Waits: WaitableEvent, ScopedBlockingCall, sync IPC.
  'base',
  'mojom',
  'ipc',
  'blink',
  'loading',
  'navigation',
  'fonts',
  // Parse, script, style, layout and paint, as DevTools' Performance panel shows them.
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'v8',
  'cc',
  'gpu',
  'viz',
];

// A ring buffer: if the wait outlasts it, the oldest events go and the
// blocked thread's last ones, copied at the stop, stay.
const BUFFER_KB = 64 * 1024;
const STOP_TIMEOUT_MS = 15_000;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_ARG_CHARS = 240;
const MAX_OPEN_THREADS = 12;
const MAX_FINISHED = 8;

/** CI only, unless GEZEL_E2E_CHROME_TRACE says otherwise; the hang has never reproduced locally. */
export function bootTraceEnabled(): boolean {
  const flag = process.env.GEZEL_E2E_CHROME_TRACE;
  if (flag !== undefined) return flag !== '0';
  return Boolean(process.env.CI);
}

export interface BootTrace {
  /** Stop the trace, write it gzipped to `path`, and summarize what was still running. */
  save(path: string): Promise<string[]>;
  /** Stop the trace and throw it away. */
  discard(): Promise<void>;
}

type TracingComplete = { stream?: string; dataLossOccurred: boolean };

/** Starts tracing every process of this worker's browser, or returns why it could not. */
export async function startBootTrace(browser: Browser, page: Page): Promise<BootTrace | string> {
  let session: CDPSession;
  try {
    session = await browser.newBrowserCDPSession();
  } catch (err) {
    return `[trace] could not open a browser CDP session: ${messageOf(err)}`;
  }
  const completed = new Promise<TracingComplete>((resolveComplete) => {
    session.once('Tracing.tracingComplete', resolveComplete);
  });
  try {
    await session.send('Tracing.start', {
      transferMode: 'ReturnAsStream',
      streamFormat: 'json',
      traceConfig: {
        recordMode: 'recordContinuously',
        traceBufferSizeInKb: BUFFER_KB,
        includedCategories: CATEGORIES,
      },
    });
  } catch (err) {
    await session.detach().catch(() => {});
    return `[trace] Tracing.start failed: ${messageOf(err)}`;
  }

  let ended: Promise<TracingComplete | null> | null = null;
  const end = () => {
    ended ??= session.send('Tracing.end').then(
      () => withTimeout(completed, STOP_TIMEOUT_MS),
      () => null,
    );
    return ended;
  };
  const close = async (stream: string | undefined) => {
    if (stream) await session.send('IO.close', { handle: stream }).catch(() => {});
    await session.detach().catch(() => {});
  };
  let finished: Promise<void> | null = null;
  const discard = () => {
    finished ??= end().then((done) => close(done?.stream));
    return finished;
  };
  const onLoad = () => {
    if (page.url() !== 'about:blank') void discard();
  };
  page.on('load', onLoad);

  return {
    discard: async () => {
      page.off('load', onLoad);
      await discard();
    },
    save: async (path) => {
      page.off('load', onLoad);
      if (finished) {
        await finished;
        return ['[trace] the page had already loaded, so its boot trace was not kept'];
      }
      let lines: string[] = [];
      finished = (async () => {
        const done = await end();
        if (!done?.stream) {
          lines = [`[trace] Chromium did not finish the trace within ${STOP_TIMEOUT_MS}ms`];
          return close(undefined);
        }
        try {
          const json = await readStream(session, done.stream);
          await writeFile(path, await gzipAsync(json));
          lines = [
            `[trace] kept ${path.split(/[\\/]/).pop()} (${Math.round(json.length / 1024)} KB of JSON${done.dataLossOccurred ? ', oldest events overwritten' : ''}); open it in ui.perfetto.dev`,
            ...summarizeBootTrace(json),
          ];
        } catch (err) {
          lines = [`[trace] could not read the trace: ${messageOf(err)}`];
        }
        await close(done.stream);
      })();
      await finished;
      return lines;
    },
  };
}

async function readStream(session: CDPSession, handle: string): Promise<string> {
  const chunks: Buffer[] = [];
  for (;;) {
    const chunk = await session.send('IO.read', { handle, size: READ_CHUNK_BYTES });
    chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
    if (chunk.eof) return Buffer.concat(chunks).toString('utf8');
  }
}

interface TraceEvent {
  ph: string;
  name?: string;
  pid: number;
  tid: number;
  ts?: number;
  dur?: number;
  args?: Record<string, unknown>;
}

interface Slice {
  name: string;
  ts: number;
  args?: Record<string, unknown>;
}

/**
 * The slices still open on every thread when the trace ended, innermost last,
 * and the main threads' last finished slices. A thread waiting for its next
 * task has none open, so an open slice that began long before the end is the
 * wait itself.
 */
export function summarizeBootTrace(json: string): string[] {
  const parsed = JSON.parse(json) as { traceEvents?: TraceEvent[] } | TraceEvent[];
  const events = Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []);
  const processNames = new Map<number, string>();
  const threadNames = new Map<string, string>();
  const timed: { event: TraceEvent; order: number }[] = [];
  events.forEach((event, order) => {
    if (event.ph === 'M') {
      const name = typeof event.args?.name === 'string' ? event.args.name : undefined;
      if (name && event.name === 'process_name') processNames.set(event.pid, name);
      if (name && event.name === 'thread_name') threadNames.set(`${event.pid}:${event.tid}`, name);
    } else if (typeof event.ts === 'number' && ['B', 'E', 'X'].includes(event.ph)) {
      timed.push({ event, order });
    }
  });
  if (timed.length === 0) return ['[trace] no thread slices recorded'];
  timed.sort((a, b) => (a.event.ts ?? 0) - (b.event.ts ?? 0) || a.order - b.order);
  const start = timed[0]?.event.ts ?? 0;
  let last = start;
  const open = new Map<string, Slice[]>();
  const finished = new Map<string, { name: string; end: number; dur: number }[]>();
  for (const { event } of timed) {
    const key = `${event.pid}:${event.tid}`;
    const ts = event.ts ?? 0;
    const stack = open.get(key) ?? [];
    open.set(key, stack);
    if (event.ph === 'B') {
      stack.push({ name: event.name ?? '?', ts, args: event.args });
      last = Math.max(last, ts);
    } else if (event.ph === 'E') {
      const slice = stack.pop();
      if (slice) record(finished, key, { name: slice.name, end: ts, dur: ts - slice.ts });
      last = Math.max(last, ts);
    } else {
      const end = ts + (event.dur ?? 0);
      record(finished, key, { name: event.name ?? '?', end, dur: event.dur ?? 0 });
      last = Math.max(last, end);
    }
  }

  const label = (key: string) => {
    const [pid] = key.split(':');
    const process = processNames.get(Number(pid)) ?? 'process';
    return `${process} ${pid} ${threadNames.get(key) ?? `thread ${key.split(':')[1]}`}`;
  };
  const at = (ts: number) => `+${Math.round((ts - start) / 1000)}ms`;
  const lines = [`[trace] ${timed.length} slices over ${Math.round((last - start) / 1000)}ms`];
  const stuck = [...open]
    .filter(([, stack]) => stack.length > 0)
    .sort(([, a], [, b]) => (a[0]?.ts ?? 0) - (b[0]?.ts ?? 0))
    .slice(0, MAX_OPEN_THREADS);
  if (stuck.length === 0) lines.push('[trace] no slice was open on any thread when the trace ended');
  for (const [key, stack] of stuck) {
    lines.push(`[trace] ${label(key)}: open when the trace ended, outermost first`);
    for (const slice of stack) {
      const args = slice.args && Object.keys(slice.args).length > 0 ? ` ${clip(JSON.stringify(slice.args))}` : '';
      lines.push(
        `[trace]   ${slice.name} since ${at(slice.ts)}, ${Math.round((last - slice.ts) / 1000)}ms before the end${args}`,
      );
    }
  }
  for (const [key, slices] of finished) {
    if (!/^Cr\w*Main$/.test(threadNames.get(key) ?? '')) continue;
    const recent = slices.slice(-MAX_FINISHED).map((s) => `${s.name} ${Math.round(s.dur / 1000)}ms at ${at(s.end)}`);
    lines.push(`[trace] ${label(key)}: last finished: ${recent.join(', ')}`);
  }
  return lines;
}

function record<T extends { end: number }>(into: Map<string, T[]>, key: string, item: T): void {
  const list = into.get(key) ?? [];
  list.push(item);
  list.sort((a, b) => a.end - b.end);
  if (list.length > MAX_FINISHED) list.shift();
  into.set(key, list);
}

function clip(text: string): string {
  return text.length > MAX_ARG_CHARS ? `${text.slice(0, MAX_ARG_CHARS)}…` : text;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolveTimeout) => setTimeout(() => resolveTimeout(null), ms)),
  ]);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
