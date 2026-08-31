/**
 * Wires Settings → General → Documents to the editors' proofing engine.
 *
 * Two things have to happen when someone changes one of those checkboxes:
 * the provider's category filter has to move (module state in
 * `proofing.ts`, read on every pass), and any editor already on screen
 * has to re-lint — otherwise the squiggles they just turned off sit there
 * until the next keystroke.
 *
 * The re-lint lever is the capability itself. Squisq's `useProofing`
 * builds its provider once and keeps it (a warm WASM engine is the whole
 * point), so a *new* provider identity changes nothing; what it does
 * watch is whether proofing is enabled at all, and it schedules a fresh
 * pass the moment that flips back on. So a filter change hands the shell
 * `null` for one tick — clearing decorations — and then the provider
 * again, which lands a pass under the new filter.
 *
 * With both boxes off the capability stays `null` for good, and the
 * engine's ~15 MB of WASM is never fetched.
 */

import type { ProofingProvider } from '@bendyline/squisq-editor-react';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import {
  type ProofingPreferences,
  gezelProofingProvider,
  setProofingPreferences,
} from './proofing.js';

/**
 * Module-level cache shared by every subscriber, same shape as
 * `useShowPoppetjes`: the editors mount one of these per document, and a
 * per-mount `getConfig` would be a fetch for a value that never differs.
 * A `gezel:config-updated` listener re-broadcasts a live Settings change.
 */
let cached: ProofingPreferences | undefined;
let inflight: Promise<void> | null = null;
const subscribers = new Set<(value: ProofingPreferences) => void>();

function broadcast(value: ProofingPreferences): void {
  cached = value;
  // Ahead of the subscriber notify: the provider reads this synchronously
  // on its next pass, and that pass can be scheduled by the re-render the
  // notify triggers.
  setProofingPreferences(value);
  for (const fn of subscribers) fn(value);
}

function fromConfig(config: {
  inlineSpellChecking?: boolean;
  inlineGrammarChecking?: boolean;
}): ProofingPreferences {
  return {
    spelling: config.inlineSpellChecking !== false,
    grammar: config.inlineGrammarChecking !== false,
  };
}

function ensureLoaded(): void {
  if (cached !== undefined || inflight) return;
  inflight = api
    .getConfig()
    .then((config) => {
      broadcast(fromConfig(config));
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
}

if (typeof window !== 'undefined') {
  window.addEventListener('gezel:config-updated', (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { inlineSpellChecking?: boolean; inlineGrammarChecking?: boolean }
      | undefined;
    if (detail) broadcast(fromConfig(detail));
  });
}

/**
 * The stored choices, or `null` until the config read lands. Callers that
 * arm the engine must respect the `null`: assuming the default (both on)
 * for those first few milliseconds would build and set up the provider
 * for someone who has proofing switched off.
 */
function useLoadedPreferences(): ProofingPreferences | null {
  const [value, setValue] = useState<ProofingPreferences | null>(cached ?? null);

  useEffect(() => {
    subscribers.add(setValue);
    if (cached !== undefined) setValue(cached);
    else ensureLoaded();
    return () => {
      subscribers.delete(setValue);
    };
  }, []);

  return value;
}

/**
 * What to pass as `EditorShell`'s `proofing` prop. `null` means no
 * proofing at all — both checkboxes off, or the one-tick gap that makes
 * an open editor re-lint after a filter change.
 */
export function useProofingCapability(): ProofingProvider | null {
  const preferences = useLoadedPreferences();
  const filter = preferences ? `${preferences.spelling}:${preferences.grammar}` : 'unknown';
  const [settled, setSettled] = useState(filter);

  useEffect(() => {
    if (settled === filter) return;
    const timer = window.setTimeout(() => setSettled(filter), 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [filter, settled]);

  if (!preferences) return null;
  if (!preferences.spelling && !preferences.grammar) return null;
  if (settled !== filter) return null;
  return gezelProofingProvider();
}
