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
  // Not cc or viz: the browser keeps compositing while the page is stuck, and
  // those frames were half of a trace's bytes.
  'gpu',
];

// A ring buffer, so a wait that outlasts it loses the oldest events rather than
// the newest. A 30 s hang recorded 58 MB of JSON locally and did not wrap it.
const BUFFER_KB = 64 * 1024;
// Chromium converts the whole buffer to JSON before it answers: 4 s for that 30 s hang.
const STOP_TIMEOUT_MS = 30_000;
const READ_CHUNK_BYTES = 4 * 1024 * 1024;
const STUCK_MS = 1_000;
const MAX_ARG_CHARS = 240;
const MAX_THREADS = 8;
const MAX_FINISHED = 8;

/** CI only, unless GEZEL_E2E_CHROME_TRACE says otherwise; the hang has never reproduced locally. */
export function bootTraceEnabled(): boolean {
  const flag = process.env.GEZEL_E2E_CHROME_TRACE;
  if (flag !== undefined) return flag !== '0';
  return Boolean(process.env.CI);
}

export interface BootTrace {
  /** Stop the trace, write it gzipped to `path`, and summarize what was still running. */
  save(path: string): Promise<{ kept: boolean; lines: string[] }>;
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
        return {
          kept: false,
          lines: ['[trace] the page had already loaded, so its boot trace was not kept'],
        };
      }
      let kept = false;
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
          kept = true;
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
      return { kept, lines };
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
 * The slices still open on each stuck thread when the trace ended, innermost
 * last, and the slices it finished just before. A thread waiting for its next
 * task has none open, so an open slice that began long before the end is the
 * wait itself. With no thread stuck, the renderers' main threads are shown.
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
  // Stopping the trace runs a task on every process, so most threads are mid-task
  // at the end. Stuck means the innermost open slice is old.
  const innermostTs = (key: string) => open.get(key)?.at(-1)?.ts ?? last;
  const stuck = [...open.keys()]
    .filter((key) => last - innermostTs(key) >= STUCK_MS * 1000)
    .sort((a, b) => innermostTs(a) - innermostTs(b));
  if (stuck.length === 0) {
    lines.push(
      `[trace] no thread had been inside one slice for ${STUCK_MS}ms when the trace ended`,
    );
  }
  const focus =
    stuck.length > 0
      ? stuck
      : [...threadNames].filter(([, name]) => name === 'CrRendererMain').map(([key]) => key);
  for (const key of focus.slice(0, MAX_THREADS)) {
    const stack = open.get(key) ?? [];
    lines.push(
      stack.length > 0
        ? `[trace] ${label(key)}: open when the trace ended, outermost first`
        : `[trace] ${label(key)}: nothing open when the trace ended`,
    );
    for (const slice of stack) {
      const args =
        slice.args && Object.keys(slice.args).length > 0
          ? ` ${clip(JSON.stringify(slice.args))}`
          : '';
      lines.push(
        `[trace]   ${slice.name} since ${at(slice.ts)}, ${Math.round((last - slice.ts) / 1000)}ms before the end${args}`,
      );
    }
    const recent = (finished.get(key) ?? []).map(
      (s) => `${s.name} ${Math.round(s.dur / 1000)}ms at ${at(s.end)}`,
    );
    if (recent.length > 0) lines.push(`[trace]   last finished: ${recent.join(', ')}`);
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
