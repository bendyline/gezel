/**
 * Manifest signing (the gezk spec §12): Ed25519 over the RFC 8785
 * canonical form of the manifest WITHOUT its `signature` field. Public keys
 * are SPKI PEM, private keys PKCS#8 PEM, signatures base64, all via
 * node:crypto's one-shot sign/verify.
 *
 * Signing and verification are deliberately separable: a publisher signs on a
 * workstation that holds the private key, and every reader ships only the
 * verification half, so a release pipeline never needs custody of the key.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { canonicalizeJson } from '../jcs.js';
import type { KnowledgeCatalogManifest } from '../schemas/manifest.js';
import type { KnowledgeRegistryIndex } from '../schemas/registry.js';

export interface KnowledgeTrustAnchor {
  keyId: string;
  publicKeyPem: string;
  /** Display-only: whose key this is. */
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
export function manifestSigningPayload(manifest: KnowledgeCatalogManifest): Uint8Array {
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
 * `signature`). Publishers sign it as the last step of a release; readers
 * verify it before trusting any archive it advertises.
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
