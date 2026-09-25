import type { ScriptOutputPredicate, ScriptRef } from '../schemas/script.js';

/** Return the first branch whose predicate matches the supplied script output. */
export function scriptBranchGoto(
  branches: { when: ScriptOutputPredicate; goto: string }[],
  output: unknown,
): string | undefined {
  for (const branch of branches) {
    if (evaluatePredicate(branch.when, output)) return branch.goto;
  }
  return undefined;
}

/** Evaluate the on-enter shorthand that decides whether a step advances. */
export function scriptShouldAutoAdvance(ref: ScriptRef, output: unknown): boolean {
  const predicate: ScriptOutputPredicate | undefined =
    ref.autoAdvanceWhen ?? (ref.autoAdvanceOnSuccess ? { op: 'ok' } : undefined);
  if (!predicate) return false;
  return evaluatePredicate(predicate, output);
}

function evaluatePredicate(predicate: ScriptOutputPredicate, output: unknown): boolean {
  switch (predicate.op) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'ok':
      return !isRecord(output) || output.ok !== false;
    case 'equals':
      return readFieldPath(output, predicate.field) === predicate.value;
    case 'exists': {
      const value = readFieldPath(output, predicate.field);
      const exists = value !== undefined && value !== null;
      return predicate.negate ? !exists : exists;
    }
    case 'gt': {
      const value = readFieldPath(output, predicate.field);
      return typeof value === 'number' && value > predicate.value;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFieldPath(output: unknown, path: string): unknown {
  if (output === null || output === undefined) return undefined;
  let current: unknown = output;
  for (const segment of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && segment === 'length') {
      current = current.length;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
