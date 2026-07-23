import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Plan gate (runs on a plan-AUTHORING task): the draft plan ends with a
 * terminal verification step that checks the outcomes — its prompt references
 * outcome verification (verify_outcome / set_task_status). Reads the draft via
 * the authoring task's `craftbookParams.draftRef`.
 */
export const meta = defineScript({
  name: 'checkVerificationStep',
  description:
    "Plan gate: the draft plan has a terminal verification step whose prompt checks each outcome (verify_outcome) and closes the task (set_task_status). Reads the draft via the authoring task's craftbookParams.draftRef.",
  kind: 'gate',
  inputs: {
    taskRef: {
      type: 'string',
      description:
        'The authoring task (auto-filled by the runtime when this gate runs from a step).',
    },
  },
  outputs: {
    decision: { type: 'string', description: "'approve' or 'reject'." },
    message: { type: 'string', description: 'What passed, or the concrete gap to fix.' },
  },
  requires: ['tasks.read'],
} as const);

interface StepView {
  id: string;
  name?: string;
  prompt?: string;
  terminal?: boolean;
}
interface DraftView {
  craftbookParams?: Record<string, string>;
  craftbook?: { steps?: StepView[] };
}

const VERIFY_RE = /outcome|verify_outcome|set_task_status/i;

const input = gezel.input as InferredInput<typeof meta>;

let ok = false;
let message = '';

const authoring = (await gezel.task.get(input.taskRef ?? '').catch(() => null)) as DraftView | null;
const draftRef = authoring?.craftbookParams?.draftRef;
if (!draftRef) {
  message =
    'This gate must run on a plan-authoring task whose craftbookParams.draftRef points at the draft plan. Start planning with start_plan.';
} else {
  const draft = (await gezel.task.get(draftRef).catch(() => null)) as DraftView | null;
  const steps = draft?.craftbook?.steps ?? [];
  const terminals = steps.filter((s) => s.terminal);
  const verifiers = terminals.filter((s) => VERIFY_RE.test(s.prompt ?? ''));
  ok = verifiers.length >= 1;
  if (ok) {
    message = `Final verification step present ("${verifiers[0]?.name ?? verifiers[0]?.id}").`;
  } else if (terminals.length === 0) {
    message =
      'The plan has no terminal step. Append a final verification step (terminal: true) whose prompt checks each outcome via verify_outcome({ ref, id, met, evidence }) and then calls set_task_status({ complete }).';
  } else {
    message = `The plan's terminal step does not verify outcomes. Make the final step call verify_outcome for each outcome (citing the produced artifact as evidence) and then set_task_status({ complete }).`;
  }
}

gezel.output(gateResult(ok, message));
