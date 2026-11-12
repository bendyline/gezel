import { useConfig } from '../data/use-api-read.js';

/**
 * Subscribes the debug-mode flag (`config.debugMode`) into a component.
 *
 * Gates developer surfaces that are not designed for ordinary users: the
 * machine room in conversations (thinking, tool steps, task ids, the crew's
 * full transcripts) and the developer-only Settings tabs. Read from the shared
 * config cache, so flipping the toggle in Settings takes effect everywhere
 * without a reload.
 */
export function useDebugMode(): boolean {
  return useConfig((config) => config.debugMode ?? false) ?? false;
}
