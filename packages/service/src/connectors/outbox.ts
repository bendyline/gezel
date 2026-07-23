/**
 * Generic outbound-staging primitives for connector write-back. A connector
 * action drafts a file under `_drafts/`, stages it to `_outbox/`, and records a
 * receipt to `_sent/`; the draft file IS the human review surface. This module
 * owns the source-agnostic pieces (the draft id + the direction/status
 * frontmatter shape); the per-type record fields + the consent/allowlist gate
 * stay with the connector (mail's recipient allowlist lives in `mail/outbox.ts`).
 *
 * The full action contract (draft→queue→commit, deny-by-default consent scopes,
 * night-shift deferral) generalizes here in Phase 7.
 */

import { randomUUID } from 'node:crypto';

export type OutboxStatus = 'draft' | 'queued' | 'sent';

export function newDraftId(): string {
  return randomUUID();
}

/**
 * Wrap a connector's domain fields with the outbound staging frontmatter
 * (`direction: outbound` + `status`, plus any `extra`), preserving insertion
 * order so the draft/outbox/sent files round-trip byte-stably.
 */
export function stagingFrontmatter(
  fields: Record<string, string>,
  status: OutboxStatus,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...fields, direction: 'outbound', status, ...extra };
}
