/**
 * New accelerator work is never admitted above this temperature unless
 * device safety is explicitly disabled.
 *
 * Kept in a browser-safe core module so runtime policy and settings copy use
 * the same value.
 */
export const DEVICE_HARD_TEMPERATURE_C = 105;
