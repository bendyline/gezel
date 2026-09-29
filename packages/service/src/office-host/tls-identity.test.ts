import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OFFICE_IDENTITY_FILES,
  encodeNameConstraintsDer,
  loadOrCreateOfficeIdentity,
  officeCaLabelForHome,
} from './tls-identity.js';

const DAY = 24 * 60 * 60 * 1000;
let dir: string;

beforeEach(async () => {
  dir =
    process.env.GEZEL_OFFICE_IDENTITY_PROBE_DIR ??
    (await mkdtemp(join(tmpdir(), 'gezel-office-id-')));
});
afterEach(async () => {
  if (!process.env.GEZEL_OFFICE_IDENTITY_PROBE_DIR) await rm(dir, { recursive: true, force: true });
});

describe('encodeNameConstraintsDer', () => {
  it('permits exactly localhost, 127.0.0.1/32 and ::1/128', () => {
    const hex = Buffer.from(encodeNameConstraintsDer()).toString('hex');
    expect(hex).toBe(
      [
        '303f', // NameConstraints SEQUENCE
        'a03d', // [0] permittedSubtrees
        '300b820' + '96c6f63616c686f7374', // dNSName "localhost"
        '300a8708' + '7f000001ffffffff', // iPAddress 127.0.0.1/32
        '30228720' + '00000000000000000000000000000001' + 'ffffffffffffffffffffffffffffffff',
      ].join(''),
    );
  });
});

describe('loadOrCreateOfficeIdentity', () => {
  it('creates a name-constrained CA and a loopback leaf it issued', async () => {
    const id = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    expect(id.caRotated).toBe(true);
    expect(id.leafRotated).toBe(true);

    const ca = new X509Certificate(id.ca.pem);
    const leaf = new X509Certificate(id.leaf.certPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.subjectAltName).toContain('DNS:localhost');
    expect(leaf.subjectAltName).toContain('IP Address:127.0.0.1');
    expect(leaf.subjectAltName).toContain('IP Address:0:0:0:0:0:0:0:1');
    expect(leaf.checkHost('localhost')).toBe('localhost');
    expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(leaf.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);

    const lifetimeDays = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY;
    expect(lifetimeDays).toBeLessThanOrEqual(825);

    const parsed = new x509.X509Certificate(id.ca.pem);
    const nc = parsed.getExtension('2.5.29.30');
    expect(nc?.critical).toBe(true);
    expect(Buffer.from(nc!.value).equals(Buffer.from(encodeNameConstraintsDer()))).toBe(true);
    expect(id.ca.commonName).toBe('Gezel Office Local CA (test)');
    expect(id.ca.sha1Hex).toMatch(/^[0-9a-f]{40}$/);
    expect(id.leaf.fingerprintBase64).toBe(
      Buffer.from(id.leaf.sha256Hex, 'hex').toString('base64'),
    );
  });

  it.runIf(process.platform !== 'win32')('writes private keys 0600', async () => {
    await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    expect((await stat(join(dir, OFFICE_IDENTITY_FILES.caKey))).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, OFFICE_IDENTITY_FILES.leafKey))).mode & 0o777).toBe(0o600);
  });

  it('is idempotent', async () => {
    const first = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    const second = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    expect(second.caRotated).toBe(false);
    expect(second.leafRotated).toBe(false);
    expect(second.ca.sha256Hex).toBe(first.ca.sha256Hex);
    expect(second.leaf.sha256Hex).toBe(first.leaf.sha256Hex);
  });

  it('renews the leaf near expiry without touching the root the user trusted', async () => {
    const now = new Date();
    const first = await loadOrCreateOfficeIdentity({ dir, label: 'test', now });
    const later = new Date(now.getTime() + 750 * DAY);
    const renewed = await loadOrCreateOfficeIdentity({ dir, label: 'test', now: later });
    expect(renewed.caRotated).toBe(false);
    expect(renewed.leafRotated).toBe(true);
    expect(renewed.ca.sha256Hex).toBe(first.ca.sha256Hex);
    expect(renewed.leaf.sha256Hex).not.toBe(first.leaf.sha256Hex);
  });

  it('replaces the whole identity when the CA key is gone', async () => {
    const first = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    await unlink(join(dir, OFFICE_IDENTITY_FILES.caKey));
    const next = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
    expect(next.caRotated).toBe(true);
    expect(next.leafRotated).toBe(true);
    expect(next.ca.sha256Hex).not.toBe(first.ca.sha256Hex);
  });

  it('re-issues a leaf that some other CA signed', async () => {
    const other = await mkdtemp(join(tmpdir(), 'gezel-office-other-'));
    try {
      await loadOrCreateOfficeIdentity({ dir, label: 'test' });
      await loadOrCreateOfficeIdentity({ dir: other, label: 'other' });
      const { writeFile } = await import('node:fs/promises');
      for (const f of [OFFICE_IDENTITY_FILES.leafCert, OFFICE_IDENTITY_FILES.leafKey]) {
        await writeFile(join(dir, f), await readFile(join(other, f), 'utf8'));
      }
      const fixed = await loadOrCreateOfficeIdentity({ dir, label: 'test' });
      expect(fixed.caRotated).toBe(false);
      expect(fixed.leafRotated).toBe(true);
      const ca = new X509Certificate(fixed.ca.pem);
      expect(new X509Certificate(fixed.leaf.certPem).verify(ca.publicKey)).toBe(true);
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('officeCaLabelForHome', () => {
  it('is short and stable', () => {
    expect(officeCaLabelForHome('/Users/me/.gezel')).toBe(officeCaLabelForHome('/Users/me/.gezel'));
    expect(officeCaLabelForHome('/Users/me/.gezel')).toMatch(/^[0-9a-f]{8}$/);
  });
});
