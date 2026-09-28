/**
 * Consent enforcement for connector write actions. Every action a type
 * declares names a `consentScope`; committing the action clears that scope's
 * registered enforcer or is denied — deny-by-default in every direction: no
 * declared scope, no registered enforcer, or an enforcer that says no all
 * refuse the commit. The daemon enforces this; the model cannot widen it.
 *
 * The first scope, `recipient-allowlist`, generalizes mail's outbox gate:
 * transmission is permitted only to addresses/domains the user explicitly
 * allowlisted on the binding. No allowlist → nothing transmits, so a
 * prompt-injected agent cannot exfiltrate through a connector action.
 */

import type { ProjectConnectorBinding, ProjectDetail } from '@bendyline/gezel';
import { canonicalRecipients, parseRecipient, recipientEntries } from '../mail/recipient.js';

export interface ConsentContext {
  project: ProjectDetail;
  binding: ProjectConnectorBinding;
  action: string;
  /** The action draft's frontmatter. */
  data: Record<string, string>;
  /** The action draft's parsed body (the action input). */
  input: unknown;
}

/**
 * `input`, when present, replaces the draft's input for the commit: an
 * enforcer that normalized what it checked hands the adapter exactly that,
 * so no second parser downstream can read the draft differently.
 */
export type ConsentVerdict = { ok: true; input?: unknown } | { ok: false; reason: string };
export type ConsentEnforcer = (ctx: ConsentContext) => ConsentVerdict | Promise<ConsentVerdict>;

const enforcers = new Map<string, ConsentEnforcer>();

export function registerConsentEnforcer(scope: string, enforcer: ConsentEnforcer): void {
  enforcers.set(scope, enforcer);
}

/** Resolve + run the enforcer for a scope. Unknown or missing scope = deny. */
export async function enforceConsent(
  scope: string | undefined,
  ctx: ConsentContext,
): Promise<ConsentVerdict> {
  if (!scope) {
    return { ok: false, reason: 'action declares no consent scope; commits are denied' };
  }
  const enforcer = enforcers.get(scope);
  if (!enforcer) {
    return { ok: false, reason: `no enforcer registered for consent scope '${scope}'` };
  }
  return enforcer(ctx);
}

export interface RecipientAllowlist {
  allowedRecipients?: string[];
  allowedDomains?: string[];
}

/** True when `address` (already a bare address) is on an explicit recipient/domain allowlist. */
function addressAllowedBy(address: string, allowlist: RecipientAllowlist): boolean {
  const email = address.toLowerCase();
  const recipients = (allowlist.allowedRecipients ?? []).map((a) => a.trim().toLowerCase());
  if (recipients.includes(email)) return true;
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const domains = (allowlist.allowedDomains ?? []).map((d) =>
    d.trim().toLowerCase().replace(/^@/, ''),
  );
  return domain.length > 0 && domains.includes(domain);
}

/**
 * True when the recipient entry names exactly one address and that address
 * is permitted by an explicit recipient/domain allowlist.
 */
export function recipientAllowedBy(entry: unknown, allowlist: RecipientAllowlist): boolean {
  const parsed = parseRecipient(entry);
  return parsed.ok && addressAllowedBy(parsed.address, allowlist);
}

const splitList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const RECIPIENT_FIELDS = ['to', 'cc', 'bcc'] as const;

/**
 * Every recipient entry an action draft names: the mail-shaped frontmatter
 * fields AND the `to`/`cc`/`bcc` fields on the JSON input. Both are checked
 * because the draft file is writable in the corpus; checking only one of them
 * would let the other carry an address past the allowlist.
 */
export function draftRecipients(data: Record<string, string>, input: unknown): unknown[] {
  const entries: unknown[] = RECIPIENT_FIELDS.flatMap((field) => splitList(data[field]));
  if (input !== null && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const field of RECIPIENT_FIELDS) entries.push(...recipientEntries(o[field]));
  }
  return entries;
}

/** Binding-config allowlist for the `recipient-allowlist` scope. */
function bindingAllowlist(binding: ProjectConnectorBinding): RecipientAllowlist {
  const cfg = (binding.config ?? {}) as {
    allowedRecipients?: unknown;
    allowedDomains?: unknown;
  };
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  return {
    allowedRecipients: strings(cfg.allowedRecipients),
    allowedDomains: strings(cfg.allowedDomains),
  };
}

registerConsentEnforcer('recipient-allowlist', (ctx) => {
  const recipients = draftRecipients(ctx.data, ctx.input);
  if (!recipients.length) {
    return { ok: false, reason: 'the draft names no recipients' };
  }
  const malformed: string[] = [];
  for (const entry of recipients) {
    const parsed = parseRecipient(entry);
    if (!parsed.ok) malformed.push(`${JSON.stringify(entry)} (${parsed.reason})`);
  }
  if (malformed.length) {
    return {
      ok: false,
      reason: `recipient(s) must each be one plain email address: ${malformed.join(', ')}`,
    };
  }
  const allowlist = bindingAllowlist(ctx.binding);
  const blocked = recipients.filter((r) => !recipientAllowedBy(r, allowlist));
  if (blocked.length) {
    return {
      ok: false,
      reason: `recipient(s) not on the binding's allowlist: ${blocked.join(', ')}. Add them to the connector's allowed recipients or domains first.`,
    };
  }
  return { ok: true, input: withCanonicalRecipients(ctx.input) };
});

/** The input with each recipient field replaced by the bare addresses the enforcer checked. */
function withCanonicalRecipients(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const field of RECIPIENT_FIELDS) {
    if (out[field] === undefined || out[field] === null) continue;
    out[field] = canonicalRecipients(recipientEntries(out[field]));
  }
  return out;
}

/** Cheap shape gate for a draft's `images`; byte-level checks (existence,
 *  size, mime) stay in the adapter's `runAction`. */
function malformedImagesReason(input: unknown): string | undefined {
  const images = (input as { images?: unknown }).images;
  if (images === undefined || images === null) return undefined;
  if (!Array.isArray(images)) {
    return "the draft's images must be an array of { path, alt } entries";
  }
  if (images.length > 4) {
    return `the draft attaches ${images.length} images; the maximum is 4`;
  }
  const bad = images.findIndex((entry) => {
    const path = (entry as { path?: unknown } | null)?.path;
    return typeof path !== 'string' || !path.trim();
  });
  if (bad !== -1) {
    return `the draft's images[${bad}] has no string path; each image needs a project-relative path`;
  }
  return undefined;
}

/**
 * `social-publish` gates social-post write-back (Bluesky today; X/Instagram
 * follow the same scope). Publishing is off by default: the binding's owner
 * must flip `allowPublish` on the connector's settings before any commit
 * transmits, and an empty draft never does. Platform-specific validation
 * (length limits, reply threading, image bytes) stays in the adapter's
 * `runAction`; only the images *shape* is rejected here so a malformed draft
 * fails before the outbox ever accepts it.
 */
registerConsentEnforcer('social-publish', (ctx) => {
  const cfg = (ctx.binding.config ?? {}) as { allowPublish?: unknown };
  if (cfg.allowPublish !== true) {
    return {
      ok: false,
      reason:
        "publishing is disabled on this connector. Ask the user to enable 'Allow publishing' in the connector's settings first.",
    };
  }
  const text =
    ctx.input !== null && typeof ctx.input === 'object'
      ? (ctx.input as { text?: unknown }).text
      : undefined;
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'the draft has no post text' };
  }
  const imagesReason = malformedImagesReason(ctx.input);
  if (imagesReason) return { ok: false, reason: imagesReason };
  return { ok: true };
});

// `manual-export` deliberately has NO registered enforcer: enforceConsent's
// deny-by-default turns every commit into "no enforcer registered", so a
// manifest that declares it produces drafts that can only leave through the
// human — draft_post stays reviewable, the daemon never transmits. The
// original users (x-posts, instagram-media) have since graduated to real
// `social-publish` write-back; the scope remains the honest default for any
// future platform whose write API gezel cannot or should not drive.
