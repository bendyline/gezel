/**
 * Reject the boolean sentinel parseArgs uses for bare flags whose values are
 * mandatory in eval:all. Kept pure so the CLI contract can be tested without
 * importing the matrix runner or starting any eval processes.
 */
export function valueRequiredAllFlagError(flags: Record<string, string | boolean>): string | null {
  if (flags.count === true) return '--count requires a value';
  if (flags.scenarios === true) return '--scenarios requires a comma-separated value';
  return null;
}

/** Same boolean-sentinel guard for the single/multi-scenario batch CLI. */
export function valueRequiredBatchFlagError(
  flags: Record<string, string | boolean>,
): string | null {
  if (flags.count === true) return '--count requires a value';
  return null;
}
