import { outputMediaForStep } from '../craftbook-output-media.js';
import { expandToolsetGroups } from './access.js';
const SHARED_DOCUMENT_MUTATION_TOOLS: readonly string[] = ['write_document', 'delete_document'];

/**
 * Apply the active step's authored JSON policy as a hard, subtractive
 * ceiling. This runs after role/kit grants so a prompt mention, planner
 * exception, tier floor, or explicit gezel toolset selection cannot revive
 * a tool the craftbook declared irrelevant for this phase.
 */
export function applyStepToolPolicy(
  allowlist: Set<string> | null,
  step: Parameters<typeof outputMediaForStep>[0],
  unrestrictedTools: () => Set<string> = () => new Set(),
): Set<string> | null {
  const disabledGroups = new Set(step?.toolPolicy?.disallowBuiltinToolsets ?? []);
  const exactAllowedTools = step?.toolPolicy?.allowTools;
  const disabledTools = step?.toolPolicy?.disallowTools ?? [];
  const explicitMedium = step?.toolPolicy?.outputMedium;
  if (
    disabledGroups.size === 0 &&
    !exactAllowedTools &&
    disabledTools.length === 0 &&
    !explicitMedium
  )
    return allowlist;

  const next = allowlist ? new Set(allowlist) : unrestrictedTools();
  for (const name of expandToolsetGroups([...disabledGroups])) next.delete(name);
  for (const name of disabledTools) next.delete(name);
  if (exactAllowedTools) {
    const ceiling = new Set(exactAllowedTools);
    for (const name of next) if (!ceiling.has(name)) next.delete(name);
  }

  if (explicitMedium) {
    const allowedMedia = outputMediaForStep(step);
    const workspaceWriters = expandToolsetGroups(['workspace-fs-write']);
    const stripWorkspace = (): void => {
      for (const name of workspaceWriters) next.delete(name);
      // `derive_file` is grouped with execution but persists into workspace.
      next.delete('derive_file');
    };
    const stripArtifact = (): void => {
      next.delete('write_artifact');
    };
    const stripTaskNote = (): void => {
      next.delete('write_task_note');
    };
    for (const name of SHARED_DOCUMENT_MUTATION_TOOLS) next.delete(name);

    if (!allowedMedia.has('workspace')) stripWorkspace();
    if (!allowedMedia.has('artifact')) stripArtifact();
    if (!allowedMedia.has('task-note')) stripTaskNote();
  }

  // A broad subtractive policy may slim the task group, but it must not make
  // the active workflow impossible to move or impossible to ask for a
  // decision. An authored `allowTools`, however, is genuinely exact. Adding
  // lifecycle escape hatches to a fixed-action step lets local models select
  // the escape hatch instead of the one required action (wild-caught in the
  // PR-review corpus opener, which repeated set_task_status indefinitely).
  const workflowSafetyTools = exactAllowedTools
    ? []
    : ['advance_task_step', 'set_task_status', 'ask_user_question'];
  for (const name of workflowSafetyTools) {
    if (allowlist === null || allowlist.has(name)) next.add(name);
  }
  return next;
}
