import { z } from 'zod';

/**
 * Output Pane API v1 — the versioned postMessage envelope between a served
 * project-type page (opaque-origin iframe) and the host UI relay.
 *
 * The page side of this protocol is the server-injected `window.gezel` shim;
 * the parent side is the relay in the UI's HtmlPreviewFrame. Neither end
 * trusts the other's messages beyond these shapes: the shim additionally
 * requires `event.source === window.parent`, and the relay requires
 * `event.source === frame.contentWindow` (the iframe is sandboxed without
 * `allow-same-origin`, so origins are opaque and window identity is the only
 * authentication available).
 *
 * v0 compatibility: the legacy sentinels (`__gezelPageInvoke`,
 * `__gezelPageResult`, `__gezelPageRefresh`) are a permanent parallel path —
 * shipped catalog pages hard-code them. The v1 envelope uses a disjoint
 * sentinel key so both generations coexist on one MessagePort.
 */

export const PAGE_BRIDGE_VERSION = 1 as const;

/** Sources a page may read through the bridge (matches PreviewSource minus 'type'). */
export const PageReadSourceSchema = z.enum(['workspace', 'artifacts']);
export type PageReadSource = z.infer<typeof PageReadSourceSchema>;

const envelopeBase = { __gezelPage: z.literal(PAGE_BRIDGE_VERSION) };

/* ───────────────────────────── page → parent ────────────────────────────── */

export const PageHelloMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('hello'),
});

export const PageInvokeMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('invoke'),
  id: z.string().min(1).max(64),
  tool: z.string().regex(/^[a-z][a-z0-9_]*$/),
  input: z.record(z.string(), z.unknown()).optional(),
});

export const PageReadMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('read'),
  id: z.string().min(1).max(64),
  op: z.enum(['read', 'list', 'stat']),
  source: PageReadSourceSchema,
  path: z.string().min(1),
  /** 'text' | 'json' | 'bytes' — read op only; default derived from extension. */
  as: z.enum(['text', 'json', 'bytes']).optional(),
  maxBytes: z.number().int().positive().optional(),
});

export const PageWatchMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('watch'),
  id: z.string().min(1).max(64),
  source: PageReadSourceSchema,
  path: z.string().min(1),
});

export const PageUnwatchMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('unwatch'),
  id: z.string().min(1).max(64),
});

export const PageRefreshMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('refresh'),
});

export const PageToParentMessageSchema = z.discriminatedUnion('kind', [
  PageHelloMessageSchema,
  PageInvokeMessageSchema,
  PageReadMessageSchema,
  PageWatchMessageSchema,
  PageUnwatchMessageSchema,
  PageRefreshMessageSchema,
]);
export type PageToParentMessage = z.infer<typeof PageToParentMessageSchema>;

/* ───────────────────────────── parent → page ────────────────────────────── */

/** Error codes the shim surfaces as `GezelToolError.code`. */
export const PageBridgeErrorCodeSchema = z.enum([
  'not-allowed',
  'invalid-input',
  'script-error',
  'timeout',
  'unavailable',
  'rate-limited',
]);
export type PageBridgeErrorCode = z.infer<typeof PageBridgeErrorCodeSchema>;

export const ParentInitMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('init'),
  api: z.literal(PAGE_BRIDGE_VERSION),
  theme: z.object({ mode: z.enum(['light', 'dark']) }),
  limits: z.object({
    maxInflight: z.number().int().positive(),
    maxReadBytes: z.number().int().positive(),
  }),
});

export const ParentResultMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('result'),
  id: z.string(),
  ok: z.boolean(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  errorCode: PageBridgeErrorCodeSchema.optional(),
  runId: z.string().optional(),
  reaction: z
    .object({
      delivered: z.boolean(),
      gezelId: z.string().optional(),
      reason: z.string().optional(),
    })
    .optional(),
});

export const ParentReadResultMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('read-result'),
  id: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  errorCode: PageBridgeErrorCodeSchema.optional(),
  /** Present for op 'read'. */
  content: z.string().optional(),
  encoding: z.enum(['utf8', 'base64']).optional(),
  /** Present for op 'list'. */
  entries: z
    .array(
      z.object({
        name: z.string(),
        kind: z.enum(['file', 'dir']),
        size: z.number().nonnegative(),
        mtime: z.number().nonnegative(),
      }),
    )
    .optional(),
  /** Present for 'read' and 'stat'. */
  etag: z.string().optional(),
  size: z.number().nonnegative().optional(),
  mtime: z.number().nonnegative().optional(),
});

export const ParentChangeMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('change'),
  watchId: z.string(),
  path: z.string(),
  etag: z.string(),
});

export const ParentThemeMessageSchema = z.object({
  ...envelopeBase,
  kind: z.literal('theme'),
  theme: z.object({ mode: z.enum(['light', 'dark']) }),
});

export const ParentToPageMessageSchema = z.discriminatedUnion('kind', [
  ParentInitMessageSchema,
  ParentResultMessageSchema,
  ParentReadResultMessageSchema,
  ParentChangeMessageSchema,
  ParentThemeMessageSchema,
]);
export type ParentToPageMessage = z.infer<typeof ParentToPageMessageSchema>;

/* ───────────────────────── bootstrap (server-injected) ──────────────────── */

/**
 * Baked into the shim when the page is served by the app-serve head (a
 * shareable mini-site) instead of the in-app Output pane. Its presence
 * selects mode `serve`: `tools.invoke`/`data.*` go over same-origin fetch
 * against these bases (visitor cookie auth) rather than the postMessage
 * relay. All paths are same-origin relative — the shim never learns an
 * absolute daemon address, and no bearer ever reaches the page.
 */
export const PageApiServeBootstrapSchema = z.object({
  /** Base for the head API, e.g. `/app/api`. */
  apiBase: z.string(),
  /** Base for direct data/media GETs (`data.url()`), e.g. `/data`. */
  dataBase: z.string(),
  /** Whether this site accepts visitor chat (pages may show/hide chat UI). */
  chat: z.boolean(),
});
export type PageApiServeBootstrap = z.infer<typeof PageApiServeBootstrapSchema>;

/**
 * Static facts baked into the shim at serve time by the preview route's
 * `type` branch. Everything here is server-authoritative — the page never
 * derives identity from its own URL again.
 */
export const PageApiBootstrapSchema = z.object({
  api: z.literal(PAGE_BRIDGE_VERSION),
  projectId: z.string(),
  source: z.literal('type'),
  /** Entry path relative to the version's pages/ tree. */
  entry: z.string(),
  typeName: z.string(),
  params: z.record(z.string(), z.unknown()),
  /** Declared page-invokable tool names (pages.tools ∩ tools[]). */
  tools: z.array(z.string()),
  /** Present only when served by the app-serve head (selects mode `serve`). */
  serve: PageApiServeBootstrapSchema.optional(),
});
export type PageApiBootstrap = z.infer<typeof PageApiBootstrapSchema>;
