import { SecurityPolicySchema, resolveSecurityPolicy } from '@bendyline/gezel';

export type UpdaterPermission =
  | { allowed: true; reason: 'allowed' }
  | {
      allowed: false;
      reason: 'preference-disabled' | 'policy-denied' | 'policy-unavailable';
      error?: string;
    };

/**
 * Resolve updater authorization without conflating two materially different
 * states:
 *
 * - a successfully loaded config with no securityPolicy resolves through the
 *   normal fail-safe `lockdown` default (which permits app updates);
 * - a config that could not be loaded or validated is unknown, and app
 *   network must fail closed.
 * - an automatic launch check also honors `autoUpdateChecks: false`; a
 *   user-initiated check bypasses that preference but still honors policy.
 */
export async function resolveUpdaterPermission(
  loadConfig?: () => Promise<unknown>,
  options: { automatic?: boolean } = {},
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

  if (
    options.automatic === true &&
    (config as { autoUpdateChecks?: unknown }).autoUpdateChecks === false
  ) {
    return { allowed: false, reason: 'preference-disabled' };
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
