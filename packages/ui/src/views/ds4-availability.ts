/**
 * DwarfStar (ds4) is GPU-only with NO portable CPU fallback,
 * so — unlike llama.cpp, which runs everywhere — gezel must not offer it on
 * machines where it can't run. This is the client-side half of the M5
 * availability gate (mirroring MLX's `IS_APPLE_SILICON` check): it classifies
 * the device from `navigator` so the Settings panel can show ds4 as available,
 * needs-CUDA, or unavailable-with-reason instead of letting a chat turn fail.
 *
 * Definitive cases are decided here; the NVIDIA-driver presence and total-RAM
 * checks (the rest of the plan's gate) are server-side facts surfaced
 * separately — on Linux the browser can't see the GPU, so we report
 * `requires-cuda` rather than a false negative.
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
}): Ds4Availability {
  if (opts?.externalBaseUrl) return { status: 'external' };

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
