import type { CopilotAvailability } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Fired by the Copilot install card after an install (or removal) lands, so
 * every gate in the app flips together without a reload. Same convention as
 * `gezel:config-updated`.
 */
export const COPILOT_AVAILABILITY_CHANGED = 'gezel:copilot-availability-changed';

let cache: CopilotAvailability | null = null;
let inFlight: Promise<CopilotAvailability | null> | null = null;

function load(force: boolean): Promise<CopilotAvailability | null> {
  if (!force && cache) return Promise.resolve(cache);
  if (!force && inFlight) return inFlight;
  inFlight = api
    .getCopilotStatus()
    .then((value) => {
      cache = value;
      return value;
    })
    // A daemon older than this UI has no `/copilot-status`. Returning null
    // (rather than `available: false`) keeps the gates in their "unknown"
    // branch, which shows Copilot — the pre-existing behavior.
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the shared cache and notify every mounted hook. */
export function refreshCopilotAvailability(): void {
  cache = null;
  window.dispatchEvent(new CustomEvent(COPILOT_AVAILABILITY_CHANGED));
}

/**
 * Whether GitHub Copilot is usable on this device.
 *
 * Returns `null` until the first answer arrives. **Callers must treat null as
 * "unknown", not "unavailable"** — gating on `!availability?.available` makes
 * the Copilot option blink out and back in on every mount. The correct test is
 * `availability?.available !== false`.
 *
 * Module-level cache shared by every mounted instance, so the several gates
 * that need this don't each issue their own request on a Settings mount.
 */
export function useCopilotAvailability(): CopilotAvailability | null {
  const [availability, setAvailability] = useState<CopilotAvailability | null>(cache);

  useEffect(() => {
    let cancelled = false;
    const apply = (force: boolean) => {
      void load(force).then((value) => {
        if (!cancelled) setAvailability(value);
      });
    };
    apply(false);

    const onChanged = () => apply(true);
    window.addEventListener(COPILOT_AVAILABILITY_CHANGED, onChanged);
    return () => {
      cancelled = true;
      window.removeEventListener(COPILOT_AVAILABILITY_CHANGED, onChanged);
    };
  }, []);

  return availability;
}
