/**
 * Outbound storage + the recipient allowlist — the authoritative send gate.
 *
 * Drafts the agent writes live under `<mailDir>/_drafts/`, staged sends under
 * `_outbox/`, and transmitted receipts under `_sent/`. The draft file IS the
 * human review surface. Sending is allowed ONLY to addresses/domains the user
 * explicitly allowlisted on the project — with no allowlist, nothing can be
 * sent (deny-by-default), so a prompt-injected agent can't exfiltrate by email.
 */

import type { ProjectMail } from '@bendyline/gezel';
import { type OutboxStatus, newDraftId, stagingFrontmatter } from '../connectors/outbox.js';

export { newDraftId };

export interface DraftEmailInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Message-ID this is a reply to (threads the send). */
  inReplyTo?: string;
  threadId?: string;
  /** Which linked account to send from (defaults to the first). */
  accountId?: string;
}

/** Extract the bare email address from a `Name <addr>` or `addr` string. */
export function extractEmail(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return (m ? m[1]! : addr).trim().toLowerCase();
}

/** True when `addr` is permitted by the project's recipient allowlist. */
export function recipientAllowed(addr: string, mail: ProjectMail | undefined): boolean {
  const email = extractEmail(addr);
  if (!email || !email.includes('@')) return false;
  const allowedRecipients = (mail?.allowedRecipients ?? []).map((a) => a.toLowerCase());
  if (allowedRecipients.includes(email)) return true;
  const domain = email.split('@')[1] ?? '';
  const allowedDomains = (mail?.allowedDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  return domain.length > 0 && allowedDomains.includes(domain);
}

/** Recipients (to/cc/bcc) not permitted by the allowlist. */
export function disallowedRecipients(
  recipients: { to: string[]; cc?: string[]; bcc?: string[] },
  mail: ProjectMail | undefined,
): string[] {
  const all = [...recipients.to, ...(recipients.cc ?? []), ...(recipients.bcc ?? [])];
  return all.filter((r) => !recipientAllowed(r, mail));
}

/** Frontmatter for a draft/outbox/sent file. */
export function draftFrontmatter(
  input: DraftEmailInput,
  status: OutboxStatus,
  extra: Record<string, string> = {},
): Record<string, string> {
  const fields: Record<string, string> = {
    to: input.to.join(', '),
    ...(input.cc?.length ? { cc: input.cc.join(', ') } : {}),
    ...(input.bcc?.length ? { bcc: input.bcc.join(', ') } : {}),
    subject: input.subject,
    ...(input.inReplyTo ? { in_reply_to: input.inReplyTo } : {}),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
    ...(input.accountId ? { account: input.accountId } : {}),
  };
  return stagingFrontmatter(fields, status, extra);
}

const splitList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Reconstruct a DraftEmailInput from a draft file's frontmatter + body. */
export function draftFromFrontmatter(data: Record<string, string>, body: string): DraftEmailInput {
  return {
    to: splitList(data.to),
    ...(data.cc ? { cc: splitList(data.cc) } : {}),
    ...(data.bcc ? { bcc: splitList(data.bcc) } : {}),
    subject: data.subject ?? '',
    body,
    ...(data.in_reply_to ? { inReplyTo: data.in_reply_to } : {}),
    ...(data.thread_id ? { threadId: data.thread_id } : {}),
    ...(data.account ? { accountId: data.account } : {}),
  };
}
