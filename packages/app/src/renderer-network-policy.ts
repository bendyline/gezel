import { SecurityPolicySchema, resolveSecurityPolicy } from '@bendyline/gezel';

export type RendererNetworkPermission =
  | { allowed: true; reason: 'allowed' }
  | {
      allowed: false;
      reason: 'policy-denied' | 'policy-unavailable';
      error?: string;
    };

/**
 * Resolve whether renderer-authored content may contact a non-daemon network
 * endpoint. Both network capabilities are required: External services is the
 * explicit content/service permission, while App network is the install-wide
 * kill switch. An unreadable or malformed policy fails closed.
 */
export async function resolveRendererNetworkPermission(
  loadConfig?: () => Promise<unknown>,
): Promise<RendererNetworkPermission> {
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
    const policy = resolveSecurityPolicy({});
    return policy.allowExternalServices && policy.allowAppNetwork
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

  const policy = resolveSecurityPolicy({ securityPolicy: parsed.data });
  return policy.allowExternalServices && policy.allowAppNetwork
    ? { allowed: true, reason: 'allowed' }
    : { allowed: false, reason: 'policy-denied' };
}
