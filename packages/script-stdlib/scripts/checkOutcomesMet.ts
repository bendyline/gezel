import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Runtime gate (runs on the executing task's terminal verification step):
 * every declared outcome has been verified — marked `met` with non-empty
 * `evidence` (an artifact path or note). This is the "observe whether the
 * outcomes were kept" bar that closes a planned task.
 */
export const meta = defineScript({
  name: 'checkOutcomesMet',
  description:
    "Gate: every one of the task's outcomes has been verified (met === true with non-empty evidence). Use on the terminal verification step of a planned task so it can't close until each outcome is observed.",
  kind: 'gate',
  inputs: {
    taskRef: {
      type: 'string',
      description: 'Task to inspect (auto-filled by the runtime when this gate runs from a step).',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the outcomes still to verify.' },
  },
  requires: ['tasks.read'],
} as const);

interface TaskView {
  outcomes?: { id: string; text?: string; met?: boolean; evidence?: string }[];
}

const input = gezel.input as InferredInput<typeof meta>;

const task = (await gezel.task.get(input.taskRef ?? '').catch(() => null)) as TaskView | null;
const outcomes = task?.outcomes ?? [];

let ok = false;
let message = '';
if (outcomes.length === 0) {
  message =
    'This task has no outcomes to verify. Define them with set_outcomes, then mark each met with verify_outcome before closing.';
} else {
  const unmet = outcomes.filter((o) => o.met !== true || !(o.evidence ?? '').trim());
  ok = unmet.length === 0;
  message = ok
    ? `All ${outcomes.length} outcome(s) verified with evidence.`
    : `${unmet.length}/${outcomes.length} outcome(s) not yet verified: ${unmet
        .map((o) => `"${(o.text ?? o.id).slice(0, 60)}"`)
        .join(
          ', ',
        )}. For each, confirm it against the produced artifact and call verify_outcome({ ref, id, met: true, evidence }).`;
}

gezel.output(gateResult(ok, message));
