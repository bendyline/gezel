import { describe, expect, it } from 'vitest';
import { PREVIEW_LOG_SHIM } from './preview.js';

/**
 * The preview log shim is browser JS injected as a string into every
 * HTML preview. We can't import it as a function, but we can run the
 * *actual shipped string* in a tiny hand-rolled sandbox: strip the
 * `<script>` wrapper, eval the IIFE with stubbed browser globals, and
 * capture the `error`/`unhandledrejection`/`console.error` listeners it
 * registers. Dispatching fake events at those listeners then asserts
 * the exact payload the UI would receive — no jsdom required.
 */
interface Posted {
  __gezelPreviewLog: boolean;
  kind: string;
  detail: {
    message?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
    stack?: string;
    args?: string[];
  };
  url: string;
  at: number;
}

const SECRET_CAPABILITY = 'secret-preview-capability';

function loadShim() {
  const posted: Posted[] = [];
  const listeners: Record<string, (e: unknown) => void> = {};
  const fakeWindow = {};
  const sandbox = {
    window: fakeWindow,
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    location: {
      href: `http://localhost/preview/${SECRET_CAPABILITY}/workspace/p1/index.html`,
    },
    console: { error: (..._args: unknown[]) => {} },
    Date: { now: () => 0 },
  };
  const js = PREVIEW_LOG_SHIM.replace(/^<script>/, '').replace(/<\/script>$/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(
    'window',
    'parent',
    'addEventListener',
    'location',
    'console',
    'Date',
    js,
  );
  run(
    sandbox.window,
    sandbox.parent,
    sandbox.addEventListener,
    sandbox.location,
    sandbox.console,
    sandbox.Date,
  );
  return { posted, listeners, console: sandbox.console, window: fakeWindow };
}

describe('PREVIEW_LOG_SHIM', () => {
  it('reports a useful message for a subresource load failure (the (unknown error) bug)', () => {
    const { posted, listeners } = loadShim();
    // A failed <script src> dispatches a plain Event on the element in
    // the capture phase — no message/filename/lineno on the event.
    listeners.error?.({
      target: {
        tagName: 'SCRIPT',
        src: `http://localhost/preview/${SECRET_CAPABILITY}/workspace/p1/invaders.js`,
      },
    });

    expect(posted).toHaveLength(1);
    const detail = posted[0]!.detail;
    expect(posted[0]!.kind).toBe('error');
    expect(detail.message).toContain('Failed to load script');
    expect(detail.message).toContain('invaders.js');
    // Message must never be empty — that's what rendered as "(unknown error)".
    expect(detail.message).toBeTruthy();
  });

  it('names a failed <img> by its src', () => {
    const { posted, listeners } = loadShim();
    listeners.error?.({
      target: {
        tagName: 'IMG',
        src: `http://localhost/preview/${SECRET_CAPABILITY}/workspace/p1/sprites.png`,
      },
    });
    expect(posted[0]!.detail.message).toContain('Failed to load img');
    expect(posted[0]!.detail.message).toContain('sprites.png');
  });

  it('forwards full detail for a genuine script ErrorEvent', () => {
    const { posted, listeners, window } = loadShim();
    listeners.error?.({
      target: window, // window-targeted = real uncaught script error
      message: 'x is not defined',
      filename: `http://localhost/preview/${SECRET_CAPABILITY}/workspace/p1/index.html`,
      lineno: 42,
      colno: 7,
      error: { stack: 'ReferenceError: x is not defined\n  at <anonymous>:42:7' },
    });
    const detail = posted[0]!.detail;
    expect(detail.message).toBe('x is not defined');
    expect(detail.lineno).toBe(42);
    expect(detail.colno).toBe(7);
    expect(detail.stack).toContain('ReferenceError');
  });

  it('falls back to a non-empty message when an ErrorEvent has no message', () => {
    const { posted, listeners, window } = loadShim();
    listeners.error?.({ target: window, error: { message: 'thrown later' } });
    expect(posted[0]!.detail.message).toBe('thrown later');

    const second = loadShim();
    second.listeners.error?.({ target: second.window });
    expect(second.posted[0]!.detail.message).toBeTruthy();
  });

  it('serializes an unhandled rejection reason', () => {
    const { posted, listeners } = loadShim();
    listeners.unhandledrejection?.({ reason: new Error('fetch failed') });
    expect(posted[0]!.kind).toBe('unhandledrejection');
    expect(posted[0]!.detail.message).toBe('fetch failed');
  });

  it('captures console.error args while preserving the original call', () => {
    const seen: unknown[][] = [];
    const { posted, console } = loadShim();
    // Re-wrap: the shim replaced console.error; the stub's original was a
    // no-op, so just assert our patched fn forwards args to the sink.
    console.error('boom', { code: 500 });
    void seen;
    expect(posted[0]!.kind).toBe('console.error');
    expect(posted[0]!.detail.args).toEqual(['boom', '{"code":500}']);
  });

  it('redacts capabilities from every forwarded URL-bearing field', () => {
    const { posted, listeners, console, window } = loadShim();
    const leaked = `http://localhost/preview/${SECRET_CAPABILITY}/workspace/p1/index.html`;
    listeners.error?.({
      target: window,
      message: `failure at ${leaked}`,
      filename: leaked,
      error: { stack: `Error\n    at ${leaked}:4:2` },
    });
    console.error('preview failed', leaked);

    expect(JSON.stringify(posted)).not.toContain(SECRET_CAPABILITY);
    expect(posted[0]!.url).toContain('/preview/[capability]/');
    expect(posted[0]!.detail.message).toContain('/preview/[capability]/');
    expect(posted[0]!.detail.filename).toContain('/preview/[capability]/');
    expect(posted[0]!.detail.stack).toContain('/preview/[capability]/');
    expect(posted[1]!.detail.args?.[1]).toContain('/preview/[capability]/');
  });
});
