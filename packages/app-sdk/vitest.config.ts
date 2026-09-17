import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The host tests boot a real daemon. Point every machine-scope lookup at a
 * throwaway directory so a developer's own Gezel install is never read, and
 * never adopted as "the system service".
 */
const isolated = join(tmpdir(), 'gezel-app-sdk-test-scope');

export default defineConfig({
  test: {
    env: {
      GEZEL_MACHINE_SHARED_HOME: join(isolated, 'machine'),
      GEZEL_SYSTEM_SERVICE_HOME: join(isolated, 'system-service'),
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
