/**
 * DwarfStar (ds4) is GPU-only with NO portable CPU fallback, so — unlike
 * llama.cpp, which runs everywhere — gezel must not offer it on machines where
 * it can't run. This is the client-side half of the availability gate.
 *
 * It decides from facts the daemon already publishes, in preference order:
 *
 *   1. `ds4ServerBundled` (`/api/health`) — did a `ds4-server` binary actually
 *      resolve for this host? ds4 ships one build per supported platform, and
 *      `discoverNativeBinaries` stamps `GEZEL_DS4_SERVER_BIN` only when that
 *      build is on disk, so this single boolean subsumes every platform and
 *      architecture question the old check tried to answer from `navigator`.
 *   2. `llamaCppDetectedBackend` / `llamaCppDetectedVendor` — the real driver
 *      probe (`libcuda.so.1`, `nvcuda.dll`, PCI sysfs). On Linux a bundled
 *      binary proves the *build* exists; only the probe proves the NVIDIA
 *      driver does.
 *   3. `platform` from health — the daemon's own `process.platform`, used for
 *      the "why not" copy instead of sniffing the browser.
 *
 * Earlier revisions classified the device from `navigator` alone, which made
 * the Linux branch a permanent hedge: **every** Linux machine read "requires
 * NVIDIA / CUDA", DGX Sparks included, while the llama.cpp tab beside it
 * reported `cuda` from a server probe and the ds4 model rows below it sized
 * their memory targets from a server fit plan. One panel, three different
 * ideas about the machine. `requires-cuda` now means what it says — we have a
 * ds4 build but cannot prove a driver — and is unreachable once the probe
 * answers.
 *
 * The navigator path is kept as the fallback for a daemon that predates
 * `ds4ServerBundled`, so an older service degrades to the previous behavior
 * rather than to a wrong verdict.
 *
 * The external-URL escape hatch wins everywhere: if the user has pointed
 * `ds4BaseUrl` at a running ds4-server, ds4 is "available" regardless of the
 * local platform (they may be on Windows driving a WSL2/LAN box).
 */
export type Ds4Availability =
  | { status: 'available'; backend: 'metal' | 'cuda' }
  | { status: 'external' }
  | { status: 'requires-cuda'; reason: string }
  | { status: 'unavailable'; reason: string };

/**
 * The smallest machine we'll offer DwarfStar on. Its models are frontier-class
 * MoEs streamed from SSD; under this much RAM the expert cache thrashes and a
 * turn takes minutes, so offering the engine is worse than hiding it.
 *
 * Nominally a 48 GB machine, but the bar sits at 45 GiB deliberately: Linux
 * `os.totalmem()` reports MemTotal, which is physical RAM minus what the
 * kernel reserved, so a real 48 GB box reports ~47 GiB and an exact-48 GiB
 * threshold would gate it out.
 */
export const DS4_MIN_RAM_BYTES = 45 * 1024 ** 3;

const NEEDS_NVIDIA =
  'On Linux, DwarfStar needs an NVIDIA GPU with CUDA (e.g. a DGX Spark or a large-VRAM workstation).';

const NO_WINDOWS_BUILD =
  'DwarfStar has no native Windows build. On a capable NVIDIA box you can run the Linux/CUDA build inside WSL2 and point the DwarfStar External URL at it.';

const NEEDS_APPLE_SILICON =
  'DwarfStar (ds4) needs Apple Silicon — Intel Macs lack the unified-memory Metal path, and its CPU path crashes the macOS kernel.';

function looksAppleSilicon(nav: Navigator): boolean {
  const ua = nav.userAgent || '';
  return (
    /Mac/.test(nav.platform || '') &&
    ((nav as unknown as { userAgentData?: { architecture?: string } }).userAgentData
      ?.architecture === 'arm' ||
      /Mac.*Apple/i.test(ua))
  );
}

/** Why ds4 can't run here, phrased for the platform we know the daemon is on. */
function noBuildReason(platform: string | undefined): string {
  if (platform === 'win32') return NO_WINDOWS_BUILD;
  if (platform === 'darwin') return NEEDS_APPLE_SILICON;
  if (platform === 'linux') {
    return `${NEEDS_NVIDIA} This machine has no DwarfStar engine installed — the CUDA build ships only for x86-64 and ARM64 Linux.`;
  }
  return 'DwarfStar (ds4) runs only on Apple-Silicon Metal or Linux/CUDA, and no engine for this system is installed.';
}

export function detectDs4Availability(opts?: {
  /** A configured external ds4-server URL (`config.ds4BaseUrl`), if any. */
  externalBaseUrl?: string | undefined;
  /**
   * `health.ds4ServerBundled` — a ds4-server binary resolved for this host.
   * `undefined` means the daemon didn't report it (older service), which falls
   * back to the navigator heuristic rather than being read as "no".
   */
  ds4ServerBundled?: boolean | undefined;
  /** `health.platform` — the daemon's `process.platform`. */
  serverPlatform?: string | undefined;
  /** `health.llamaCppDetectedBackend` — what the hardware probe found. */
  detectedBackend?: 'cuda' | 'vulkan' | 'metal' | 'cpu' | undefined;
  /** `health.llamaCppDetectedVendor` — the probed GPU vendor. */
  gpuVendor?: 'amd' | 'nvidia' | 'intel' | undefined;
  /** Injectable for tests; defaults to the global `navigator`. */
  navigatorOverride?: Navigator | undefined;
  /**
   * Total system RAM from `api.getMemoryProfile()`. Omit when it hasn't been
   * fetched — the RAM gate is then skipped rather than guessed.
   */
  totalRamBytes?: number | undefined;
}): Ds4Availability {
  if (opts?.externalBaseUrl) return { status: 'external' };

  // Before the platform checks: too little memory is disqualifying on every
  // backend, Metal or CUDA.
  if (typeof opts?.totalRamBytes === 'number' && opts.totalRamBytes > 0) {
    if (opts.totalRamBytes < DS4_MIN_RAM_BYTES) {
      return {
        status: 'unavailable',
        reason: `DwarfStar needs at least 48 GB of memory — this machine has about ${Math.round(
          opts.totalRamBytes / 1024 ** 3,
        )} GB. Its models are far larger than memory and are streamed from SSD, so a smaller machine spends its time swapping experts instead of answering.`,
      };
    }
  }

  if (opts?.ds4ServerBundled !== undefined) {
    if (!opts.ds4ServerBundled) {
      return { status: 'unavailable', reason: noBuildReason(opts.serverPlatform) };
    }
    // A bundled build on macOS is the Metal one, and it only ships for Apple
    // Silicon — its presence already proves the architecture.
    if (opts.serverPlatform === 'darwin') return { status: 'available', backend: 'metal' };
    // Linux ships only the CUDA build, so a bundled binary means the build
    // exists; the driver is a separate fact. Either probe signal answering
    // NVIDIA is enough — they come from the same detection pass, and the
    // vendor hint survives cases where a user pinned a non-CUDA backend.
    if (opts.detectedBackend === 'cuda' || opts.gpuVendor === 'nvidia') {
      return { status: 'available', backend: 'cuda' };
    }
    if (opts.gpuVendor === 'amd' || opts.gpuVendor === 'intel') {
      return {
        status: 'unavailable',
        reason: `${NEEDS_NVIDIA} This machine's GPU is ${opts.gpuVendor === 'amd' ? 'AMD' : 'Intel'}, which DwarfStar cannot use.`,
      };
    }
    // Build present, driver unproven — the one case that stays a hedge.
    return {
      status: 'requires-cuda',
      reason: `${NEEDS_NVIDIA} The DwarfStar engine is installed on this machine, but no NVIDIA driver was detected — if the GPU is present it will still run.`,
    };
  }

  // ── Fallback: no server fact available (daemon predates the field) ──
  const nav = opts?.navigatorOverride ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  if (!nav) {
    return {
      status: 'unavailable',
      reason:
        'Cannot determine this device — DwarfStar (ds4) runs only on Apple-Silicon Metal or Linux/CUDA.',
    };
  }

  const platform = nav.platform || '';
  const ua = nav.userAgent || '';
  const isMac = /Mac/.test(platform);
  const isWin = /Win/.test(platform);
  const isLinux = /Linux/.test(platform) && !/Android/.test(ua);

  if (isMac && looksAppleSilicon(nav)) {
    return { status: 'available', backend: 'metal' };
  }
  if (isMac) {
    return { status: 'unavailable', reason: NEEDS_APPLE_SILICON };
  }
  if (isWin) {
    return { status: 'unavailable', reason: NO_WINDOWS_BUILD };
  }
  if (isLinux) {
    return {
      status: 'requires-cuda',
      reason: `${NEEDS_NVIDIA} If this machine has one it will run; otherwise DwarfStar is unavailable.`,
    };
  }
  return {
    status: 'unavailable',
    reason: 'DwarfStar (ds4) runs only on Apple-Silicon Metal or Linux/CUDA.',
  };
}
