import { GezelApiError } from '@bendyline/gezel-client';

/** Only an explicit HTTP not-found may satisfy ContentContainer's null/no-op contract. */
export function isContentNotFound(error: unknown): boolean {
  return error instanceof GezelApiError && error.status === 404;
}
