import { z } from 'zod';

/**
 * Saved web pages: what the website connector has captured for a project, as
 * the Web pages view, the `list_web_pages` tool and the composer read it. The
 * records themselves are ordinary connector files under
 * `artifacts/data/<corpus>/`; this is the index over them, built from the
 * connector's private crawl list. Contract: docs/website-connector.md.
 */

/**
 * Where a page stands in its binding's crawl list.
 * - `saved`: a record exists and is current as of `capturedAt`.
 * - `queued`: found as a link inside the site, not captured yet.
 * - `failed`: the last attempt failed; it is retried later.
 * - `blocked`: the site answered with a bot check, a sign-in wall or a refusal.
 *   Any earlier copy is kept untouched.
 * - `gone`: the site says the page no longer exists; its record was removed.
 * - `skipped`: refused by a rule (outside the site, an action link, an exclude
 *   pattern, robots.txt, the page cap).
 */
export const WebPageStateSchema = z.enum([
  'saved',
  'queued',
  'failed',
  'blocked',
  'gone',
  'skipped',
]);
export type WebPageState = z.infer<typeof WebPageStateSchema>;

export const WebPageEntrySchema = z.object({
  /** Normalized address: the page's identity. */
  url: z.string(),
  title: z.string().optional(),
  /** Host of the site scope it belongs to. */
  site: z.string(),
  bindingId: z.string(),
  state: WebPageStateSchema,
  /** Plain-language reason for `failed`, `blocked` and `skipped`. */
  reason: z.string().optional(),
  /** Artifact-relative path of the record, when one exists. */
  path: z.string().optional(),
  /** Artifact-relative screenshot paths, first screen first. */
  screenshots: z.array(z.string()).default([]),
  /** When the page was last captured successfully (ISO). */
  capturedAt: z.string().optional(),
  /** When its text last changed (ISO). */
  changedAt: z.string().optional(),
  /** When the crawler first found it (ISO). */
  firstSeenAt: z.string().optional(),
  words: z.number().int().nonnegative().optional(),
  /** How it was captured: a real browser, or a plain download (text only). */
  render: z.enum(['browser', 'http']).optional(),
  signedIn: z.boolean().optional(),
  /** Links from a saved page to it; 0 for a start address. */
  depth: z.number().int().nonnegative().optional(),
  /** A short synopsis, when one has been written (untrusted: derived from page text). */
  summary: z.string().optional(),
});
export type WebPageEntry = z.infer<typeof WebPageEntrySchema>;

export const WebSiteBindingSchema = z.object({
  bindingId: z.string(),
  displayName: z.string(),
  /** Start addresses, normalized. */
  sites: z.array(z.string()),
  corpusDir: z.string(),
  lastSyncedAt: z.string().optional(),
  lastError: z.string().optional(),
  disabled: z.boolean().optional(),
  /** Captures run in a real browser here (false: text-only mode). */
  browser: z.boolean().optional(),
  /** Why the browser is not available, in plain words. */
  browserUnavailableReason: z.string().optional(),
  /** Whether a saved sign-in exists for this binding. */
  signedIn: z.boolean().optional(),
  counts: z.object({
    saved: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
  }),
  /** When the next scheduled refresh is due (ISO); absent for manual-only bindings. */
  nextRefreshAt: z.string().optional(),
  /** Saved per-binding: let gezels ask for found links without asking the person first. */
  gezelRequests: z.enum(['allow', 'ask']).optional(),
});
export type WebSiteBinding = z.infer<typeof WebSiteBindingSchema>;

export const WebPagesListResponseSchema = z.object({
  bindings: z.array(WebSiteBindingSchema),
  pages: z.array(WebPageEntrySchema),
  /** True when the list was cut at the request's limit. */
  truncated: z.boolean().default(false),
  /**
   * Whether this install can save pages at all: its catalog carries the
   * website connector type. Absent from older daemons.
   */
  canSave: z.boolean().optional(),
});
export type WebPagesListResponse = z.infer<typeof WebPagesListResponseSchema>;

/** `POST /api/projects/:id/web-pages/save`: the person saves one address now. */
export const SaveWebPageRequestSchema = z.object({
  url: z.string().min(1).max(4000),
  /** Keep only for one chat: removed when that chat is deleted. */
  sessionId: z.string().optional(),
});
export type SaveWebPageRequest = z.infer<typeof SaveWebPageRequestSchema>;

export const SaveWebPageResponseSchema = z.object({
  page: WebPageEntrySchema,
  bindingId: z.string(),
});
export type SaveWebPageResponse = z.infer<typeof SaveWebPageResponseSchema>;
