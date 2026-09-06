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

/**
 * The suite set for a run, given the flag and whatever the dataset already
 * records for that run id.
 *
 * A re-ingest (`--ingest-only --run-id X`) rebuilds the run record from
 * scratch, so an omitted `--suites` would restamp a deliberately narrowed
 * sweep with the full default set -- claiming cells that were never run.
 * An existing run's own scope is therefore the default when the flag is
 * absent, the same way `resolveScorecardStartedAt` reuses a recorded start
 * rather than redating a published measurement. An explicit flag still
 * wins, which is what lets a sweep be widened on purpose.
 */
export function resolveSuitesForRun(
  raw: string | boolean | undefined,
  defaultSuites: readonly string[],
  priorSuites?: readonly string[],
): SuitesFlagResult & { inherited?: boolean } {
  if (raw === undefined && priorSuites && priorSuites.length > 0) {
    return { suites: [...priorSuites], inherited: true };
  }
  return resolveSuitesFlag(raw, defaultSuites);
}
