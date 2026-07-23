import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const exePath = fileURLToPath(new URL('../installer/nssm/nssm.exe', import.meta.url));
const readmePath = fileURLToPath(new URL('../installer/nssm/README.md', import.meta.url));
const fetchScriptPath = fileURLToPath(new URL('../scripts/fetch-nssm.mjs', import.meta.url));

// nssm.exe is vendored deliberately (see installer/nssm/README.md). The
// committed bytes, the fetch-script pin, and the README's provenance
// record must agree — a mismatch means the binary was swapped without an
// intentional bump, which release CI would also refuse.
describe('vendored nssm.exe', () => {
  const pin = readFileSync(fetchScriptPath, 'utf8').match(
    /NSSM_EXE_SHA256 = '([0-9a-f]{64})'/,
  )?.[1];

  it('declares a sha256 pin in fetch-nssm.mjs', () => {
    expect(pin).toBeDefined();
  });

  it('matches the pinned sha256 byte-for-byte', () => {
    const sha = createHash('sha256').update(readFileSync(exePath)).digest('hex');
    expect(sha).toBe(pin);
  });

  it('is documented with the same hash in the README', () => {
    expect(readFileSync(readmePath, 'utf8')).toContain(pin ?? 'missing-pin');
  });
});
