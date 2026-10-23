import { type FileMapScope, isTestFile } from '@bendyline/gezel';

/**
 * Section classification for code maps: which files are test code vs core
 * code (core's `isTestFile`). Data and config files are NOT excluded — they
 * are the Village's fields and signal towers (see `fileUseOf` in core).
 */
export { isTestFile };

/**
 * Whether a path is excluded from a given code-map scope. The single source of
 * truth for both the live-file filter (provider) and purging stale layout rows
 * (build): `core` drops tests; `tests` drops non-tests.
 */
export function isExcludedFromCodeMap(path: string, scope: FileMapScope): boolean {
  const test = isTestFile(path);
  if (scope === 'core') return test;
  if (scope === 'tests') return !test;
  return false; // 'all'
}
