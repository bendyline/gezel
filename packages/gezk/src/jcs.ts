/**
 * RFC 8785 (JSON Canonicalization Scheme) serializer — the byte-exact input
 * to the manifest's Ed25519 signature (the gezk spec §12). ECMAScript's
 * own JSON.stringify already implements the RFC's number and string
 * serialization; canonicalization adds only (a) object keys sorted by UTF-16
 * code units and (b) a hard rejection of anything without a JSON identity
 * (undefined, functions, non-finite numbers, BigInt).
 */

export function canonicalizeJson(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`non-finite number at ${path}`);
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`value of type ${typeof value} at ${path} has no JSON identity`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => serialize(item ?? null, `${path}[${i}]`)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => compareUtf16(a, b));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${serialize(v, `${path}.${k}`)}`)
    .join(',')}}`;
}

/** RFC 8785 §3.2.3: sort keys by UTF-16 code units. */
function compareUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a.charCodeAt(i) as number) - (b.charCodeAt(i) as number);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
