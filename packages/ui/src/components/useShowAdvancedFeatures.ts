import { useConfig } from '../data/use-api-read.js';

/**
 * Subscribes the "show advanced features" flag (config.showAdvancedFeatures)
 * into a component so power-user surfaces (currently the sidebar's "Scripts"
 * area link) can be gated on it. Read from the shared config cache, so the
 * toggle in Settings → About → Advanced reaches the sidebar without a reload.
 */
export function useShowAdvancedFeatures(): boolean {
  return useConfig((config) => config.showAdvancedFeatures ?? false) ?? false;
}
