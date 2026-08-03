/**
 * DwarfStar (ds4) is GPU-only with NO portable CPU fallback,
 * so — unlike llama.cpp, which runs everywhere — gezel must not offer it on
 * machines where it can't run. This is the client-side half of the M5
 * availability gate (mirroring MLX's `IS_APPLE_SILICON` check): it classifies
 * the device from `navigator` so the Settings panel can show ds4 as available,
 * needs-CUDA, or unavailable-with-reason instead of letting a chat turn fail.
 *
 * Definitive cases are decided here; the NVIDIA-driver presence check is a
 * server-side fact surfaced separately — on Linux the browser can't see the
 * GPU, so we report `requires-cuda` rather than a false negative. Total RAM is
 * also a server fact, so callers that have fetched the memory profile pass it
 * in as `totalRamBytes`; callers that haven't get no RAM gate (unknown must
 * not read as unavailable).
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

function looksAppleSilicon(nav: Navigator): boolean {
  const ua = nav.userAgent || '';
  return (
    /Mac/.test(nav.platform || '') &&
    ((nav as unknown as { userAgentData?: { architecture?: string } }).userAgentData
      ?.architecture === 'arm' ||
      /Mac.*Apple/i.test(ua))
  );
}

export function detectDs4Availability(opts?: {
  /** A configured external ds4-server URL (`config.ds4BaseUrl`), if any. */
  externalBaseUrl?: string | undefined;
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
    return {
      status: 'unavailable',
      reason:
        'DwarfStar (ds4) needs Apple Silicon — Intel Macs lack the unified-memory Metal path, and its CPU path crashes the macOS kernel.',
    };
  }
  if (isWin) {
    return {
      status: 'unavailable',
      reason:
        'DwarfStar has no native Windows build. On a capable NVIDIA box you can run the Linux/CUDA build inside WSL2 and point the DwarfStar External URL at it.',
    };
  }
  if (isLinux) {
    return {
      status: 'requires-cuda',
      reason:
        'On Linux, DwarfStar needs an NVIDIA GPU with CUDA (e.g. a DGX Spark or a large-VRAM workstation). If this machine has one it will run; otherwise DwarfStar is unavailable.',
    };
  }
  return {
    status: 'unavailable',
    reason: 'DwarfStar (ds4) runs only on Apple-Silicon Metal or Linux/CUDA.',
  };
}
