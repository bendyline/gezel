import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Both Electron and headless CLI startup can publish the verified native root. */
export function appleFmBinaryPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GEZEL_APPLE_FM_BIN) return env.GEZEL_APPLE_FM_BIN;
  if (env.GEZEL_NATIVE_BIN_DIR) {
    const binary = join(env.GEZEL_NATIVE_BIN_DIR, 'darwin-arm64', 'gezel-apple-fm');
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

/** Passive picker presence. Only an explicit helper probe can establish readiness. */
export function appleFoundationModelsInstalled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  const bin = appleFmBinaryPath(env);
  return platform === 'darwin' && arch === 'arm64' && !!bin && existsSync(bin);
}
