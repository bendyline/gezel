import {
  type AIEngagementMode,
  SECURITY_PRESETS,
  type SecurityPresetLevel,
  securityPolicyForLevel,
} from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

/**
 * Settings a deployer chooses before the first boot, as a container's
 * environment: `GEZEL_INITIAL_SECURITY_LEVEL` and `GEZEL_INITIAL_MODE`.
 * Applied once, to a home created by this boot, and never again: after
 * that the person's own choice in Settings or `gezel security level` /
 * `gezel mode` is the one that stands, whatever the environment still says.
 */

const MODE_NAMES: Readonly<Record<string, AIEngagementMode>> = {
  'read-only': 'off',
  off: 'off',
  reactive: 'reactive',
  'reactive+tasks': 'scheduled',
  scheduled: 'scheduled',
  'full-play': 'proactive',
  proactive: 'proactive',
};

export interface BootSeedResult {
  securityLevel?: SecurityPresetLevel;
  mode?: AIEngagementMode;
  ignored: string[];
}

export async function applyFirstBootSeeds(
  store: Pick<Store, 'writeConfig'>,
  env: NodeJS.ProcessEnv,
  freshHome: boolean,
): Promise<BootSeedResult> {
  const result: BootSeedResult = { ignored: [] };
  if (!freshHome) return result;
  const level = env.GEZEL_INITIAL_SECURITY_LEVEL?.trim().toLowerCase();
  if (level) {
    if (Object.hasOwn(SECURITY_PRESETS, level)) {
      result.securityLevel = level as SecurityPresetLevel;
      await store.writeConfig({ securityPolicy: securityPolicyForLevel(result.securityLevel) });
    } else {
      result.ignored.push(`GEZEL_INITIAL_SECURITY_LEVEL=${level}`);
    }
  }
  const mode = env.GEZEL_INITIAL_MODE?.trim().toLowerCase();
  if (mode) {
    const parsed = MODE_NAMES[mode];
    if (parsed) {
      result.mode = parsed;
      await store.writeConfig({ aiEngagementMode: parsed });
    } else {
      result.ignored.push(`GEZEL_INITIAL_MODE=${mode}`);
    }
  }
  return result;
}
