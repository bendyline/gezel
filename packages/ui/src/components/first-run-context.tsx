import { createContext, useContext } from 'react';
import { useIsFirstRun } from './useIsFirstRun.js';

/**
 * One first-run answer for the whole tree.
 *
 * Deciding it costs a config read and a provider probe, and the estimate is
 * re-run on every settings save. With two components asking independently the
 * app paid for all of that twice on boot and twice again after each save.
 */
const FirstRunContext = createContext<boolean | undefined>(undefined);

export const FirstRunProvider = FirstRunContext.Provider;

/** Read the shared answer, falling back to probing when no provider is above. */
export function useFirstRun(): boolean {
  const shared = useContext(FirstRunContext);
  const own = useIsFirstRun(shared === undefined);
  return shared ?? own;
}
