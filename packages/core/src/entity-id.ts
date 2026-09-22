/**
 * Portable one-segment identifier used for filesystem-backed entities.
 *
 * Entity ids are never paths. Keep the predicate dependency-free so the
 * `@bendyline/gezel/paths` entrypoint can enforce it without pulling Zod into
 * supervisors and other path-only consumers.
 */
import { RESERVED_WINDOWS_BASENAMES } from './path-rules.js';

const SAFE_ENTITY_ID = /^[A-Za-z0-9@][A-Za-z0-9@._-]{0,199}$/;

export function isSafeEntityId(value: unknown): value is string {
  if (typeof value !== 'string' || !SAFE_ENTITY_ID.test(value)) return false;
  const windowsStem = (value.split('.')[0] ?? '').toUpperCase();
  return !RESERVED_WINDOWS_BASENAMES.has(windowsStem);
}

export function assertSafeEntityId(value: unknown, label = 'entity id'): asserts value is string {
  if (!isSafeEntityId(value)) {
    throw new TypeError(
      `${label} must be a portable single-segment id (letters, numbers, @, ., _, or -)`,
    );
  }
}
