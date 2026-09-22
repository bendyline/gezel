/**
 * The replies the script routes send, built once for both hosts.
 *
 * The wire shapes are already shared through the schemas; what was
 * duplicated was the code assembling them, and with it the small choices
 * that drift: which status a creation returns, what a 404 body says, when a
 * save counts as a conflict. Those choices live here now.
 */
import type {
  RunScriptResponse,
  SaveScriptSourceResponse,
  ScriptDiagnostic,
  ScriptMeta,
  ScriptRun,
} from '../schemas/script.js';

export const SCRIPT_EXISTS_MESSAGE = 'A script with this name already exists';

/** A completed run is a run report, never a server failure: always 200. */
export function scriptRunResponse(run: ScriptRun): RunScriptResponse {
  return {
    runId: run.id,
    status: run.status,
    output: run.output,
    callsSummary: run.calls.map((call) => ({
      kind: call.kind,
      durationMs: call.durationMs,
      ...(call.error ? { error: call.error } : {}),
    })),
    ...(run.error ? { error: run.error } : {}),
  };
}

export function scriptCreatedResponse(
  name: string,
  source: string,
  hash: string,
): { name: string; source: string; hash: string } {
  return { name, source, hash };
}

/**
 * A save with a `baseHash` conflicts when the script is not at that hash any
 * more — including when it has been deleted underneath the editor, which is
 * a conflict too, not a clean write.
 */
export function saveConflicts(
  baseHash: string | undefined,
  current: { hash: string } | null,
): boolean {
  return baseHash !== undefined && baseHash !== (current?.hash ?? '');
}

export function saveConflictResponse(
  current: { hash: string; source: string } | null,
): SaveScriptSourceResponse {
  return {
    status: 'conflict',
    currentHash: current?.hash ?? '',
    currentSource: current?.source ?? '',
  };
}

export function savedSourceResponse(
  hash: string,
  inspection: { meta?: ScriptMeta; diagnostics: ScriptDiagnostic[] },
): SaveScriptSourceResponse {
  return {
    status: 'saved',
    hash,
    metaOk: inspection.meta !== undefined,
    ...(inspection.meta ? { meta: inspection.meta } : {}),
    diagnostics: inspection.diagnostics,
  };
}

export function notFoundBody(kind: 'script' | 'script run' | 'project'): { error: string } {
  return {
    error:
      kind === 'script'
        ? 'Script not found'
        : kind === 'script run'
          ? 'Script run not found'
          : 'Project not found',
  };
}
