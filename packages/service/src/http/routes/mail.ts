/**
 * Mail routes, mounted under /api/projects so URLs resolve as
 * `/api/projects/:id/mail/*`. Linking a mailbox and triggering a sync are
 * user-initiated actions (like a GitHub clone), so they aren't gated by the
 * autonomous-agent `allowMail` posture — that gates the background scheduler.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { DraftNotFoundError, RecipientNotAllowedError } from '../../mail/manager.js';
import { MailCredentialMissingError } from '../../mail/registry.js';
import type { ServiceContext } from '../context.js';

const ImapCredentialSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().positive().optional(),
  secure: z.boolean().optional(),
  user: z.string().min(1),
  pass: z.string().min(1),
});

const MailLinkRequestSchema = z.object({
  provider: z.enum(['imap', 'gmail', 'microsoft365', 'outlook']).default('imap'),
  address: z.string().min(1),
  displayName: z.string().optional(),
  syncFolders: z.array(z.string()).optional(),
  imap: ImapCredentialSchema.optional(),
});

const DraftRequestSchema = z.object({
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string(),
  body: z.string(),
  inReplyTo: z.string().optional(),
  threadId: z.string().optional(),
  accountId: z.string().optional(),
});

const DraftIdRequestSchema = z.object({ draftId: z.string().min(1) });

const OAuthStartRequestSchema = z.object({
  provider: z.enum(['gmail', 'microsoft365', 'outlook']),
  address: z.string().min(1),
  redirectUri: z.string().min(1),
  tenant: z.string().optional(),
  syncFolders: z.array(z.string()).optional(),
});

const OAuthCompleteRequestSchema = z.object({
  state: z.string().min(1),
  code: z.string().min(1),
});

export function mailRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/mail/status', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(await ctx.mail.status(project));
  });

  app.post('/:id/mail/link', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = MailLinkRequestSchema.parse(await c.req.json());
    try {
      const account = await ctx.mail.linkMailbox(project, body);
      return c.json({ ok: true, account });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post('/:id/mail/sync', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    if (!project.mail?.accounts?.length) {
      return c.json({ error: 'project has no linked mailbox' }, 400);
    }
    try {
      const results = await ctx.mail.syncProject(project);
      return c.json({ ok: true, results });
    } catch (err) {
      if (err instanceof MailCredentialMissingError) {
        return c.json({ error: err.message, code: 'MAIL_CREDENTIAL_MISSING' }, 400);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  // ── OAuth linking (Gmail / Microsoft) ────────────────────────────────────
  // The shell opens `authUrl`, captures the redirect's `code`, and posts it to
  // /complete. Client ids come from the install env (GEZEL_GOOGLE_CLIENT_ID /
  // GEZEL_MICROSOFT_CLIENT_ID).
  app.post('/:id/mail/oauth/start', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = OAuthStartRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.mail.startOAuth(project, body);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/:id/mail/oauth/complete', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = OAuthCompleteRequestSchema.parse(await c.req.json());
    try {
      const account = await ctx.mail.completeOAuth(project, body);
      return c.json({ ok: true, account });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── outbound (draft → queue → send) ──────────────────────────────────────

  // Draft / queue are pure file ops (no network), so they're always allowed.
  app.post('/:id/mail/draft', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = DraftRequestSchema.parse(await c.req.json());
    const result = await ctx.mail.draftEmail(project, body);
    return c.json({ ok: true, ...result });
  });

  app.post('/:id/mail/queue', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const { draftId } = DraftIdRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.mail.queueEmail(project, draftId);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return mailError(c, err);
    }
  });

  // Send is the consent-gated network action: the manager enforces the
  // recipient allowlist (deny-by-default) and refuses to transmit during night
  // shift (staging the message in _outbox/ instead).
  app.post('/:id/mail/send', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const { draftId } = DraftIdRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.mail.sendDraft(project, draftId);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return mailError(c, err);
    }
  });

  return app;
}

function mailError(c: import('hono').Context, err: unknown) {
  if (err instanceof RecipientNotAllowedError) {
    return c.json(
      { error: err.message, code: 'RECIPIENT_NOT_ALLOWED', recipients: err.recipients },
      403,
    );
  }
  if (err instanceof DraftNotFoundError) {
    return c.json({ error: err.message, code: 'DRAFT_NOT_FOUND' }, 404);
  }
  if (err instanceof MailCredentialMissingError) {
    return c.json({ error: err.message, code: 'MAIL_CREDENTIAL_MISSING' }, 400);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 500);
}
