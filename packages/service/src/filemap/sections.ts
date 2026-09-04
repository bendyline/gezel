import type { FileMapScope } from '@bendyline/gezel';

/**
 * Section classification for code maps: which files are test code vs core
 * code. Keeping this pure + tested means the "separate tests into their own
 * city" rule stays predictable. Data and config files are NOT excluded — they
 * are the Village's fields and signal towers (see `fileUseOf` in core).
 */

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR = new Set(['__tests__', '__mocks__', 'e2e', 'spec', 'specs']);

/** A test file: a `*.test.*` / `*.spec.*` name, or anything under a test folder
 *  (any directory segment containing "test", plus `__mocks__`/`e2e`/`spec`). */
export function isTestFile(path: string): boolean {
  const segs = path.split('/');
  const base = segs[segs.length - 1] ?? '';
  if (TEST_FILE.test(base)) return true;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!.toLowerCase();
    if (s.includes('test') || TEST_DIR.has(s)) return true;
  }
  return false;
}

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
