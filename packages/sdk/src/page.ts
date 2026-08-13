/**
 * `@bendyline/gezel-sdk/page` — the Output Pane API v1 typing contract for
 * `window.gezel`, the object every served project-type page codes against.
 *
 * The runtime object is injected server-side by the daemon
 * (`packages/service/src/http/routes/page-api-shim.ts` splices the shim
 * into every `text/html` response served from the `type` preview source),
 * so pages never bundle an implementation — this module exists so gilde
 * page authors and the host UI relay share one contract. The postMessage
 * envelope behind it is validated by the zod schemas in
 * `@bendyline/gezel` (`packages/core/src/schemas/page-bridge.ts`); the
 * shapes here are mirrored, not imported, for the same reason as
 * `./types.ts` — the SDK stays runtime-dependency-free and vendor-friendly.
 *
 * Modes and what degrades outside the app:
 *  - `embedded` — the Output pane iframe. Every call relays over the v1
 *    postMessage envelope to the host, which holds the credentials; the
 *    page never sees one.
 *  - `browser` — an "Open in browser" tab with no embedding parent. Data
 *    reads fall back to same-origin capability fetches; `tools.invoke`
 *    rejects with code `'unavailable'`; `refresh()` reloads the page.
 *  - `demo` — a raw file opened outside gezel entirely. The real shim is
 *    never present there; gilde ships a paste-in stub that defines
 *    `window.gezel` only when the real one is absent.
 *
 * Guard accordingly: `if (window.gezel) { ... }`.
 */

/** The page-API generation this module types. Compare with `page.api`. */
export const GEZEL_PAGE_API_VERSION = 1 as const;

/**
 * Where a data call reads from: the project's editable `workspace` tree
 * or its generated-output `artifacts` store. Defaults to `'workspace'`.
 * Reads are scoped server-side to what the page's manifest declared —
 * out-of-scope paths reject with code `'not-allowed'`.
 */
export type GezelPageReadSource = 'workspace' | 'artifacts';

/** How the page is being viewed; see the module doc for what each mode degrades. */
export type GezelPageMode = 'embedded' | 'browser' | 'demo';

/** Error codes a rejected page-API call carries (`GezelPageError.code`). */
export type GezelPageErrorCode =
  | 'not-allowed'
  | 'invalid-input'
  | 'script-error'
  | 'timeout'
  | 'unavailable'
  | 'rate-limited';

/**
 * The error every page-API rejection carries. `code` is the stable field
 * to branch on; `message` is human-readable and may change between
 * releases.
 */
export interface GezelPageError extends Error {
  /** Machine-readable failure class. */
  code: GezelPageErrorCode;
  /** The script run that failed, when a tool invoke got far enough to start one. */
  runId?: string;
}

/**
 * Static facts about this page, baked in at serve time — the daemon is
 * authoritative, so pages never derive identity from their own URL.
 */
export interface GezelPageInfo {
  /** Page-API generation; `1` for this contract. */
  api: 1;
  /** The project this page is served for. */
  projectId: string;
  /** Always `'type'` — pages are served from an installed project type. */
  source: 'type';
  /** Entry path relative to the type version's pages/ tree, e.g. `'board/index.html'`. */
  entry: string;
  /** Name of the project type that shipped this page. */
  typeName: string;
  /** The project's adoption params (the values chosen when the type was adopted). */
  params: Record<string, unknown>;
  /** How the page is currently being viewed. */
  mode: GezelPageMode;
}

/**
 * Whether a gezel picked up the side effects of a tool invoke (e.g. a
 * record change a crew member should react to), and why not when not.
 */
export interface GezelPageToolReaction {
  /** `true` when the reaction was handed to a gezel. */
  delivered: boolean;
  /** The gezel it was delivered to, when known. */
  gezelId?: string;
  /** Why delivery was skipped, when it was. */
  reason?: string;
}

/** Resolution value of {@link GezelPageToolsApi.invoke}. */
export interface GezelPageToolResult {
  /** The value the tool's script stamped as its output. */
  output: unknown;
  /** The script run that produced the output, for correlating logs. */
  runId?: string;
  /** Gezel-reaction delivery status, when the tool declared one. */
  reaction?: GezelPageToolReaction;
}

/**
 * Project-type tools the page may invoke. Only tools the type's manifest
 * declared page-invokable are callable — everything else rejects with
 * code `'not-allowed'`.
 */
export interface GezelPageToolsApi {
  /** Names of the tools this page may invoke (a fresh copy per call). */
  list(): string[];
  /**
   * Invoke a declared tool and await its output. Rejects with a
   * {@link GezelPageError} (`'unavailable'` outside the app,
   * `'timeout'` when the run outlives the call budget, `'rate-limited'`
   * when too many calls are queued).
   *
   * @param tool - Tool name, as returned by {@link list}.
   * @param input - Tool input object; validated against the tool's declared inputs.
   */
  invoke(tool: string, input?: Record<string, unknown>): Promise<GezelPageToolResult>;
}

/** Options for {@link GezelPageDataApi.read}. */
export interface GezelPageReadOptions {
  /** Which tree to read from. Defaults to `'workspace'`. */
  source?: GezelPageReadSource;
  /**
   * Decode as `'text'` (string), `'json'` (parsed value), or `'bytes'`
   * (Uint8Array). Default derives from the extension: `.json` files parse
   * as JSON, everything else reads as text.
   */
  as?: 'text' | 'json' | 'bytes';
  /** Reject reads larger than this many bytes (host ceilings still apply). */
  maxBytes?: number;
}

/** Options for {@link GezelPageDataApi.list} and {@link GezelPageDataApi.url}. */
export interface GezelPageSourceOptions {
  /** Which tree to target. Defaults to `'workspace'`. */
  source?: GezelPageReadSource;
}

/** One entry of a directory listing. */
export interface GezelPageDirEntry {
  /** Base name of the entry (not the full path). */
  name: string;
  kind: 'file' | 'dir';
  /** Size in bytes; `0` for directories. */
  size: number;
  /** Last-modified time, milliseconds since the epoch. */
  mtime: number;
}

/** The change notification a watch callback receives. */
export interface GezelPageWatchEvent {
  /** The watched path (as passed to `watch`). */
  path: string;
  /** Opaque content stamp; changes whenever the content does. Re-read to get the new value. */
  etag: string;
}

/** Options for {@link GezelPageDataApi.watch}. */
export interface GezelPageWatchOptions {
  /** Which tree the watched path lives in. Defaults to `'workspace'`. */
  source?: GezelPageReadSource;
  /** Poll interval for browser-mode fallback polling; embedded watches push and ignore it. */
  intervalMs?: number;
}

/**
 * Read-only access to the project's files, scoped to what the page's
 * manifest declared readable. Out-of-scope paths reject with code
 * `'not-allowed'`; writes happen through {@link GezelPageToolsApi} only.
 */
export interface GezelPageDataApi {
  /**
   * Read one file. Resolves to a string for `'text'`, a parsed value for
   * `'json'`, or a `Uint8Array` for `'bytes'` (see
   * {@link GezelPageReadOptions.as} for the default). Rejects with a
   * {@link GezelPageError} on missing files, out-of-scope paths, or
   * invalid JSON.
   */
  read(path: string, opts?: GezelPageReadOptions): Promise<unknown>;
  /** List a directory (non-recursive). */
  list(path: string, opts?: GezelPageSourceOptions): Promise<GezelPageDirEntry[]>;
  /**
   * Watch a path and get called back when its content stamp changes.
   * Callbacks carry the new etag only — `read` again for the content.
   *
   * @returns An unsubscribe function; call it to stop the watch.
   */
  watch(
    path: string,
    cb: (ev: GezelPageWatchEvent) => void,
    opts?: GezelPageWatchOptions,
  ): () => void;
  /**
   * A capability-relative URL for the file, for `<img src>` / media
   * elements — the URL embeds the page's read scope, never a credential.
   * Throws a {@link GezelPageError} (`'unavailable'`) when the document
   * URL carries no capability.
   */
  url(path: string, opts?: GezelPageSourceOptions): string;
}

/** The host UI theme as seen by the page. */
export interface GezelPageTheme {
  mode: 'light' | 'dark';
}

/** Host UI state the page can mirror. */
export interface GezelPageUiApi {
  /** The current theme. Live — reflects the host's latest pushed value. */
  theme: GezelPageTheme;
  /**
   * Subscribe to theme changes (called only on actual changes).
   *
   * @returns An unsubscribe function.
   */
  onTheme(cb: (t: GezelPageTheme) => void): () => void;
}

/**
 * The `window.gezel` object a served project-type page codes against.
 * Installed non-writable before any page script runs; absent entirely in
 * demo contexts (see module doc), so feature-detect with `window.gezel`.
 */
export interface GezelPageApi {
  /** Static facts about this page (identity, params, mode). */
  page: GezelPageInfo;
  /** Invoke the project type's declared tools. */
  tools: GezelPageToolsApi;
  /** Read and watch project files within the page's declared scope. */
  data: GezelPageDataApi;
  /** Mirror host UI state (theme). */
  ui: GezelPageUiApi;
  /** Ask the host to re-serve the page (embedded); reloads the tab in browser mode. */
  refresh(): void;
}

declare global {
  interface Window {
    /** Present when the page is served (or stubbed) with the gezel page API. */
    gezel?: GezelPageApi;
  }
}
