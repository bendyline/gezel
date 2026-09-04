import { createHash } from 'node:crypto';

/**
 * Content hash of a craftbook's `test.json` for recording provenance
 * (`RunRecordingProvenance.testSpecHash`).
 *
 * Hashed over CANONICAL JSON — object keys sorted recursively, no
 * whitespace — so gilde's `format.mjs` re-indenting a spec never
 * false-flags every recording as stale. Only a change to the spec's
 * actual content moves the hash.
 *
 * Shared by the catalog accessor's staleness computation, the
 * marketing-run pipeline's provenance stamp, and MIRRORED (keep in
 * sync) by gilde's `tools/validate.mjs` recording check — the
 * artifact-surface.ts precedent for a constant both repos must agree
 * on. The name deliberately avoids "sha256": gilde validate's
 * deep-scan sha256 rule must not treat it as a pinned-download hash.
 */
export function canonicalTestSpecHash(rawTestJson: unknown): string {
  return createHash('sha256').update(canonicalJson(rawTestJson)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const body = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${body.join(',')}}`;
}
