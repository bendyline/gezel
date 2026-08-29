import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Host isolation for the CLI suite.
 *
 * `daemon-integration.test.ts` spawns a real `gezeld` and real `gezel` CLI
 * children against a freshly-made temp `GEZEL_HOME`. On a developer machine
 * that has ever run a packaged install, that home is not fresh: the daemon
 * mounts the machine-shared root by design, so a project whose `storageScope`
 * is `machine-shared` resolves its content under `C:\ProgramData\Gezel\shared`
 * (or /Users/Shared, /var/lib/gezel) rather than under `GEZEL_HOME`. The AI App
 * case then exported a `.gezapp` into the shared `default` project — writing
 * into real user state — and failed reading it back from the temp home.
 *
 * These paths never carry the trust marker, so `activeMachineSharedHome()`
 * returns null and every test home is genuinely its own. CI has no shared root,
 * which is why the rot is invisible there. Same reasoning and same failure
 * class as `packages/app/e2e/helpers/launch-env.ts`.
 */
const HOST_ISOLATION_ROOT = join(tmpdir(), `gezel-cli-host-isolation-${process.pid}`);

export default defineConfig({
  test: {
    env: {
      GEZEL_MACHINE_SHARED_HOME: join(HOST_ISOLATION_ROOT, 'shared'),
      GEZEL_SYSTEM_SERVICE_HOME: join(HOST_ISOLATION_ROOT, 'machine-engine'),
    },
  },
});
