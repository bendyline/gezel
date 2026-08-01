import { arch as processArch, platform as processPlatform } from 'node:process';
import type { ProviderName } from '@bendyline/gezel';
import {
  isSupportedOnDevicePlatform,
  resolveFirstRunTarget,
} from '../first-run/on-device-bootstrap.js';

/**
 * The provider to use when the user has never picked one.
 *
 * Prefers the on-device engine: a fresh install should talk to hardware the
 * user already has rather than to a cloud SDK that may not even be installed.
 * This used to be a bare `'copilot'` literal repeated at a dozen call sites,
 * which stopped being defensible once the Copilot SDK became an opt-in
 * download — the default pointed at something no new install had.
 *
 * Falls back to Copilot only where we ship no engine at all (notably Intel
 * Mac). That path now produces an actionable "install it in Settings" error
 * from `CopilotProvider.initialize` rather than a module-resolution crash.
 *
 * Reuses {@link isSupportedOnDevicePlatform} and {@link resolveFirstRunTarget}
 * so this default and the first-run model pin can never disagree about which
 * engine a given platform gets. `resolveFirstRunTarget` also picks a model id
 * from the tier it's handed; only the provider half is relevant here, so the
 * tier argument is irrelevant and passed empty.
 */
export function resolveDefaultProviderName(
  config: { provider?: ProviderName } | null | undefined,
  platform: NodeJS.Platform = processPlatform,
  arch: string = processArch,
): ProviderName {
  if (config?.provider) return config.provider;
  if (isSupportedOnDevicePlatform(platform, arch)) {
    return resolveFirstRunTarget('', platform, arch).provider;
  }
  return 'copilot';
}
