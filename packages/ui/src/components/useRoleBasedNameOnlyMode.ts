import { useConfig } from '../data/use-api-read.js';

/**
 * Subscribes the "boring mode" flag (config.roleBasedNameOnlyMode) into a
 * component so name-rendering chokepoints can pass it to `displayName`. Read
 * from the shared config cache, so a toggle in Settings reaches every mounted
 * name-renderer without a reload.
 */
export function useRoleBasedNameOnlyMode(): boolean {
  return useConfig((config) => config.roleBasedNameOnlyMode ?? false) ?? false;
}
