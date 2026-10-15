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
 * How long a session build waits for the boot probe. A fresh home resolves
 * its launcher in ~4 s and probes in ~150 ms; a launcher download on a slow
 * link can take longer, and the session then proceeds on the snapshot.
 */
const BOOT_PROBE_WAIT_MS = 15_000;

let bootProbe: Promise<void> | undefined;

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
  bootProbe = settled;
  return () => {
    abort.abort();
    return settled;
  };
}

/**
 * Wait, at most `timeoutMs`, for the probe {@link startWindowsScriptSandbox}
 * started. Session tool surfaces read the container state synchronously, and
 * a session built while the launcher was still landing withheld
 * `run_nodejs_script` and `derive_file` for its whole life: every eval
 * trial's first session on Windows, since each trial starts from a fresh home
 * (data-wrangle, 2026-10-14). Free once the probe has settled.
 */
export async function awaitWindowsScriptSandboxBoot(timeoutMs = BOOT_PROBE_WAIT_MS): Promise<void> {
  if (!bootProbe) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([bootProbe, bound]);
  } finally {
    clearTimeout(timer);
  }
}

export function windowsScriptSandboxStatus(): NonNullable<HealthResponse['scriptSandbox']> {
  return { boundary: 'windows-mxc', ...windowsMxcState() };
}
