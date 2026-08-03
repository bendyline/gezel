import { useEffect, useState } from 'react';
import { api } from '../api.js';

let cache: number | null = null;
let inFlight: Promise<number | null> | null = null;

function load(): Promise<number | null> {
  if (cache !== null) return Promise.resolve(cache);
  if (inFlight) return inFlight;
  inFlight = api
    .getMemoryProfile()
    .then((profile) => {
      cache = profile.totalRamBytes;
      return cache;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/**
 * Test seam. Physical RAM can't change while the app runs, so nothing in the
 * product needs this — but a test that mocks a differently-sized machine has
 * to clear what an earlier render cached, or it inherits the wrong device.
 */
export function resetTotalRamBytesCache(): void {
  cache = null;
  inFlight = null;
}

/**
 * Total system RAM in bytes, for the gates that hide engines a machine is too
 * small to run.
 *
 * Returns `null` until the first answer arrives, and stays null if the daemon
 * can't answer. **Callers must treat null as "unknown", not "too small"** —
 * the same rule as `useCopilotAvailability`, for the same reason: gating an
 * option on a not-yet-loaded value makes it blink out on every mount.
 *
 * The value can't change while the app runs, so the module-level cache is
 * filled once and never invalidated.
 */
export function useTotalRamBytes(): number | null {
  const [bytes, setBytes] = useState<number | null>(cache);

  useEffect(() => {
    let cancelled = false;
    void load().then((value) => {
      if (!cancelled) setBytes(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return bytes;
}
