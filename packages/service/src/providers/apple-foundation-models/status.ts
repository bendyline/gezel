import { type AppleFoundationModelsStatus, acquireSuspendMonitor } from '@bendyline/gezel';
import { appleFmBinaryPath, appleFoundationModelsInstalled } from './binary.js';
import { AppleFmHelper } from './helper.js';

/** Explicit diagnostic only: configuration reads never launch a subprocess. */
export async function appleFoundationModelsStatus(
  opts: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    arch?: string;
    createHelper?: (binaryPath: string) => Pick<AppleFmHelper, 'ready' | 'shutdown'>;
  } = {},
): Promise<AppleFoundationModelsStatus> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const supported = platform === 'darwin' && arch === 'arm64';
  const installed = appleFoundationModelsInstalled(env, platform, arch);
  if (!supported || !installed)
    return {
      supported,
      installed,
      available: false,
      reason: supported
        ? 'This Gezel installation does not include Apple on-device AI.'
        : 'Apple on-device AI requires an Apple silicon Mac.',
    };
  const helper =
    opts.createHelper?.(appleFmBinaryPath(env)!) ??
    new AppleFmHelper({ binaryPath: appleFmBinaryPath(env)! });
  const release = acquireSuspendMonitor();
  try {
    const runtime = await helper.ready();
    return {
      supported,
      installed,
      available: runtime.available,
      runtime,
      ...(runtime.reason ? { reason: runtime.reason } : {}),
    };
  } catch (error) {
    return {
      supported,
      installed,
      available: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await helper.shutdown();
    } finally {
      release();
    }
  }
}
