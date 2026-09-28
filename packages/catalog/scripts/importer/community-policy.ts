import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** One rule a community entry broke, as gilde's policy reports it. */
export interface CommunityPolicyViolation {
  rule: string;
  detail: string;
}

/** The identity + version manifests of one toolset, shaped like gilde's on-disk layout. */
export interface CommunityPolicyEntry {
  identity: unknown;
  versions: unknown[];
}

export type CommunityPolicy = (entry: CommunityPolicyEntry) => CommunityPolicyViolation | null;

/** Where gilde keeps the policy, relative to its checkout root. */
export const COMMUNITY_POLICY_MODULE = join('tools', 'lib', 'community-policy.mjs');

/**
 * Load the community content policy from the gilde checkout the importer
 * writes into.
 *
 * The policy is owned by gilde, not vendored here: its validate.mjs fails CI
 * on the same rules and its `npm run fix` prunes by them, so a second copy in
 * this repo would be one more place for the three to drift. Returns null for
 * a checkout that predates the policy — the import then proceeds unfiltered
 * and gilde's own prune/validate still catch the result.
 */
export async function loadCommunityPolicy(gildeRoot: string): Promise<CommunityPolicy | null> {
  const modulePath = join(gildeRoot, COMMUNITY_POLICY_MODULE);
  if (!existsSync(modulePath)) return null;
  const mod = (await import(pathToFileURL(modulePath).href)) as {
    communityPolicyViolation?: unknown;
  };
  if (typeof mod.communityPolicyViolation !== 'function') {
    throw new Error(`${modulePath} does not export communityPolicyViolation`);
  }
  return mod.communityPolicyViolation as CommunityPolicy;
}
