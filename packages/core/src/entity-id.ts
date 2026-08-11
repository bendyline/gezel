/**
 * Portable one-segment identifier used for filesystem-backed entities.
 *
 * Entity ids are never paths. Keep the predicate dependency-free so the
 * `@bendyline/gezel/paths` entrypoint can enforce it without pulling Zod into
 * supervisors and other path-only consumers.
 */
const SAFE_ENTITY_ID = /^[A-Za-z0-9@][A-Za-z0-9@._-]{0,199}$/;
const RESERVED_WINDOWS_IDS = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

export function isSafeEntityId(value: unknown): value is string {
  if (typeof value !== 'string' || !SAFE_ENTITY_ID.test(value)) return false;
  const windowsStem = (value.split('.')[0] ?? '').toUpperCase();
  return !RESERVED_WINDOWS_IDS.has(windowsStem);
}

export function assertSafeEntityId(value: unknown, label = 'entity id'): asserts value is string {
  if (!isSafeEntityId(value)) {
    throw new TypeError(
      `${label} must be a portable single-segment id (letters, numbers, @, ., _, or -)`,
    );
  }
}
