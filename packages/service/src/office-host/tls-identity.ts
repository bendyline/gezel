/**
 * The Office host's TLS identity: a per-user certificate authority that may
 * only vouch for `localhost` / `127.0.0.1` / `::1`, and a leaf it issues for
 * the Office listener.
 *
 * Why not the daemon's per-launch cert (`http/cert.ts`)? Office loads the
 * task pane in WebView2 / WKWebView, which trust only what the OS trust store
 * trusts, and an add-in manifest bakes in one URL. So the Office origin needs
 * a certificate that survives restarts and a root the user installs once.
 * The desktop app installs `ca.pem` into the user's own trust store; this
 * module never touches a trust store.
 *
 * Boundaries, strongest first:
 *   1. The CA private key is 0600 under the user's gezel home and never
 *      leaves it. Anyone who can read it could already read the home.
 *   2. The CA sits in the user's trust store, not the machine's.
 *   3. Name constraints (critical) limit the CA to loopback names, so even a
 *      stolen key cannot mint a certificate for a real site on verifiers
 *      that enforce them (Chromium, Windows CryptoAPI, macOS). Defense in
 *      depth, not the boundary.
 */

import { X509Certificate as NodeX509, createHash, randomBytes, type webcrypto } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as x509 from '@peculiar/x509';
import { writeFileAtomic } from '../fs/atomic.js';
import type { LoopbackCert } from '../http/cert.js';
import { ensurePrivateDir } from '../local-harness/base.js';

x509.cryptoProvider.set(globalThis.crypto);

const DAY_MS = 24 * 60 * 60 * 1000;
/** A root the user installs once should outlive many app versions. */
export const OFFICE_CA_VALIDITY_DAYS = 3650;
/** Apple rejects user-trusted TLS leaves valid for more than 825 days. */
export const OFFICE_LEAF_VALIDITY_DAYS = 800;
export const OFFICE_LEAF_RENEW_BEFORE_DAYS = 60;
export const OFFICE_CA_COMMON_NAME_PREFIX = 'Gezel Office Local CA';

const RSA_SIGNING: webcrypto.RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5',
  hash: 'SHA-256',
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
};

export const OFFICE_IDENTITY_FILES = {
  caCert: 'ca.pem',
  caKey: 'ca.key',
  leafCert: 'leaf.pem',
  leafKey: 'leaf.key',
} as const;

export interface OfficeCaInfo {
  pem: string;
  sha256Hex: string;
  /** Windows certificate stores address certificates by SHA-1 thumbprint. */
  sha1Hex: string;
  commonName: string;
  notAfter: string;
}

export interface OfficeIdentity {
  ca: OfficeCaInfo;
  leaf: LoopbackCert & { notAfter: string };
  caRotated: boolean;
  leafRotated: boolean;
}

// ── DER helpers for the one extension @peculiar/x509 has no class for ──

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length < 0x100) return Uint8Array.of(0x81, length);
  return Uint8Array.of(0x82, length >> 8, length & 0xff);
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * DER for `NameConstraints { permittedSubtrees: [dNSName localhost,
 * iPAddress 127.0.0.1/32, iPAddress ::1/128] }` (RFC 5280 §4.2.1.10).
 */
export function encodeNameConstraintsDer(): Uint8Array {
  const subtree = (base: Uint8Array) => tlv(0x30, base);
  const dnsLocalhost = tlv(0x82, new TextEncoder().encode('localhost'));
  const ipv4Loopback = tlv(0x87, Uint8Array.of(127, 0, 0, 1, 255, 255, 255, 255));
  const ipv6Loopback = tlv(
    0x87,
    concat(new Uint8Array(15), Uint8Array.of(1), new Uint8Array(16).fill(0xff)),
  );
  const permitted = tlv(0xa0, subtree(dnsLocalhost), subtree(ipv4Loopback), subtree(ipv6Loopback));
  return tlv(0x30, permitted);
}

function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f; // keep it positive
  return bytes.toString('hex');
}

async function exportPrivateKeyPem(key: webcrypto.CryptoKey): Promise<string> {
  const pkcs8 = await globalThis.crypto.subtle.exportKey('pkcs8', key);
  return x509.PemConverter.encode(pkcs8, 'PRIVATE KEY');
}

async function importPrivateKeyPem(pem: string): Promise<webcrypto.CryptoKey> {
  const [der] = x509.PemConverter.decode(pem);
  if (!der) throw new Error('private key PEM is empty');
  return globalThis.crypto.subtle.importKey('pkcs8', der, RSA_SIGNING, true, ['sign']);
}

function fingerprints(pem: string): {
  sha256Hex: string;
  sha1Hex: string;
  fingerprintBase64: string;
} {
  const der = new NodeX509(pem).raw;
  const sha256 = createHash('sha256').update(der).digest();
  return {
    sha256Hex: sha256.toString('hex'),
    fingerprintBase64: sha256.toString('base64'),
    sha1Hex: createHash('sha1').update(der).digest('hex'),
  };
}

export interface GeneratedPem {
  certPem: string;
  keyPem: string;
}

/** A name-constrained root. `label` distinguishes homes in the user's trust store. */
export async function generateOfficeCa(opts: { now: Date; label: string }): Promise<GeneratedPem> {
  const keys = await globalThis.crypto.subtle.generateKey(RSA_SIGNING, true, ['sign', 'verify']);
  const name = `CN=${OFFICE_CA_COMMON_NAME_PREFIX} (${opts.label}), O=Gezel`;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name,
    notBefore: new Date(opts.now.getTime() - DAY_MS),
    notAfter: new Date(opts.now.getTime() + OFFICE_CA_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: RSA_SIGNING,
    keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      new x509.Extension('2.5.29.30', true, encodeNameConstraintsDer()),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await exportPrivateKeyPem(keys.privateKey) };
}

/** A loopback server certificate issued by the Office CA. */
export async function issueOfficeLeaf(opts: {
  now: Date;
  ca: GeneratedPem;
}): Promise<GeneratedPem> {
  const caCert = new x509.X509Certificate(opts.ca.certPem);
  const caKey = await importPrivateKeyPem(opts.ca.keyPem);
  const keys = await globalThis.crypto.subtle.generateKey(RSA_SIGNING, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomSerial(),
    subject: 'CN=localhost, O=Gezel',
    issuer: caCert.subject,
    notBefore: new Date(opts.now.getTime() - DAY_MS),
    notAfter: new Date(opts.now.getTime() + OFFICE_LEAF_VALIDITY_DAYS * DAY_MS),
    signingAlgorithm: RSA_SIGNING,
    publicKey: keys.publicKey,
    signingKey: caKey,
    extensions: [
      new x509.BasicConstraintsExtension(false, undefined, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment,
        true,
      ),
      new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], true),
      new x509.SubjectAlternativeNameExtension([
        { type: 'dns', value: 'localhost' },
        { type: 'ip', value: '127.0.0.1' },
        { type: 'ip', value: '::1' },
      ]),
      await x509.AuthorityKeyIdentifierExtension.create(caCert),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { certPem: cert.toString('pem'), keyPem: await exportPrivateKeyPem(keys.privateKey) };
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null);
}

function parsedOrNull(pem: string | null): NodeX509 | null {
  if (!pem) return null;
  try {
    return new NodeX509(pem);
  } catch {
    return null;
  }
}

async function keyMatches(certPem: string, keyPem: string | null): Promise<boolean> {
  if (!keyPem) return false;
  try {
    const { createPrivateKey } = await import('node:crypto');
    return new NodeX509(certPem).checkPrivateKey(createPrivateKey(keyPem));
  } catch {
    return false;
  }
}

function commonNameOf(cert: NodeX509): string {
  const m = /CN=([^\n,]+)/.exec(cert.subject);
  return m?.[1]?.trim() ?? cert.subject;
}

/**
 * Load the identity from `dir`, creating or renewing what is missing.
 *
 * - CA files missing, unreadable, mismatched, or expired → a new CA and leaf
 *   (`caRotated`); the desktop app must install the new root.
 * - Leaf missing, not issued by this CA, expired, or within
 *   `renewBeforeDays` of expiry → a new leaf only (`leafRotated`); the root
 *   the user trusted keeps working.
 */
export async function loadOrCreateOfficeIdentity(opts: {
  dir: string;
  label: string;
  now?: Date;
  renewBeforeDays?: number;
}): Promise<OfficeIdentity> {
  const now = opts.now ?? new Date();
  const renewBefore = (opts.renewBeforeDays ?? OFFICE_LEAF_RENEW_BEFORE_DAYS) * DAY_MS;
  await ensurePrivateDir(opts.dir);
  const path = (name: keyof typeof OFFICE_IDENTITY_FILES) =>
    join(opts.dir, OFFICE_IDENTITY_FILES[name]);

  let caPem = await readOptional(path('caCert'));
  let caKeyPem = await readOptional(path('caKey'));
  let caCert = parsedOrNull(caPem);
  let caRotated = false;
  const caUsable =
    caCert?.ca === true &&
    new Date(caCert.validTo).getTime() > now.getTime() + renewBefore &&
    (await keyMatches(caPem!, caKeyPem));
  if (!caUsable) {
    const fresh = await generateOfficeCa({ now, label: opts.label });
    await writeFileAtomic(path('caKey'), fresh.keyPem, { mode: 0o600, durable: true });
    await writeFileAtomic(path('caCert'), fresh.certPem, { mode: 0o644, durable: true });
    await rm(path('leafCert'), { force: true });
    await rm(path('leafKey'), { force: true });
    caPem = fresh.certPem;
    caKeyPem = fresh.keyPem;
    caCert = new NodeX509(caPem);
    caRotated = true;
  }

  let leafPem = await readOptional(path('leafCert'));
  let leafKeyPem = await readOptional(path('leafKey'));
  const leafCert = parsedOrNull(leafPem);
  const leafUsable =
    leafCert?.checkIssued(caCert!) === true &&
    leafCert!.verify(caCert!.publicKey) &&
    new Date(leafCert!.validTo).getTime() - now.getTime() > renewBefore &&
    (await keyMatches(leafPem!, leafKeyPem));
  let leafRotated = false;
  if (!leafUsable) {
    const fresh = await issueOfficeLeaf({ now, ca: { certPem: caPem!, keyPem: caKeyPem! } });
    await writeFileAtomic(path('leafKey'), fresh.keyPem, { mode: 0o600, durable: true });
    await writeFileAtomic(path('leafCert'), fresh.certPem, { mode: 0o644, durable: true });
    leafPem = fresh.certPem;
    leafKeyPem = fresh.keyPem;
    leafRotated = true;
  }

  const caPrints = fingerprints(caPem!);
  const leafPrints = fingerprints(leafPem!);
  const leafParsed = new NodeX509(leafPem!);
  return {
    ca: {
      pem: caPem!,
      sha256Hex: caPrints.sha256Hex,
      sha1Hex: caPrints.sha1Hex,
      commonName: commonNameOf(caCert!),
      notAfter: new Date(caCert!.validTo).toISOString(),
    },
    leaf: {
      certPem: leafPem!,
      keyPem: leafKeyPem!,
      sha256Hex: leafPrints.sha256Hex,
      fingerprintBase64: leafPrints.fingerprintBase64,
      notAfter: new Date(leafParsed.validTo).toISOString(),
    },
    caRotated,
    leafRotated,
  };
}

/** A short, stable label for this gezel home, so two homes' roots are distinguishable. */
export function officeCaLabelForHome(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 8);
}
