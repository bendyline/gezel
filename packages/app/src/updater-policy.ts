import { SecurityPolicySchema, resolveSecurityPolicy } from '@bendyline/gezel';

export type UpdaterPermission =
  | { allowed: true; reason: 'allowed' }
  | { allowed: false; reason: 'policy-denied' | 'policy-unavailable'; error?: string };

/**
 * Resolve updater authorization without conflating two materially different
 * states:
 *
 * - a successfully loaded config with no securityPolicy resolves through the
 *   normal fail-safe `lockdown` default (which permits app updates);
 * - a config that could not be loaded or validated is unknown, and app
 *   network must fail closed.
 */
export async function resolveUpdaterPermission(
  loadConfig?: () => Promise<unknown>,
): Promise<UpdaterPermission> {
  if (!loadConfig) {
    return { allowed: false, reason: 'policy-unavailable', error: 'API client unavailable' };
  }

  let config: unknown;
  try {
    config = await loadConfig();
  } catch (err) {
    return {
      allowed: false,
      reason: 'policy-unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      allowed: false,
      reason: 'policy-unavailable',
      error: 'Configuration response was not an object',
    };
  }

  const rawPolicy = (config as { securityPolicy?: unknown }).securityPolicy;
  if (rawPolicy === undefined) {
    return resolveSecurityPolicy({}).allowAppNetwork
      ? { allowed: true, reason: 'allowed' }
      : { allowed: false, reason: 'policy-denied' };
  }

  const parsed = SecurityPolicySchema.safeParse(rawPolicy);
  if (!parsed.success) {
    return {
      allowed: false,
      reason: 'policy-unavailable',
      error: 'Security policy was malformed',
    };
  }

  return resolveSecurityPolicy({ securityPolicy: parsed.data }).allowAppNetwork
    ? { allowed: true, reason: 'allowed' }
    : { allowed: false, reason: 'policy-denied' };
}
