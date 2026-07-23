import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Plan gate (runs on a plan-AUTHORING task): the draft plan being built has a
 * substantial "about" and at least three outcome statements. Reads the draft
 * via the authoring task's `craftbookParams.draftRef`.
 */
export const meta = defineScript({
  name: 'checkPlanFramed',
  description:
    "Plan gate: the draft plan this authoring task is building has a substantial 'about' (description ≥ 120 chars) and at least 3 outcomes. Reads the draft via the authoring task's craftbookParams.draftRef.",
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

interface DraftView {
  description?: string;
  outcomes?: { text?: string }[];
  craftbookParams?: Record<string, string>;
}

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
  const desc = (draft?.description ?? '').trim();
  const outcomes = draft?.outcomes ?? [];
  const gaps: string[] = [];
  if (desc.length < 120) {
    gaps.push(
      `the plan's about is too thin (${desc.length}/120 chars) — call update_task({ task: "${draftRef}", description }) with a clear statement of the job to be done`,
    );
  }
  if (outcomes.length < 3) {
    gaps.push(
      `only ${outcomes.length} outcome(s) defined — call set_outcomes({ task: "${draftRef}", outcomes: [...] }) with at least 3 concrete expected results`,
    );
  }
  ok = gaps.length === 0;
  message = ok
    ? `Plan framed: about is ${desc.length} chars and ${outcomes.length} outcomes are defined.`
    : `Frame the plan before advancing: ${gaps.join('; ')}.`;
}

gezel.output(gateResult(ok, message));
