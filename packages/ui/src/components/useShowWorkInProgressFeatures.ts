import { useConfig } from '../data/use-api-read.js';

/**
 * Live view of the UI/CLI-only work-in-progress feature bucket. The default
 * stays false while config is loading or unavailable; this gate is for
 * discoverability only and deliberately does not change service capability.
 */
export function useShowWorkInProgressFeatures(): boolean {
  return useConfig((config) => config.showWorkInProgressFeatures === true) ?? false;
}
