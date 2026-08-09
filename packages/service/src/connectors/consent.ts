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

export interface ConsentContext {
  project: ProjectDetail;
  binding: ProjectConnectorBinding;
  action: string;
  /** The action draft's frontmatter. */
  data: Record<string, string>;
  /** The action draft's parsed body (the action input). */
  input: unknown;
}

export type ConsentVerdict = { ok: true } | { ok: false; reason: string };
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

/** Extract the bare email address from a `Name <addr>` or `addr` string. */
export function extractEmail(addr: string): string {
  const m = /<([^>]+)>/.exec(addr);
  return (m ? m[1]! : addr).trim().toLowerCase();
}

export interface RecipientAllowlist {
  allowedRecipients?: string[];
  allowedDomains?: string[];
}

/** True when `addr` is permitted by an explicit recipient/domain allowlist. */
export function recipientAllowedBy(addr: string, allowlist: RecipientAllowlist): boolean {
  const email = extractEmail(addr);
  if (!email || !email.includes('@')) return false;
  const recipients = (allowlist.allowedRecipients ?? []).map((a) => a.toLowerCase());
  if (recipients.includes(email)) return true;
  const domain = email.split('@')[1] ?? '';
  const domains = (allowlist.allowedDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  return domain.length > 0 && domains.includes(domain);
}

const splitList = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * Recipients named by an action draft: the mail-shaped frontmatter fields
 * when present, else `to`/`cc`/`bcc` arrays on the JSON input.
 */
export function draftRecipients(data: Record<string, string>, input: unknown): string[] {
  const fromFrontmatter = [...splitList(data.to), ...splitList(data.cc), ...splitList(data.bcc)];
  if (fromFrontmatter.length) return fromFrontmatter;
  if (input !== null && typeof input === 'object') {
    const o = input as { to?: unknown; cc?: unknown; bcc?: unknown };
    return [o.to, o.cc, o.bcc]
      .flatMap((v) => (Array.isArray(v) ? v : typeof v === 'string' ? [v] : []))
      .filter((v): v is string => typeof v === 'string');
  }
  return [];
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
  const allowlist = bindingAllowlist(ctx.binding);
  const blocked = recipients.filter((r) => !recipientAllowedBy(r, allowlist));
  if (blocked.length) {
    return {
      ok: false,
      reason: `recipient(s) not on the binding's allowlist: ${blocked.join(', ')}. Add them to the connector's allowed recipients or domains first.`,
    };
  }
  return { ok: true };
});
