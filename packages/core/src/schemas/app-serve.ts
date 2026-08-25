import { z } from 'zod';

/**
 * App serve — a daemon-hosted HTTP head that serves one applied AI App's
 * pages as a shareable mini-site, with the `window.gezel` page API carried
 * over same-origin fetch instead of the desktop postMessage relay. Sites
 * are ephemeral (in-daemon memory; nothing persists in config), controlled
 * from `/api/app-serve` and fronted by `gezel app serve`.
 *
 * Credential model: the site key is minted by the controller and lives only
 * in its memory and in the share URL — never in the TokenStore. Visitors
 * exchange it for a per-visitor HttpOnly cookie; neither credential means
 * anything to the daemon's `/api/*` surface, and no first-party bearer ever
 * appears in a serve response.
 */

export const AppServeStartRequestSchema = z.object({
  projectId: z.string().min(1),
  /** 0 (default) binds an ephemeral port; fixed ports suit tunnel configs. */
  port: z.number().int().min(0).max(65535).optional(),
  /** Bind address — an IP literal. Default 127.0.0.1; LAN exposure is explicit. */
  host: z.string().optional(),
  /**
   * Reverse-proxy / tunnel hostnames accepted by the Host check (exact,
   * case-insensitive). Loopback literals and the bound IP always pass.
   */
  allowedHosts: z.array(z.string().min(1)).max(8).optional(),
  /** Allow visitor chat with the project lead (default false). */
  chat: z.boolean().optional(),
  /** Skip the site key: any visitor gets a session on first page load. */
  public: z.boolean().optional(),
  /** Pin the site key (stable share links); minted at random when absent. */
  siteKey: z.string().min(24).max(128).optional(),
});
export type AppServeStartRequest = z.infer<typeof AppServeStartRequestSchema>;

export const AppServeSiteStatusSchema = z.object({
  siteId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  typeId: z.string(),
  typeName: z.string(),
  typeVersion: z.string(),
  host: z.string(),
  port: z.number().int(),
  url: z.string(),
  chat: z.boolean(),
  public: z.boolean(),
  startedAt: z.string(),
  visitors: z.number().int(),
  counters: z.object({
    pageViews: z.number().int(),
    invokes: z.number().int(),
    reads: z.number().int(),
    chatMessages: z.number().int(),
  }),
});
export type AppServeSiteStatus = z.infer<typeof AppServeSiteStatusSchema>;

/** The one response that carries the site key (mint/rotate time only). */
export const AppServeStartResponseSchema = AppServeSiteStatusSchema.extend({
  siteKey: z.string(),
  shareUrl: z.string(),
});
export type AppServeStartResponse = z.infer<typeof AppServeStartResponseSchema>;

export const ListAppServeSitesResponseSchema = z.object({
  sites: z.array(AppServeSiteStatusSchema),
});
export type ListAppServeSitesResponse = z.infer<typeof ListAppServeSitesResponseSchema>;

export const AppServeRotateKeyRequestSchema = z.object({
  /** Also drop every current visitor session (their cookies stop working). */
  revokeVisitors: z.boolean().optional(),
});
export type AppServeRotateKeyRequest = z.infer<typeof AppServeRotateKeyRequestSchema>;

/** Visitor-facing: body of `POST <site>/app/api/chat/send`. */
export const AppServeChatSendRequestSchema = z.object({
  message: z.string().min(1).max(4000),
});
export type AppServeChatSendRequest = z.infer<typeof AppServeChatSendRequestSchema>;

/** Visitor-facing: `GET <site>/app/api/site` feature-detection payload. */
export const AppServeSiteInfoSchema = z.object({
  typeName: z.string(),
  typeVersion: z.string(),
  chat: z.boolean(),
  limits: z.object({
    maxInflight: z.number().int(),
    maxReadBytes: z.number().int(),
  }),
});
export type AppServeSiteInfo = z.infer<typeof AppServeSiteInfoSchema>;
