/**
 * Severity gate for `npm audit --json` over the clean npm-consumer install in
 * check-package-consumers.mjs.
 *
 * WHY a separate module: the consumer check does all of its work at import
 * time, so its decision logic could not be tested. The allowlist is the
 * pressure valve that makes a `high` threshold livable: an advisory that is
 * genuinely unreachable can be accepted with a written reason and an expiry,
 * instead of lowering the gate back to `critical` for everything.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

export const AUDIT_ALLOWLIST_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'npm-consumer-audit-allowlist.json',
);

/**
 * @typedef {{ id: string, reason: string, expires: string }} AllowlistEntry
 * @typedef {{ id: string, severity: string, pkg: string, title: string }} Advisory
 */

/** @returns {AllowlistEntry[]} */
export function readAuditAllowlist(path = AUDIT_ALLOWLIST_PATH) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const entries = Array.isArray(parsed?.advisories) ? parsed.advisories : [];
  for (const entry of entries) {
    if (!entry?.id || !entry?.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry?.expires ?? '')) {
      throw new Error(
        `${path}: every allowlist entry needs an advisory id, a reason, and an expires date (YYYY-MM-DD)`,
      );
    }
  }
  return entries;
}

/**
 * Advisories at high or critical severity that no unexpired allowlist entry
 * covers. Advisory ids come from the GHSA URL npm reports.
 *
 * @param {any} report parsed `npm audit --json`
 * @param {AllowlistEntry[]} allowlist
 * @param {Date} [now]
 * @returns {Advisory[]}
 */
export function blockingAdvisories(report, allowlist, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const accepted = new Set(allowlist.filter((e) => e.expires >= today).map((e) => e.id));
  const found = new Map();
  for (const [pkg, vulnerability] of Object.entries(report?.vulnerabilities ?? {})) {
    for (const via of vulnerability?.via ?? []) {
      // String entries point at another package's advisory; the object form
      // is the advisory itself, reported under the package it affects.
      if (typeof via !== 'object' || via === null) continue;
      if (!BLOCKING.has(via.severity)) continue;
      const id = /GHSA-[\w-]+/i.exec(String(via.url ?? ''))?.[0] ?? String(via.source ?? via.title);
      if (accepted.has(id)) continue;
      found.set(`${id}:${pkg}`, {
        id,
        severity: via.severity,
        pkg,
        title: String(via.title ?? ''),
      });
    }
  }
  return [...found.values()];
}
