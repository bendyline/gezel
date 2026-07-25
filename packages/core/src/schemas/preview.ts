import { z } from 'zod';

export const PreviewSourceSchema = z.enum(['artifacts', 'workspace', 'type']);
export type PreviewSource = z.infer<typeof PreviewSourceSchema>;

export const CreatePreviewCapabilityRequestSchema = z.object({
  source: PreviewSourceSchema,
  path: z.string().max(4_096),
});
export type CreatePreviewCapabilityRequest = z.infer<typeof CreatePreviewCapabilityRequestSchema>;

export const CreatePreviewCapabilityResponseSchema = z.object({
  /** Relative daemon URL; contains only the scoped preview capability. */
  url: z.string().startsWith('/preview/'),
  /**
   * Absolute `http://127.0.0.1:<port>/preview/…` URL served by the daemon's
   * plain-HTTP preview listener, for opening the preview in an external
   * browser without the loopback-TLS self-signed-cert warning. Absent when
   * the daemon runs the whole transport over plain HTTP already
   * (`GEZEL_INSECURE_TRANSPORT=1`) — callers fall back to `url`.
   */
  browserUrl: z.string().url().optional(),
  /** Current idle-expiry. In-scope requests extend it up to an absolute cap. */
  expiresAt: z.string(),
  /** Directory subtree granted for the requested entry document. */
  scopePath: z.string(),
});
export type CreatePreviewCapabilityResponse = z.infer<typeof CreatePreviewCapabilityResponseSchema>;

// ── Page check (post-write runtime smoke check) ──

export const PageCheckRequestSchema = z.object({
  /** Workspace-relative path of the HTML page to load headlessly. */
  path: z.string().max(4_096),
});
export type PageCheckRequest = z.infer<typeof PageCheckRequestSchema>;

export const PageCheckResponseSchema = z.object({
  /**
   * Whether a browser actually loaded the page. False when the Playwright
   * toolset / Chromium isn't bootstrapped or the check timed out before
   * producing a verdict — callers treat that as "no signal", never as a pass.
   */
  ran: z.boolean(),
  /** Page loaded with zero runtime errors. Only meaningful when `ran`. */
  ok: z.boolean().optional(),
  /** Normalized runtime errors (pageerror / console.error / failed resource loads). */
  errors: z.array(z.string()).optional(),
  /** Why the check was skipped when `ran` is false. */
  reason: z.string().optional(),
});
export type PageCheckResponse = z.infer<typeof PageCheckResponseSchema>;

// ── Preview log loopback (iframe shim → service → next-turn nudge) ──

export const PreviewLogEntrySchema = z.object({
  kind: z.enum(['error', 'unhandledrejection', 'console.error']),
  /** Flattened human-readable message (shim `detail` normalized client-side). */
  message: z.string().max(2_000),
  /** Workspace/artifact-relative page path the error came from. */
  path: z.string().max(4_096),
  source: PreviewSourceSchema,
  at: z.string(),
});
export type PreviewLogEntry = z.infer<typeof PreviewLogEntrySchema>;

export const ReportPreviewLogRequestSchema = z.object({
  entries: z.array(PreviewLogEntrySchema).min(1).max(20),
});
export type ReportPreviewLogRequest = z.infer<typeof ReportPreviewLogRequestSchema>;
