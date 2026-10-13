import type { GezelSummary, ProviderName } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useFirstRun } from './first-run-context.js';

/**
 * Whether a chat with this gezel has to wait for a model.
 *
 * True while the install has no model its default provider can answer with
 * (first run, a download still under way) and the gezel uses that default.
 * Sending then could only fail: the turn used to come back as the same error
 * three times over, with an offer to report a bug that was not one.
 *
 * A gezel with its own provider is never held here. Whether that provider
 * can answer is the daemon's to say, and a cloud key may well be set.
 */
export function useWaitingForModel(
  gezelId: string,
  recipientGezels: readonly GezelSummary[] | undefined,
): boolean {
  const firstRun = useFirstRun();
  const known = recipientGezels?.find((g) => g.id === gezelId);
  const [looked, setLooked] = useState<{ id: string; provider: ProviderName | null } | null>(null);

  useEffect(() => {
    // Only a first run needs the answer, so an established install never
    // pays for the lookup.
    if (!firstRun || known || !gezelId) return;
    let cancelled = false;
    api
      .getGezel(gezelId)
      .then((gezel) => {
        if (!cancelled) setLooked({ id: gezelId, provider: gezel.provider ?? null });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [firstRun, known, gezelId]);

  if (!firstRun || !gezelId) return false;
  const provider = known
    ? (known.provider ?? null)
    : looked?.id === gezelId
      ? looked.provider
      : undefined;
  // Unknown yet: let the person send, and let the daemon answer if it must.
  return provider === null;
}
