import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Plan gate (runs on a plan-AUTHORING task): every build step of the draft
 * plan has a concrete static outcome with an enforced gate — i.e. a `gate`
 * (≥1 check or script) or an `advanceWhen.file`. Terminal steps are exempt
 * (the final step verifies outcomes, see checkVerificationStep).
 */
export const meta = defineScript({
  name: 'checkStepsHaveDeliverables',
  description:
    "Plan gate: every non-terminal build step of the draft plan has a concrete deliverable + enforced gate (a gate with checks/scripts, or an advanceWhen.file). Reads the draft via the authoring task's craftbookParams.draftRef.",
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
  terminal?: boolean;
  advanceWhen?: { file?: string } | null;
  gate?: { checks?: unknown[]; scripts?: unknown[] } | null;
}
interface DraftView {
  craftbookParams?: Record<string, string>;
  craftbook?: { steps?: StepView[] };
}

const input = gezel.input as InferredInput<typeof meta>;

function isGated(s: StepView): boolean {
  const hasGate =
    !!s.gate && ((s.gate.checks?.length ?? 0) > 0 || (s.gate.scripts?.length ?? 0) > 0);
  const hasAdvance = !!s.advanceWhen?.file;
  return hasGate || hasAdvance;
}

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
  const buildSteps = steps.filter((s) => !s.terminal);
  const bare = buildSteps.filter((s) => !isGated(s));
  if (buildSteps.length === 0) {
    message = `The plan has no build steps yet. Add ordered steps with craftbook_add_step({ task: "${draftRef}", ... }) and give each a concrete static outcome with set_step_deliverable({ task: "${draftRef}", stepId, path, kind }).`;
  } else if (bare.length > 0) {
    const names = bare.map((s) => `"${s.name ?? s.id}"`).join(', ');
    message = `These steps have no concrete deliverable + enforced gate: ${names}. For each, call set_step_deliverable({ task: "${draftRef}", stepId, path, kind }) so the step is gated on a named file.`;
  } else {
    ok = true;
    message = `All ${buildSteps.length} build step(s) are gated on a concrete deliverable.`;
  }
}

gezel.output(gateResult(ok, message));
