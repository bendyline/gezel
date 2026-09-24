export class GezelApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GezelApiError';
  }
}

/** A transport failure message that keeps the underlying cause (ECONNREFUSED, …). */
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message} (${cause.message})`;
  }
  if (cause && typeof cause === 'object' && 'code' in cause) {
    return `${error.message} (${String((cause as { code?: unknown }).code)})`;
  }
  return error.message;
}
