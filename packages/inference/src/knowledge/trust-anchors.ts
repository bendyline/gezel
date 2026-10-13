/**
 * Trust-anchor resolution for signed knowledge registries: the anchors
 * BUILT INTO the app plus an operator/test overlay from
 * `GEZEL_KNOWLEDGE_TRUST_ANCHORS` (a JSON file of KnowledgeTrustAnchor
 * rows). The overlay can only ADD trust — built-ins are never removed by
 * configuration, so a hostile env cannot silently blind verification of
 * the shipped publisher.
 */

import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import type { KnowledgeTrustAnchor } from '@bendyline/gezel-knowledge';
import { BUILTIN_KNOWLEDGE_TRUST_ANCHORS } from '@bendyline/gezel-knowledge';

const log = createLogger('knowledge');

export const KNOWLEDGE_TRUST_ANCHORS_ENV = 'GEZEL_KNOWLEDGE_TRUST_ANCHORS';

export function loadKnowledgeTrustAnchors(
  env: NodeJS.ProcessEnv = process.env,
): KnowledgeTrustAnchor[] {
  const anchors: KnowledgeTrustAnchor[] = [...BUILTIN_KNOWLEDGE_TRUST_ANCHORS];
  const overlayPath = env[KNOWLEDGE_TRUST_ANCHORS_ENV]?.trim();
  if (!overlayPath) return anchors;
  if (!isAbsolute(overlayPath)) {
    log.warn(`${KNOWLEDGE_TRUST_ANCHORS_ENV} must be an absolute path; ignoring ${overlayPath}`);
    return anchors;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(overlayPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    const overlay: KnowledgeTrustAnchor[] = [];
    for (const row of parsed) {
      if (
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { keyId?: unknown }).keyId === 'string' &&
        typeof (row as { publicKeyPem?: unknown }).publicKeyPem === 'string'
      ) {
        const anchor = row as { keyId: string; publicKeyPem: string; publisherId?: unknown };
        overlay.push({
          keyId: anchor.keyId,
          publicKeyPem: anchor.publicKeyPem,
          ...(typeof anchor.publisherId === 'string' ? { publisherId: anchor.publisherId } : {}),
        });
      } else {
        throw new Error('every row needs string keyId + publicKeyPem');
      }
    }
    anchors.push(...overlay);
  } catch (err) {
    log.warn(
      `ignoring ${KNOWLEDGE_TRUST_ANCHORS_ENV} overlay at ${overlayPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return anchors;
}
