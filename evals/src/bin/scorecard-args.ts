/**
 * Pure `--suites` handling for the scorecard CLI.
 *
 * Kept out of bin/scorecard.ts so the contract can be tested without
 * importing the sweep runner, spawning a daemon, or reaching the dataset —
 * the same split all-args.ts makes for eval:all.
 */
import { listSuites } from '../suites.ts';

export interface SuitesFlagResult {
  /** Suite ids to measure, deduped and in the order the operator gave them. */
  suites?: string[];
  /** Operator-facing message; the CLI prints it and exits 2. */
  error?: string;
}

/**
 * Resolve `--suites`, defaulting to the sweep's full set.
 *
 * Unknown ids are fatal rather than skipped: a typo that silently dropped a
 * suite would publish a run whose provenance claims less than the operator
 * asked for, which is the same vanishing-cell problem `unmeasured` exists to
 * prevent. A bare `--suites` arrives as the boolean sentinel and is rejected
 * for the same reason bare `--count` is.
 */
export function resolveSuitesFlag(
  raw: string | boolean | undefined,
  defaultSuites: readonly string[],
): SuitesFlagResult {
  if (raw === undefined) return { suites: [...defaultSuites] };
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: '--suites requires a comma-separated value, e.g. --suites core,productivity' };
  }
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) return { error: '--suites requires at least one suite id' };
  const known = new Set(listSuites().map((suite) => suite.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      error: `unknown suite(s): ${unknown.join(', ')}\n            known: ${[...known].join(', ')}`,
    };
  }
  return { suites: [...new Set(ids)] };
}

/**
 * The `--suites` fragment to echo back in a resume/retry hint.
 *
 * Empty when the run covers the default set, so the common hint stays short.
 * A narrowed run MUST carry it: resuming without it silently re-widens to
 * every suite under the same run id, which both blows the budget the operator
 * chose and appends cells the run's provenance never advertised.
 */
export function suitesFlagFragment(
  suites: readonly string[],
  defaultSuites: readonly string[],
): string {
  const isDefault =
    suites.length === defaultSuites.length && defaultSuites.every((id) => suites.includes(id));
  return isDefault ? '' : ` --suites ${suites.join(',')}`;
}
