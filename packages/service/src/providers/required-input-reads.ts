/**
 * Which of a craftbook step's declared inputs (`consumes`) a send has read.
 *
 * A local provider's immediate-write mode narrows the turn to `write_file`
 * alone. That is right for "write index.html" and wrong for a step that
 * writes FROM an earlier step's output: a powerpoint-deck copywriter held
 * write_file and nothing else, wrote eight invented slide titles without
 * ever seeing the outline it was told to follow, and the heading gate paused
 * the task (gemma4-12b, 2026-09-23). The provider holds that mode until every
 * required input has been read in the send; it never blocks the write
 * itself, so a missing input cannot deadlock the step.
 */
import {
  completeWorkspaceReadPaths,
  normalizeWorkspacePathForCompare,
} from './file-repair-policy.js';

export interface RequiredInput {
  path: string;
  artifact: boolean;
}

/** Inputs a successful read call opened, in either drawer. */
export function requiredInputsRead(
  toolName: string,
  args: Record<string, unknown>,
  output: string,
): RequiredInput[] {
  if (toolName === 'read_file' || toolName === 'read_files') {
    return completeWorkspaceReadPaths(toolName, args, output).map((path) => ({
      path,
      artifact: false,
    }));
  }
  if (output.startsWith('ERROR:')) return [];
  if (toolName === 'read_artifact' && typeof args.path === 'string') {
    return [{ path: normalizeWorkspacePathForCompare(args.path), artifact: true }];
  }
  if (toolName === 'read_artifacts' && Array.isArray(args.paths)) {
    return args.paths
      .filter((path): path is string => typeof path === 'string')
      .map((path) => ({ path: normalizeWorkspacePathForCompare(path), artifact: true }));
  }
  return [];
}

export function unreadRequiredInputs(
  required: ReadonlyArray<RequiredInput> | undefined,
  read: ReadonlyArray<RequiredInput>,
): RequiredInput[] {
  return (required ?? []).filter((input) => {
    const path = normalizeWorkspacePathForCompare(input.path);
    return !read.some((r) => r.artifact === input.artifact && r.path === path);
  });
}
