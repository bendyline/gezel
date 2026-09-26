/**
 * One-line text for failures a person caused or can act on. `GezelApiError`
 * used to fall through to `console.error(err)`, so `gezel agent show <typo>`
 * printed a stack trace through node_modules and commander internals.
 * Returns null for anything else, which the caller still prints in full:
 * an unexpected exception is a bug report and its stack is the useful part.
 */
export function formatCliFailure(
  err: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!(err instanceof Error)) return null;
  // Name checks, not instanceof: lazily-loaded command chunks bundle their
  // own copies of these classes.
  if (err.name === 'CliError') return err.message;
  if (err.name !== 'GezelApiError' || env.GEZEL_DEBUG === '1') return null;

  const { status, details } = err as Error & { status?: number; details?: unknown };
  const request = /\bon ([A-Z]+ \S+)/.exec(err.message)?.[1];
  const serviceText = detailText(details);
  if (status === 404) {
    const what = serviceText && serviceText.toLowerCase() !== 'not found' ? serviceText : undefined;
    return `error: not found${what ? `: ${what}` : request ? ` (${request})` : ''}`;
  }
  const lines = [`error: ${serviceText ?? err.message}`];
  if (serviceText && request) lines.push(`(Gezel service answered ${status ?? '?'} to ${request})`);
  lines.push('Set GEZEL_DEBUG=1 to see the full error.');
  return lines.join('\n');
}

/** A service 404, recognized by name so it survives chunk-duplicated classes. */
export function isNotFound(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'GezelApiError' &&
    (err as Error & { status?: number }).status === 404
  );
}

function detailText(details: unknown): string | undefined {
  if (typeof details === 'string' && details.trim()) return details.trim();
  if (details && typeof details === 'object') {
    for (const key of ['message', 'error'] as const) {
      const value = (details as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return undefined;
}
