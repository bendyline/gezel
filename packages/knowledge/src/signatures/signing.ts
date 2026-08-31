/**
 * Manifest signing (gezk-format-v1.md §7): Ed25519 over the RFC 8785
 * canonical form of the manifest WITHOUT its `signature` field. Key
 * encodings follow the repo's identity conventions (remotes/identity.ts):
 * SPKI/PKCS#8 PEM, base64 signatures, node:crypto one-shot sign/verify.
 * The private key never appears in CI — signing is a manual workstation
 * step (the plan's key-custody stance); verification is what ships.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from 'node:crypto';
import type { KnowledgeCatalogManifest, KnowledgeRegistryIndex } from '@bendyline/gezel';
import { canonicalizeJson } from './jcs.js';

export interface KnowledgeTrustAnchor {
  keyId: string;
  publicKeyPem: string;
  /** Display-only: whose key this is (e.g. `qualla`). */
  publisherId?: string;
}

export type ManifestSignatureVerdict =
  | { ok: true; keyId: string }
  | { ok: false; reason: 'unsigned' | 'unknown-key' | 'bad-signature' | 'error'; detail?: string };

/** Stable key identity: first 16 hex chars of SHA-256 over the SPKI DER. */
export function knowledgeKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateKnowledgeSigningKeyPair(): {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicKeyPem,
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyId: knowledgeKeyId(publicKeyPem),
  };
}

/** The exact bytes the signature covers: JCS(manifest minus `signature`). */
export function manifestSigningPayload(manifest: KnowledgeCatalogManifest): Buffer {
  const { signature: _omitted, ...unsigned } = manifest;
  return Buffer.from(canonicalizeJson(unsigned), 'utf8');
}

export function signManifest(
  manifest: KnowledgeCatalogManifest,
  privateKeyPem: string,
): KnowledgeCatalogManifest {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const value = cryptoSign(null, manifestSigningPayload(manifest), key).toString('base64');
  return {
    ...manifest,
    signature: {
      algorithm: 'ed25519',
      keyId: knowledgeKeyId(publicKeyPem),
      canonicalization: 'rfc8785',
      value,
    },
  };
}

/**
 * Verify against keyId-indexed trust anchors. Key rotation = overlapping
 * anchors for one publisher; an unknown keyId is a hard failure, never a
 * fallback scan across anchors.
 */
export function verifyManifestSignature(
  manifest: KnowledgeCatalogManifest,
  anchors: readonly KnowledgeTrustAnchor[],
): ManifestSignatureVerdict {
  return verifySignedDocument(manifest, anchors);
}

/**
 * The publisher registry (`_knowledge/registry/index.json`) signs with the
 * same discipline as a catalog manifest: Ed25519 over JCS(document minus
 * `signature`). The signing side lives in Qualla's release command; readers
 * (the machine broker's resolver, Settings → available catalogs) verify.
 */
export function signRegistryIndex(
  index: KnowledgeRegistryIndex,
  privateKeyPem: string,
): KnowledgeRegistryIndex {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
  const { signature: _omitted, ...unsigned } = index;
  const value = cryptoSign(null, Buffer.from(canonicalizeJson(unsigned), 'utf8'), key).toString(
    'base64',
  );
  return {
    ...index,
    signature: {
      algorithm: 'ed25519',
      keyId: knowledgeKeyId(publicKeyPem),
      canonicalization: 'rfc8785',
      value,
    },
  };
}

export function verifyRegistryIndex(
  index: KnowledgeRegistryIndex,
  anchors: readonly KnowledgeTrustAnchor[],
): ManifestSignatureVerdict {
  return verifySignedDocument(index, anchors);
}

function verifySignedDocument(
  document: {
    signature?: { algorithm: 'ed25519'; keyId: string; canonicalization: 'rfc8785'; value: string };
  },
  anchors: readonly KnowledgeTrustAnchor[],
): ManifestSignatureVerdict {
  const signature = document.signature;
  if (!signature) return { ok: false, reason: 'unsigned' };
  const anchor = anchors.find((a) => a.keyId === signature.keyId);
  if (!anchor) {
    return { ok: false, reason: 'unknown-key', detail: `no trust anchor for ${signature.keyId}` };
  }
  try {
    if (knowledgeKeyId(anchor.publicKeyPem) !== signature.keyId) {
      return { ok: false, reason: 'unknown-key', detail: 'anchor keyId does not match its key' };
    }
    const { signature: _omitted, ...unsigned } = document;
    const ok = cryptoVerify(
      null,
      Buffer.from(canonicalizeJson(unsigned), 'utf8'),
      createPublicKey(anchor.publicKeyPem),
      Buffer.from(signature.value, 'base64'),
    );
    return ok ? { ok: true, keyId: signature.keyId } : { ok: false, reason: 'bad-signature' };
  } catch (err) {
    return { ok: false, reason: 'error', detail: err instanceof Error ? err.message : String(err) };
  }
}
