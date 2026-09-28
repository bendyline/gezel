/**
 * One recipient entry to one bare address, parsed by nodemailer's own
 * addressparser — the parser that builds the SMTP envelope. The recipient
 * allowlist and every mail transport read addresses through here, so the
 * address that is checked is the address that is sent.
 *
 * A regex over the first `<…>` is not enough: in
 * `"<ok@trusted.com>" <attacker@evil.com>` the first `<…>` sits inside a
 * quoted display name, and nodemailer delivers to attacker@evil.com.
 */

import addressparser from 'nodemailer/lib/addressparser/index.js';

export type RecipientParse = { ok: true; address: string } | { ok: false; reason: string };

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// Dot-atom only. A quoted local part comes back from the parser unquoted, so
// `"a,b"@x.com` would re-parse as two addresses at the transport.
const LOCAL_PART = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+(?:\.[\p{L}\p{N}!#$%&'*+/=?^_`{|}~-]+)*$/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

/**
 * Parse one recipient entry (`addr` or `Name <addr>`). Anything that is not
 * exactly one plain address is refused rather than guessed at: groups, lists,
 * empty entries, quoted local parts, control characters, and display names
 * that themselves look like addresses.
 */
export function parseRecipient(entry: unknown): RecipientParse {
  if (typeof entry !== 'string') return { ok: false, reason: 'recipient entries must be strings' };
  if (!entry.trim()) return { ok: false, reason: 'empty recipient' };
  if (CONTROL_CHARS.test(entry)) {
    return { ok: false, reason: 'recipient contains control characters' };
  }
  const parsed = addressparser(entry);
  if (parsed.length !== 1) {
    return { ok: false, reason: 'each recipient entry must name exactly one address' };
  }
  const only = parsed[0]!;
  if ('group' in only) return { ok: false, reason: 'address groups are not allowed' };
  const address = only.address.trim();
  if (!address) return { ok: false, reason: 'no email address found' };
  if (/[@<>]/.test(only.name)) {
    return { ok: false, reason: 'display name looks like an address; use a plain address' };
  }
  const at = address.indexOf('@');
  if (at <= 0 || at !== address.lastIndexOf('@')) {
    return { ok: false, reason: 'not a plain email address' };
  }
  const local = address.slice(0, at);
  const labels = address.slice(at + 1).split('.');
  if (
    !LOCAL_PART.test(local) ||
    labels.length < 2 ||
    !labels.every((label) => DOMAIN_LABEL.test(label))
  ) {
    return { ok: false, reason: 'not a plain email address' };
  }
  return { ok: true, address };
}

/** A recipient field (`to`/`cc`/`bcc`) as entries: one string or an array. */
export function recipientEntries(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Bare addresses for every entry; throws on the first one that is not exactly one address. */
export function canonicalRecipients(entries: readonly unknown[]): string[] {
  return entries.map((entry) => {
    const parsed = parseRecipient(entry);
    if (!parsed.ok) throw new Error(`invalid recipient ${JSON.stringify(entry)}: ${parsed.reason}`);
    return parsed.address;
  });
}
