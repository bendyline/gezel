import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ActionToolOutputSchema, errorResult, okResult } from './tool-contracts.js';

interface ConnectorActionToolDependencies {
  server: McpServer;
  baseUrl: string;
  token: string;
  projectId: string;
  fetchImpl: typeof fetch;
  unwrapApiError(error: unknown): string;
}

// ── email (projects with a mail-type connector binding) ──────────────────
// Reading email is done by reading the synced markdown files like any other
// file. These three tools are the WRITE path over the connector action
// surface: drafting stages a `send` action under the mail binding's corpus,
// and send_email commits it through the daemon-enforced recipient-allowlist
// consent scope (deny-by-default; night shift defers to the outbox).
// Registered only when the chat manager set GEZEL_MAIL_ENABLED (i.e. the
// project has a mail-type connector binding).
async function connectorActionApi(
  dependencies: ConnectorActionToolDependencies,
  path: string,
  method: string,
  body?: unknown,
): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const { baseUrl, token, projectId, fetchImpl } = dependencies;
  const url = `${baseUrl}/api/projects/${projectId}/connectors${path ? `/${path}` : ''}`;
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

/** Mail-type bindings on the project (accountId narrows to one). */
async function resolveMailBinding(
  dependencies: ConnectorActionToolDependencies,
  accountId?: string,
): Promise<string | null> {
  const { ok, data } = await connectorActionApi(dependencies, '', 'GET');
  if (!ok) throw new Error(String(data.error ?? 'failed to list connector bindings'));
  const bindings = (data.bindings ?? []) as { id: string; type: string }[];
  const mail = bindings.filter((b) => typeof b.type === 'string' && b.type.startsWith('mail-'));
  if (accountId) {
    const match = mail.find((b) => b.id === accountId)?.id;
    if (!match) throw new Error(`mail connector binding "${accountId}" was not found`);
    return match;
  }
  return mail[0]?.id ?? null;
}

export function registerEmailTools(dependencies: ConnectorActionToolDependencies): void {
  const { server, unwrapApiError } = dependencies;

  server.tool(
    'draft_email',
    "Compose an email draft and save it for review. This does NOT send — it stages a send action under the mail connector's corpus. Use queue_email to stage it for approval and send_email to actually transmit (sending is restricted to allowlisted recipients).",
    {
      to: z.array(z.string()).describe('Recipient email addresses'),
      cc: z.array(z.string()).optional().describe('CC recipients'),
      bcc: z.array(z.string()).optional().describe('BCC recipients'),
      subject: z.string().describe('Subject line'),
      body: z.string().describe('Email body (markdown; sent as plain text)'),
      inReplyTo: z.string().optional().describe('Message-ID being replied to, to thread the send'),
      accountId: z
        .string()
        .optional()
        .describe('Which mail connector binding to send from (defaults to the first)'),
    },
    async (args) => {
      try {
        const bindingId = await resolveMailBinding(dependencies, args.accountId);
        if (!bindingId) return errorResult('This project has no linked mail connector.');
        const { accountId: _drop, ...input } = args;
        const { ok, data } = await connectorActionApi(
          dependencies,
          `${encodeURIComponent(bindingId)}/actions`,
          'POST',
          { action: 'send', input },
        );
        if (!ok) return errorResult(String(data.error ?? 'Email draft failed.'));
        const draftId = typeof data.draftId === 'string' ? data.draftId : undefined;
        const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
        const summary = `Draft saved${draftId ? ` (id: ${draftId})` : ''}${relPath ? ` at ${relPath}` : ''}. Review it, then call queue_email then send_email.`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'drafted',
            ...(draftId ? { draftId } : {}),
            ...(relPath ? { relPath } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`draft_email failed: ${unwrapApiError(err)}`);
      }
    },
  );

  server.tool(
    'queue_email',
    'Stage a saved draft for sending by moving it to the outbox. Does not transmit.',
    { draftId: z.string().describe('The draft id returned by draft_email') },
    async ({ draftId }) => {
      try {
        const { ok, data } = await connectorActionApi(
          dependencies,
          `actions/${encodeURIComponent(draftId)}/queue`,
          'POST',
        );
        if (!ok) return errorResult(String(data.error ?? 'Email queue failed.'));
        const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
        const summary = `Queued draft ${draftId}${relPath ? ` (${relPath})` : ''}.`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'queued',
            draftId,
            ...(relPath ? { relPath } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`queue_email failed: ${unwrapApiError(err)}`);
      }
    },
  );

  // The low-risk write: the message lands in the person's own Drafts folder
  // (Gmail, Outlook, or IMAP) and nothing is sent. The person is the approval
  // step — they review and press Send in their mail app — so this drafts and
  // commits in one call instead of the three-step send path.
  server.tool(
    'save_email_draft',
    "Save an email as a draft in the user's own mailbox (their Drafts folder in Gmail, Outlook, or their mail server). Nothing is sent: the user reviews and sends it from their mail app. Prefer this over send_email unless the user explicitly asked you to send.",
    {
      to: z.array(z.string()).describe('Recipient email addresses'),
      cc: z.array(z.string()).optional().describe('CC recipients'),
      bcc: z.array(z.string()).optional().describe('BCC recipients'),
      subject: z.string().describe('Subject line'),
      body: z.string().describe('Email body (markdown; saved as plain text)'),
      inReplyTo: z
        .string()
        .optional()
        .describe(
          'Message-ID being replied to (the message_id field of a synced email), to thread the reply',
        ),
      accountId: z
        .string()
        .optional()
        .describe('Which mail connector binding to save into (defaults to the first)'),
    },
    async (args) => {
      try {
        const bindingId = await resolveMailBinding(dependencies, args.accountId);
        if (!bindingId) return errorResult('This project has no linked mail connector.');
        const { accountId: _drop, ...input } = args;
        const drafted = await connectorActionApi(
          dependencies,
          `${encodeURIComponent(bindingId)}/actions`,
          'POST',
          { action: 'save-draft', input },
        );
        if (!drafted.ok) {
          const message = String(drafted.data.error ?? 'Saving the draft failed.');
          const hint = /declares no action 'save-draft'/.test(message)
            ? 'This mail connection does not support mailbox drafts yet. Use draft_email instead, or ask the user to update Gezel and re-link the account.'
            : undefined;
          return errorResult(message, { ...(hint ? { hint } : {}) });
        }
        const draftId = typeof drafted.data.draftId === 'string' ? drafted.data.draftId : '';
        const { ok, data } = await connectorActionApi(
          dependencies,
          `actions/${encodeURIComponent(draftId)}/commit`,
          'POST',
        );
        if (!ok) {
          const message = String(data.error ?? 'Saving the draft failed.');
          const hint = /403|Mail\.ReadWrite|insufficient|permission/i.test(message)
            ? 'The mail connection was linked before drafts were supported. Ask the user to re-link the account so Gezel can save drafts.'
            : undefined;
          return errorResult(message, { ...(hint ? { hint } : {}) });
        }
        const result = (data.result ?? {}) as { webLink?: string };
        const summary = `Saved to the Drafts folder. Nothing was sent — the user can review and send it from their mail app.${result.webLink ? ` ${result.webLink}` : ''}`;
        return okResult(
          ActionToolOutputSchema,
          { summary, status: 'saved-to-mailbox', draftId },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`save_email_draft failed: ${unwrapApiError(err)}`);
      }
    },
  );

  server.tool(
    'send_email',
    'Transmit a drafted/queued email. The daemon enforces the recipient allowlist on the mail connector (sending to a non-allowlisted address is refused) and will NOT send during night shift (the message is staged for daytime approval instead).',
    { draftId: z.string().describe('The draft id to send') },
    async ({ draftId }) => {
      try {
        const { ok, data } = await connectorActionApi(
          dependencies,
          `actions/${encodeURIComponent(draftId)}/commit`,
          'POST',
        );
        if (!ok) {
          const message = String(data.error ?? 'Email send failed.');
          const hint = /allowlist/i.test(message)
            ? "Ask the user to add the recipient to the connector's allowed recipients/domains."
            : undefined;
          return errorResult(message, { ...(hint ? { hint } : {}) });
        }
        if (data.status === 'queued-night-shift') {
          const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
          const summary = `Night shift is active — not sending unattended. The message is staged in the outbox${relPath ? ` (${relPath})` : ''} and will require explicit approval.`;
          return okResult(
            ActionToolOutputSchema,
            {
              summary,
              status: 'queued-night-shift',
              draftId,
              ...(relPath ? { relPath } : {}),
            },
            { text: summary },
          );
        }
        const result = (data.result ?? {}) as { messageId?: string };
        const summary = `Sent.${result.messageId ? ` Message-ID: ${result.messageId}` : ''}`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'sent',
            draftId,
            ...(result.messageId ? { messageId: result.messageId } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`send_email failed: ${unwrapApiError(err)}`);
      }
    },
  );
}

// ── social posts (projects with a social-type connector binding) ──────────
// Reading synced posts/mentions/stats is done by reading the corpus files.
// These three tools are the WRITE path over the connector action surface:
// drafting stages a `publish` action under the social binding's corpus, and
// publish_post commits it through the daemon-enforced social-publish consent
// scope (deny-by-default; night shift defers to the outbox). Registered only
// when the chat manager set GEZEL_SOCIAL_ENABLED (i.e. the project has a
// social-type connector binding).
const SOCIAL_TYPE_PREFIXES = ['bluesky-', 'x-', 'instagram-', 'linkedin-'];

/** Social-type bindings on the project (accountId narrows to one). */
async function resolveSocialBinding(
  dependencies: ConnectorActionToolDependencies,
  accountId?: string,
): Promise<string | null> {
  const { ok, data } = await connectorActionApi(dependencies, '', 'GET');
  if (!ok) throw new Error(String(data.error ?? 'failed to list connector bindings'));
  const bindings = (data.bindings ?? []) as { id: string; type: string }[];
  const social = bindings.filter(
    (b) =>
      typeof b.type === 'string' &&
      SOCIAL_TYPE_PREFIXES.some((prefix) => b.type.startsWith(prefix)),
  );
  if (accountId) {
    const match = social.find((b) => b.id === accountId)?.id;
    if (!match) throw new Error(`social connector binding "${accountId}" was not found`);
    return match;
  }
  return social[0]?.id ?? null;
}

export function registerSocialTools(dependencies: ConnectorActionToolDependencies): void {
  const { server, unwrapApiError } = dependencies;

  server.tool(
    'draft_post',
    "Compose a social post draft and save it for review. This does NOT publish — it stages a publish action under the social connector's corpus. Use queue_post to stage it for approval and publish_post to publish. Works with any connected social account: Bluesky, X, and LinkedIn publish directly once the user enables publishing on the connection; Instagram additionally requires a publicly hosted https image URL (Meta's servers fetch the media). Every publish clears the user's consent gate.",
    {
      text: z.string().describe('The post text (Bluesky limit: 300 characters)'),
      replyToUri: z
        .string()
        .optional()
        .describe('at:// URI of the post being replied to, to thread the reply'),
      langs: z
        .array(z.string())
        .optional()
        .describe('BCP-47 language codes for the post, e.g. ["en"]'),
      images: z
        .array(
          z.object({
            path: z
              .string()
              .describe(
                "Project-relative image path, resolved against the project's artifacts directory first, then its workspace",
              ),
            alt: z.string().optional().describe('Alt text describing the image for accessibility'),
          }),
        )
        .max(4)
        .optional()
        .describe(
          'Up to 4 images to embed (png/jpg/jpeg/webp/gif, at most 1,000,000 bytes each; paths resolve against project artifacts first, then the workspace). ALWAYS write meaningful alt text for every image — never leave it blank.',
        ),
      accountId: z
        .string()
        .optional()
        .describe('Which social connector binding to post from (defaults to the first)'),
    },
    async (args) => {
      try {
        const bindingId = await resolveSocialBinding(dependencies, args.accountId);
        if (!bindingId) return errorResult('This project has no linked social connector.');
        const { accountId: _drop, ...input } = args;
        const { ok, data } = await connectorActionApi(
          dependencies,
          `${encodeURIComponent(bindingId)}/actions`,
          'POST',
          { action: 'publish', input },
        );
        if (!ok) return errorResult(String(data.error ?? 'Post draft failed.'));
        const draftId = typeof data.draftId === 'string' ? data.draftId : undefined;
        const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
        const summary = `Draft saved${draftId ? ` (id: ${draftId})` : ''}${relPath ? ` at ${relPath}` : ''}. Review it, then call queue_post then publish_post.`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'drafted',
            ...(draftId ? { draftId } : {}),
            ...(relPath ? { relPath } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`draft_post failed: ${unwrapApiError(err)}`);
      }
    },
  );

  server.tool(
    'queue_post',
    'Stage a saved post draft for publishing by moving it to the outbox. Does not publish.',
    { draftId: z.string().describe('The draft id returned by draft_post') },
    async ({ draftId }) => {
      try {
        const { ok, data } = await connectorActionApi(
          dependencies,
          `actions/${encodeURIComponent(draftId)}/queue`,
          'POST',
        );
        if (!ok) return errorResult(String(data.error ?? 'Post queue failed.'));
        const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
        const summary = `Queued draft ${draftId}${relPath ? ` (${relPath})` : ''}.`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'queued',
            draftId,
            ...(relPath ? { relPath } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`queue_post failed: ${unwrapApiError(err)}`);
      }
    },
  );

  server.tool(
    'publish_post',
    'Publish a drafted/queued social post. The daemon enforces per-binding publish consent (publishing must be enabled on the connector, and each publish clears the social-publish consent scope) and will NOT publish during night shift (the post is staged for daytime approval instead).',
    { draftId: z.string().describe('The draft id to publish') },
    async ({ draftId }) => {
      try {
        const { ok, data } = await connectorActionApi(
          dependencies,
          `actions/${encodeURIComponent(draftId)}/commit`,
          'POST',
        );
        if (!ok) {
          const message = String(data.error ?? 'Post publish failed.');
          const hint = /publishing is disabled/i.test(message)
            ? "Ask the user to enable 'Allow publishing' on the connector's settings."
            : undefined;
          return errorResult(message, { ...(hint ? { hint } : {}) });
        }
        if (data.status === 'queued-night-shift') {
          const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
          const summary = `Night shift is active — not publishing unattended. The post is staged in the outbox${relPath ? ` (${relPath})` : ''} and will require explicit approval.`;
          return okResult(
            ActionToolOutputSchema,
            {
              summary,
              status: 'queued-night-shift',
              draftId,
              ...(relPath ? { relPath } : {}),
            },
            { text: summary },
          );
        }
        const result = (data.result ?? {}) as { uri?: string; permalink?: string };
        const summary = `Published.${result.permalink ? ` ${result.permalink}` : result.uri ? ` ${result.uri}` : ''}`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'published',
            draftId,
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`publish_post failed: ${unwrapApiError(err)}`);
      }
    },
  );
}

// ── connectors (write actions) ───────────────────────────────────────────
// Reading a connector's synced data is done by reading its files. This is the
// WRITE path: the gezel can DRAFT an action; committing (the live write) is a
// USER action and is never exposed here (ingest-bound; the mail send tools
// above are the one exception, gated by their daemon-enforced consent scope).
// Registered when the project has bound connectors (GEZEL_CONNECTORS_ENABLED).
export function registerConnectorTools(dependencies: ConnectorActionToolDependencies): void {
  const { server, unwrapApiError } = dependencies;

  server.tool(
    'draft_connector_action',
    'Draft a write action on a bound connector (e.g. post a comment, create an event) for the USER to review and commit. This does NOT execute — committing the live write is a human action you cannot perform. Reading a connector is done by reading its synced files.',
    {
      bindingId: z.string().describe('Connector binding id (see the project Connections)'),
      action: z.string().describe('Action name declared by the connector type'),
      input: z.record(z.string(), z.unknown()).optional().describe('Action payload'),
    },
    async (args) => {
      try {
        const { ok, data } = await connectorActionApi(
          dependencies,
          `${encodeURIComponent(args.bindingId)}/actions`,
          'POST',
          { action: args.action, input: args.input },
        );
        if (!ok) return errorResult(String(data.error ?? 'Connector action draft failed.'));
        const draftId = typeof data.draftId === 'string' ? data.draftId : undefined;
        const relPath = typeof data.relPath === 'string' ? data.relPath : undefined;
        const summary = `Action drafted${draftId ? ` (id: ${draftId})` : ''}${relPath ? ` at ${relPath}` : ''}. The user reviews and commits it — you cannot commit it yourself.`;
        return okResult(
          ActionToolOutputSchema,
          {
            summary,
            status: 'drafted',
            ...(draftId ? { draftId } : {}),
            ...(relPath ? { relPath } : {}),
          },
          { text: summary },
        );
      } catch (err) {
        return errorResult(`draft_connector_action failed: ${unwrapApiError(err)}`);
      }
    },
  );
}
