import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GezelConfig } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { electronNativeBinCandidates } from '@bendyline/gezel-client/node';
import { discoverNativeBinaries } from '@bendyline/gezel/native';
import { reuseVerifiedElectronNativeBinaries } from './engines/electron-native-reuse.js';
import { effectiveEngineRelease } from './engines/native-manifest.js';
const log = createLogger('engines');
export async function prepareNativeEngines(home: string, bootConfig: GezelConfig): Promise<void> {
  // System-service launches (Windows GezelService NSSM-wrapped daemon,
  // macOS LaunchDaemon, Linux systemd unit) start gezeld with a clean
  // env — the Electron supervisor's pre-spawn env-stamping never
  // reaches them. Probe the per-host backend and resolve the bundled
  // engine binaries here so the on-device chat path finds them. Idempotent
  // when the supervisor already populated the env (embedded / dev /
  // packaged-spawn launches); the discovery short-circuits per binary.
  // A directly-started user daemon has no Electron supervisor to point it at
  // an installed app payload. Reuse that payload only after the service's own
  // source-pinned per-file manifest, architecture, and platform-signature
  // policy accept it. This is the same gate the standalone CLI uses; metadata
  // beside the installed app is never trusted. An explicit/operator path and
  // mock mode both remain untouched.
  if (!process.env.GEZEL_NATIVE_BIN_DIR && process.env.GEZEL_MOCK_PROVIDER !== '1') {
    const installedCandidates = electronNativeBinCandidates().filter((candidate) =>
      existsSync(candidate),
    );
    if (installedCandidates.length > 0) {
      const reuse = await reuseVerifiedElectronNativeBinaries({ candidates: installedCandidates });
      if (reuse.reused) {
        log.info(`[native] ${reuse.reason}: ${reuse.nativeBinDir}`);
      } else {
        log.warn(`[native] installed Electron payload rejected: ${reuse.reason}`);
      }
    }
  }

  // Bare npm/CLI installs may have neither a supervisor nor an installed app.
  // Make the source-pinned, user-owned download cache the final default while
  // preserving every verified or operator-provided override above. This makes
  // a verified TUI bootstrap install available immediately and on later daemon
  // launches without another download.
  process.env.GEZEL_NATIVE_BIN_DIR ??= join(
    home,
    'engines',
    'native-bin',
    effectiveEngineRelease(),
  );
  const nativeDiscovery = discoverNativeBinaries({
    home,
    ...(bootConfig.llamaCppBackendOverride
      ? { llamaCppBackendOverride: bootConfig.llamaCppBackendOverride }
      : {}),
    logger: { info: (m) => log.info(m), warn: (m) => log.warn(m) },
  });
  if (nativeDiscovery.llamaBackend) {
    const lb = nativeDiscovery.llamaBackend;
    log.info(
      `[native] llama-cpp backend probe: ${lb.backend}${lb.cached ? ' (cached)' : ''} — ${lb.reason}`,
    );
  }
}
