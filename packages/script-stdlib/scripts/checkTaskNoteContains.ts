import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

export const meta = defineScript({
  name: 'checkTaskNoteContains',
  description:
    'Gate: the task\'s notes (optionally a specific phase\'s notes) match a pattern — e.g. "an acceptance checklist was written down before building".',
  kind: 'gate',
  inputs: {
    // When this gate runs from a step, the runtime fills taskRef/stepId
    // automatically from the triggering task; they only need to be set
    // by hand for manual runs.
    taskRef: {
      type: 'string',
      description: 'Task to inspect, as "projectId/num".',
      required: true,
    },
    pattern: { type: 'string', description: 'Regular expression to look for.', required: true },
    flags: { type: 'string', description: 'Regex flags, e.g. "i".', default: 'i' },
    stepId: { type: 'string', description: "Restrict to this phase's notes (optional)." },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['tasks.read'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
const notes = await gezel.task.readNotes(input.taskRef, input.stepId).catch(() => '');
const re = new RegExp(input.pattern, input.flags ?? 'i');
const ok = re.test(notes);
gezel.output(
  gateResult(
    ok,
    ok
      ? `task notes match /${input.pattern}/`
      : `The task notes do not yet contain /${input.pattern}/ — write the required note (use write_task_note) before advancing.`,
  ),
);
