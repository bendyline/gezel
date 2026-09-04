import { statSync } from 'node:fs';

export interface ServiceDistArtifact {
  daemonEntry: string;
  size: number;
  mtimeMs: number;
}

/**
 * Inspect the compiled daemon entry that an eval will actually execute.
 *
 * The source tree is deliberately not consulted. Evals measure the resolved
 * package artifact under `dist/`; checking sibling source mtimes makes an
 * unrelated checkout, merge, or editor write capable of invalidating an
 * already-running matrix even though none of its executable inputs changed.
 */
export function inspectServiceDistArtifact(daemonEntry: string): ServiceDistArtifact {
  const stat = statSync(daemonEntry);
  if (!stat.isFile()) {
    throw new Error(`eval service dist entry is not a file: ${daemonEntry}`);
  }
  return {
    daemonEntry,
    size: stat.size,
    mtimeMs: Math.trunc(stat.mtimeMs),
  };
}

/**
 * Fail only when the compiled artifact selected for this run is unusable.
 * Source freshness is an authoring/build concern, not a trial-spawn concern.
 */
export function assertServiceDistArtifact(daemonEntry: string): void {
  try {
    inspectServiceDistArtifact(daemonEntry);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `eval service dist artifact is unavailable: ${detail}. Run \`pnpm --filter @bendyline/gezel-service build\` to create the compiled eval subject.`,
      { cause: error },
    );
  }
}
