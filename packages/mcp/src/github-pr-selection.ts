export interface PullWithHeadRef {
  headRef: string;
}

export interface BranchPrioritizedPulls<T extends PullWithHeadRef> {
  pulls: T[];
  currentBranch?: string;
  matchingCount: number;
}

/**
 * Put open PRs for the checked-out branch first without disturbing the
 * provider's order inside either group. Callers can then safely treat the
 * first result as the default only when `matchingCount > 0`.
 */
export function prioritizePullsForCurrentBranch<T extends PullWithHeadRef>(
  pulls: readonly T[],
  currentBranch?: string,
): BranchPrioritizedPulls<T> {
  const branch = currentBranch?.trim();
  if (!branch) return { pulls: [...pulls], matchingCount: 0 };

  const matching: T[] = [];
  const others: T[] = [];
  for (const pull of pulls) {
    (pull.headRef === branch ? matching : others).push(pull);
  }

  return {
    pulls: [...matching, ...others],
    currentBranch: branch,
    matchingCount: matching.length,
  };
}
