import type { CraftbookEvalSpec } from './types.ts';

/**
 * Toolsets the daemon bundles are graded for real, never mocked.
 *
 * DocBlocks ships inside the service as an immutable system toolset
 * (2e835ede). The session bridge spawns system toolsets before project ones
 * and the first id wins, so a scenario's project-scoped `docblocks` mock was
 * never what a session talked to: every DocBlocks book ran the real CLI while
 * its grader counted calls on a mock that logged none, and failed work that
 * had succeeded (2026-10-21 sweep). Each bundled-toolset mock is dropped and
 * its `requiredTools` become successful `tool.called` History events — what
 * the real tools leave behind.
 */
export const BUNDLED_TOOLSET_IDS: ReadonlySet<string> = new Set(['docblocks']);

type HistoryExpectation = NonNullable<CraftbookEvalSpec['success']['history']>[number];

function toolCalled(name: string): HistoryExpectation {
  return { kind: 'tool.called', details: { name, success: true } };
}

function sameExpectation(a: HistoryExpectation, b: HistoryExpectation): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Append History expectations, skipping any the list already has. */
export function withHistory(
  existing: readonly HistoryExpectation[] | undefined,
  added: readonly HistoryExpectation[],
): HistoryExpectation[] {
  const out = [...(existing ?? [])];
  for (const expectation of added) {
    if (!out.some((entry) => sameExpectation(entry, expectation))) out.push(expectation);
  }
  return out;
}

/** Successful-call History expectations for the named tools. */
export function toolCalledHistory(names: readonly string[]): HistoryExpectation[] {
  return names.map(toolCalled);
}

export function withRealBundledToolsets(spec: CraftbookEvalSpec): CraftbookEvalSpec {
  const bundledMocks = (spec.mocks ?? []).filter(
    (mock) => mock.kind === 'mcp' && BUNDLED_TOOLSET_IDS.has(mock.toolsetId ?? mock.id),
  );
  if (bundledMocks.length === 0) return spec;
  const bundledIds = new Set(bundledMocks.map((mock) => mock.id));
  const mocks = (spec.mocks ?? []).filter((mock) => !bundledIds.has(mock.id));
  const expectations = spec.success.mocks ?? [];
  const requiredTools = expectations
    .filter((expectation) => bundledIds.has(expectation.service))
    .flatMap((expectation) => expectation.requiredTools ?? []);
  const remaining = expectations.filter((expectation) => !bundledIds.has(expectation.service));
  const { mocks: _mocks, ...rest } = spec;
  const { mocks: _expectations, ...success } = spec.success;
  return {
    ...rest,
    ...(mocks.length > 0 ? { mocks } : {}),
    requiresDocblocks: true,
    success: {
      ...success,
      ...(remaining.length > 0 ? { mocks: remaining } : {}),
      history: withHistory(spec.success.history, toolCalledHistory(requiredTools)),
    },
  };
}
