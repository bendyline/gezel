import { isBinaryDocumentPath } from '@bendyline/gezel';

/**
 * Shared safety rules for eval-harness repair handoffs.
 *
 * The product deliberately rejects two ad-hoc file contracts:
 * coordination-only roles cannot own workspace files, and binary office/media
 * deliverables must stay inside their production craftbook. A repair message
 * is still useful in both cases, so the harness drops only the
 * `expectedDeliverable` annotation instead of letting the whole send 400.
 */

// Role lookups may include the display/role-based name beside the canonical
// role (for example "planner calendar desk"), so match role tokens rather
// than requiring the whole label to equal one word.
const COORDINATION_ONLY_ROLES = /\b(?:voorman|coordinator|planner|meester|foreman)\b/i;

export function isCoordinationOnlyRole(role: string | null | undefined): boolean {
  return role != null && COORDINATION_ONLY_ROLES.test(role.trim());
}

/**
 * Re-exported from core rather than kept as a local regex. The harness's
 * copy and the MCP's copy had already drifted from each other, and neither
 * matched core's gate logic — which is how `.docx` deliverables ended up
 * gated by a Markdown-heading check.
 */
export { isBinaryDocumentPath as isBinaryDocumentDeliverablePath };

/**
 * Return the file-contract fragment only when the service will accept it.
 * The prose repair message should always be sent, even when the annotation is
 * intentionally omitted.
 */
export function attachableDeliverable(
  filePath: string | null | undefined,
  role: string | null | undefined,
  log: (msg: string) => void,
): { expectedDeliverable?: { kind: 'file'; filePath: string } } {
  if (!filePath) return {};
  if (isBinaryDocumentPath(filePath)) {
    log(
      `[eval-handoff] sending the ${filePath} repair without an ad-hoc binary file contract (the active craftbook owns production routing)`,
    );
    return {};
  }
  if (isCoordinationOnlyRole(role)) {
    log(
      `[eval-handoff] nudge target has coordination-only role "${role}" — sending without the ${filePath} file contract (the service rejects file handoffs to these roles)`,
    );
    return {};
  }
  return { expectedDeliverable: { kind: 'file', filePath } };
}

function apiErrorDetails(err: Error): unknown {
  const carrier = err as Error & { details?: unknown; body?: unknown };
  return carrier.details ?? carrier.body;
}

export function apiErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

/** A request-shape/auth 4xx will not heal by retrying the same poll request. */
export function isPermanentHandoffError(err: unknown): boolean {
  const status = apiErrorStatus(err);
  return status !== null && status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

/** Surface the service response body instead of leaving a bare HTTP status. */
export function describeSendFailure(err: unknown): string {
  if (err instanceof Error) {
    const details = apiErrorDetails(err);
    const detail =
      typeof details === 'string'
        ? details
        : details && typeof details === 'object' && 'error' in details
          ? String((details as { error: unknown }).error)
          : null;
    return detail ? `${err.message} — ${detail}` : err.message;
  }
  return String(err);
}
