import type { LocalActiveInstall } from '@bendyline/gezel-client';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { modelInstallStatus } from './first-run-model-text.js';

/** How often a held composer looks again while a download runs. */
const DOWNLOADING_POLL_MS = 3_000;
/** How often it looks for a download to start. */
const IDLE_POLL_MS = 10_000;

/**
 * Where the install's model download stands, for a composer held until a
 * model can answer. Home runs the first download and its composer says
 * "downloading the AI model · 42%"; a crew member's chat used to say "no AI
 * model is downloaded" at the same moment. Both now read the daemon's own
 * install list through the same wording (`modelInstallStatus`).
 *
 * Undefined when nothing is downloading, the provider is not an on-device
 * one, or `enabled` is false. Only a held composer with no status of its own
 * enables it, so an established install never polls.
 */
export function useModelDownloadStatus(enabled: boolean): string | undefined {
  const [status, setStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    // A phone draws its own model list and has no daemon install list.
    if (!enabled || !runtimeCapabilities().daemonSettings) {
      setStatus(undefined);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      let provider: 'llama-cpp' | 'mlx';
      let target: string | undefined;
      try {
        const cfg = await api.getConfig();
        const configured = cfg.provider ?? 'llama-cpp';
        // Only an on-device provider downloads a model; anything else is
        // held for a reason this line does not describe.
        if (configured !== 'llama-cpp' && configured !== 'mlx') return;
        provider = configured;
        target = cfg.defaultModel?.[provider];
      } catch {
        return;
      }
      const look = async () => {
        let inFlight: LocalActiveInstall | undefined;
        try {
          const { installs } =
            provider === 'mlx'
              ? await api.listMlxActiveInstalls()
              : await api.listLlamaCppActiveInstalls();
          inFlight = installs.find((i) => i.catalogId === target) ?? installs[0];
          if (cancelled) return;
          setStatus(
            inFlight
              ? modelInstallStatus({
                  bytesWritten: inFlight.bytesWritten,
                  totalBytes: inFlight.totalBytes,
                  phase: inFlight.phase,
                })
              : undefined,
          );
        } catch {
          // Keep the last answer; the next look tries again.
        }
        if (!cancelled) timer = setTimeout(look, inFlight ? DOWNLOADING_POLL_MS : IDLE_POLL_MS);
      };
      if (!cancelled) await look();
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled]);

  return enabled ? status : undefined;
}
