import { type GezelConfig, type HealthResponse, resolveSecurityPolicy } from '@bendyline/gezel';
import { resolveVendoredMxc } from '@bendyline/gezel-inference/internal/engines/resolver';
import type { Store } from '../fs/store.js';
import {
  resolveMxcExecutor,
  resolveWindowsMxcState,
  setWindowsMxcEnabled,
  setWindowsMxcHome,
  windowsMxcState,
} from './windows-mxc.js';

/**
 * Start the Windows container probe at boot, off the request path, so the
 * first session's tool list already knows whether scripts can run.
 *
 * Returns a stop that aborts a launcher download and waits for the rest. A
 * probe left running wrote the launcher into a home its owner was deleting
 * and logged after `gezel run` had handed stdout back to the answer.
 */
export async function startWindowsScriptSandbox(
  store: Store,
  home: string,
): Promise<() => Promise<void>> {
  const config = await store.readConfig().catch(() => ({}) as GezelConfig);
  setWindowsMxcEnabled(config.scriptSandbox?.windowsContainer !== false);
  setWindowsMxcHome(home);
  const abort = new AbortController();
  const settled = resolveWindowsMxcState()
    .then(async (state) => {
      if (abort.signal.aborted || state.state !== 'unavailable' || resolveMxcExecutor()) return;
      // npm and CLI installs have no supervisor to lay the launcher down.
      const launcher = await resolveVendoredMxc(home, {
        allowDownload: resolveSecurityPolicy(config).allowAppNetwork,
        signal: abort.signal,
      });
      if (launcher && !abort.signal.aborted) await resolveWindowsMxcState();
    })
    .catch(() => {});
  return () => {
    abort.abort();
    return settled;
  };
}

export function windowsScriptSandboxStatus(): NonNullable<HealthResponse['scriptSandbox']> {
  return { boundary: 'windows-mxc', ...windowsMxcState() };
}
