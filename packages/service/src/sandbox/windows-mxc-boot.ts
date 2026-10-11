import { type GezelConfig, type HealthResponse, resolveSecurityPolicy } from '@bendyline/gezel';
import { resolveVendoredMxc } from '../engines/resolver.js';
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
 */
export async function startWindowsScriptSandbox(store: Store, home: string): Promise<void> {
  const config = await store.readConfig().catch(() => ({}) as GezelConfig);
  setWindowsMxcEnabled(config.scriptSandbox?.windowsContainer !== false);
  setWindowsMxcHome(home);
  void resolveWindowsMxcState().then(async (state) => {
    if (state.state !== 'unavailable' || resolveMxcExecutor()) return;
    // npm and CLI installs have no supervisor to lay the launcher down.
    const launcher = await resolveVendoredMxc(home, {
      allowDownload: resolveSecurityPolicy(config).allowAppNetwork,
    });
    if (launcher) await resolveWindowsMxcState();
  });
}

export function windowsScriptSandboxStatus(): NonNullable<HealthResponse['scriptSandbox']> {
  return { boundary: 'windows-mxc', ...windowsMxcState() };
}
