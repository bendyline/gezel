/**
 * Built-in trust anchors for signed knowledge registries and catalogs.
 *
 * Empty until the Qualla production keypair exists: the private key is
 * generated OFFLINE on a workstation (`sign-knowledge-release --generate-key`)
 * and its `.pub` lands here — pasted into a normal reviewed release, never
 * fetched at runtime. Rotation = overlapping keyIds across an app release:
 * add the new anchor, keep the old one until every registry consumers care
 * about is re-signed, then remove it.
 *
 * Operators and tests extend the set without a release via
 * `GEZEL_KNOWLEDGE_TRUST_ANCHORS` (a JSON file of KnowledgeTrustAnchor rows),
 * which the service layers ON TOP of these — it can add trust, not veto it.
 */

import type { KnowledgeTrustAnchor } from './signing.js';

export const BUILTIN_KNOWLEDGE_TRUST_ANCHORS: readonly KnowledgeTrustAnchor[] = [];
