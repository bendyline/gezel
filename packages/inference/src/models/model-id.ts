import { isSafeEntityId } from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';

export const INVALID_MODEL_ID_CODE = 'invalid-model-id';
export const INVALID_MODEL_ID_MESSAGE =
  'model id must be a portable single-segment id (letters, numbers, @, ., _, or -)';

/**
 * Model ids are storage keys, never paths.
 *
 * Keep this model-specific alias instead of scattering entity-id checks
 * through providers and routes. It gives every model lifecycle surface one
 * invariant while retaining the stricter cross-platform rules from core.
 */
export function isSafeModelId(value: unknown): value is string {
  return isSafeEntityId(value);
}

export class InvalidModelIdError extends TypeError {
  readonly code = INVALID_MODEL_ID_CODE;

  constructor() {
    super(INVALID_MODEL_ID_MESSAGE);
    this.name = 'InvalidModelIdError';
  }
}

export function assertSafeModelId(value: unknown): asserts value is string {
  if (!isSafeModelId(value)) {
    throw new InvalidModelIdError();
  }
}

/**
 * Resolve a writable model directory only after proving that the caller
 * supplied an id rather than a path. The second containment check is
 * deliberate defense in depth for destructive provider methods that can be
 * called without going through an HTTP route.
 */
export function resolveModelDirectory(modelsRoot: string, id: unknown): string {
  assertSafeModelId(id);
  const target = safeJoin(modelsRoot, id);
  if (!target) {
    throw new InvalidModelIdError();
  }
  return target;
}
