/**
 * What an approving gate script hands to the next step.
 *
 * The record stamped on the task, the note left on the receiving step, and
 * the block the next step's prompt shows were three copies of one idea,
 * and the desktop wrote the record without ever reading it back. Here they
 * are once, so a handoff a script stamps on one host reads the same on the
 * other.
 */
import type { GateScriptResult } from '../schemas/gate.js';
import type { Task } from '../schemas/task.js';

export type GateHandoff = NonNullable<GateScriptResult['handoff']>;

/** The record a completed step leaves on the task for the step it routed to. */
export function stampGateHandoff(
  fromStepId: string,
  toStepId: string | undefined,
  handoff: GateHandoff,
  at: string,
): NonNullable<Task['lastGateHandoff']> {
  return {
    fromStepId,
    ...(toStepId ? { toStepId } : {}),
    message: handoff.message,
    ...(handoff.params ? { params: handoff.params } : {}),
    at,
  };
}

function paramLines(params: GateHandoff['params']): string {
  return Object.entries(params ?? {})
    .map(([key, value]) => `- ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
}

/** The durable note on the receiving step. */
export function gateHandoffNoteText(fromStepName: string, handoff: GateHandoff): string {
  const lines = paramLines(handoff.params);
  return `# Handoff from gate on "${fromStepName}"\n\n${handoff.message}${lines ? `\n\n${lines}` : ''}`;
}

/** The prompt block for the step the handoff was addressed to; empty for any other. */
export function renderGateHandoffBlock(
  task: Pick<Task, 'lastGateHandoff'>,
  activeStepId: string | undefined,
): string {
  const handoff = task.lastGateHandoff;
  if (!handoff || !activeStepId || handoff.toStepId !== activeStepId) return '';
  return `#### Handoff from the completion gate\n\n${handoff.message}${
    handoff.params ? `\n\nContext: ${JSON.stringify(handoff.params)}` : ''
  }`;
}
