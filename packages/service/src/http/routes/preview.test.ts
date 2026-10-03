import { describe, expect, it } from 'vitest';
import {
  PREVIEW_LOG_SHIM,
  PREVIEW_SCROLLBAR_SHIM,
  preparePreviewHtml,
  previewProblemModule,
} from './preview.js';

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

describe('PREVIEW_SCROLLBAR_SHIM', () => {
  it('hides embedded scrollbar chrome at rest and reveals it for interaction', () => {
    expect(PREVIEW_SCROLLBAR_SHIM).toContain('scrollbar-color:transparent transparent');
    expect(PREVIEW_SCROLLBAR_SHIM).toContain(':hover');
    expect(PREVIEW_SCROLLBAR_SHIM).toContain(':focus-within');
    expect(PREVIEW_SCROLLBAR_SHIM).toContain('__gezel-preview-scrolling');
    expect(PREVIEW_SCROLLBAR_SHIM).toContain('@media(forced-colors:active)');
  });

  it('holds the scrolling state for 700ms and clears it after the idle timer', () => {
    const classes = new Set<string>();
    const listeners: Record<string, () => void> = {};
    let scheduled: { callback: () => void; delay: number } | null = null;
    const fakeWindow = {};
    const script = PREVIEW_SCROLLBAR_SHIM.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const run = new Function(
      'window',
      'parent',
      'document',
      'addEventListener',
      'setTimeout',
      'clearTimeout',
      script!,
    );

    run(
      fakeWindow,
      {},
      {
        documentElement: {
          classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
          },
        },
      },
      (type: string, listener: () => void) => {
        listeners[type] = listener;
      },
      (callback: () => void, delay: number) => {
        scheduled = { callback, delay };
        return 1;
      },
      () => {},
    );

    expect(classes.has('__gezel-preview-frame')).toBe(true);
    listeners.scroll?.();
    expect(classes.has('__gezel-preview-scrolling')).toBe(true);
    expect(scheduled).toMatchObject({ delay: 700 });
    (scheduled as { callback: () => void } | null)?.callback();
    expect(classes.has('__gezel-preview-scrolling')).toBe(false);
  });

  it('does not alter scrollbars when the preview is opened as a top-level page', () => {
    const classes = new Set<string>();
    const fakeWindow = {};
    const script = PREVIEW_SCROLLBAR_SHIM.match(/<script>([\s\S]*)<\/script>/)?.[1];
    const run = new Function(
      'window',
      'parent',
      'document',
      'addEventListener',
      'setTimeout',
      'clearTimeout',
      script!,
    );

    run(
      fakeWindow,
      fakeWindow,
      {
        documentElement: {
          classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
          },
        },
      },
      () => {},
      () => 1,
      () => {},
    );

    expect(classes.size).toBe(0);
  });
});

describe('preparePreviewHtml', () => {
  it('drops browser-internal link resources without altering portable links or body text', () => {
    const html = `<!doctype html><html><head>
      <link rel="stylesheet" href="chrome://resources/css/text_defaults.css">
      <link href='chrome://credits/credits.css' rel='stylesheet'>
      <link rel="stylesheet" href="./portable.css">
    </head><body>See chrome://credits for the built-in page.</body></html>`;

    const prepared = preparePreviewHtml(html);

    expect(prepared).not.toContain('href="chrome://');
    expect(prepared).not.toContain("href='chrome://");
    expect(prepared).toContain('href="./portable.css"');
    expect(prepared).toContain('See chrome://credits for the built-in page.');
    expect(prepared).toContain(PREVIEW_LOG_SHIM);
    expect(prepared).toContain(PREVIEW_SCROLLBAR_SHIM);
  });

  // Source modules are compiled as they are served, so a page keeps them. A
  // root-absolute source is the page's own folder, as Vite reads it.
  it('keeps source modules for the server to compile, as modules from the page folder', () => {
    const prepared = preparePreviewHtml(`<!doctype html><html><head></head><body>
      <script type="module" src="/src/main.tsx"></script>
      <script src="game.ts"></script>
      <script type="text/javascript" src="./levels.ts"></script>
    </body></html>`);

    expect(prepared).toContain('<script type="module" src="src/main.tsx" crossorigin="anonymous">');
    expect(prepared).toContain('<script src="game.ts" type="module" crossorigin="anonymous">');
    expect(prepared).toContain('src="./levels.ts" type="module"');
    expect(prepared).not.toContain('text/javascript');
  });

  it('shows why a source module cannot run, on the page', () => {
    const shown: string[] = [];
    const body = { replaceChildren: (box: { textContent: string }) => shown.push(box.textContent) };
    const run = new Function(
      'document',
      'console',
      'addEventListener',
      previewProblemModule("main.ts imports ./game, which isn't in the project."),
    );
    run(
      {
        readyState: 'complete',
        body,
        createElement: () => ({ setAttribute() {}, style: {}, textContent: '' }),
      },
      { error() {} },
      () => {},
    );
    expect(shown).toEqual(["main.ts imports ./game, which isn't in the project."]);
  });

  it('leaves built JavaScript modules untouched', () => {
    const html =
      '<html><head></head><body><script type="module" src="./assets/app.js"></script></body></html>';
    const prepared = preparePreviewHtml(html);
    expect(prepared).toContain(
      '<script type="module" src="./assets/app.js" crossorigin="anonymous"></script>',
    );
    expect(prepared).not.toContain('Preview cannot run unbuilt');
  });

  it('does not impose CORS on classic third-party scripts', () => {
    const html =
      '<html><head><script src="https://cdn.example.test/widget.js"></script></head></html>';
    const prepared = preparePreviewHtml(html);
    expect(prepared).toContain('<script src="https://cdn.example.test/widget.js"></script>');
    expect(prepared).not.toContain(
      '<script src="https://cdn.example.test/widget.js" crossorigin="anonymous">',
    );
  });

  it('injects the window.gezel page API only when a bootstrap is supplied', () => {
    const html = '<html><head></head><body>page</body></html>';
    const bootstrap = {
      api: 1 as const,
      projectId: 'p1',
      source: 'type' as const,
      entry: 'board/index.html',
      typeName: 'Checkers',
      params: {},
      tools: ['user_move'],
    };
    const withApi = preparePreviewHtml(html, { pageApi: bootstrap });
    expect(withApi).toContain("Object.defineProperty(window,'gezel'");
    expect(withApi).toContain('"projectId":"p1"');
    // Ordering: log shim first so page-api failures are captured.
    expect(withApi.indexOf('__gezelPreviewLog')).toBeLessThan(
      withApi.indexOf("Object.defineProperty(window,'gezel'"),
    );

    const without = preparePreviewHtml(html);
    expect(without).not.toContain("Object.defineProperty(window,'gezel'");
  });
});
