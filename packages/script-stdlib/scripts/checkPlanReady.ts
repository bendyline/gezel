import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';
import { gateResult } from '@bendyline/gezel-sdk/checks';

/**
 * Plan gate (runs on a plan-AUTHORING task): the aggregate readiness check for
 * a draft plan — a substantial about + ≥3 outcomes, every build step gated on a
 * concrete deliverable, and a terminal verification step. Combines
 * checkPlanFramed + checkStepsHaveDeliverables + checkVerificationStep so the
 * final review step rejects with the full list of remaining gaps at once.
 */
export const meta = defineScript({
  name: 'checkPlanReady',
  description:
    "Plan gate: the draft plan is ready for the user — strong about + ≥3 outcomes, every build step gated on a concrete deliverable, and a terminal verification step. Reads the draft via the authoring task's craftbookParams.draftRef.",
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
    message: { type: 'string', description: 'What passed, or the concrete gaps to fix.' },
  },
  requires: ['tasks.read'],
} as const);

interface StepView {
  id: string;
  name?: string;
  prompt?: string;
  terminal?: boolean;
  advanceWhen?: { file?: string } | null;
  gate?: { checks?: unknown[]; scripts?: unknown[] } | null;
}
interface DraftView {
  description?: string;
  outcomes?: { text?: string }[];
  craftbookParams?: Record<string, string>;
  craftbook?: { steps?: StepView[] };
}

const VERIFY_RE = /outcome|verify_outcome|set_task_status/i;

function isGated(s: StepView): boolean {
  const hasGate =
    !!s.gate && ((s.gate.checks?.length ?? 0) > 0 || (s.gate.scripts?.length ?? 0) > 0);
  return hasGate || !!s.advanceWhen?.file;
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
  const steps = draft?.craftbook?.steps ?? [];
  const buildSteps = steps.filter((s) => !s.terminal);
  const bare = buildSteps.filter((s) => !isGated(s));
  const hasVerifier = steps.some((s) => s.terminal && VERIFY_RE.test(s.prompt ?? ''));

  const gaps: string[] = [];
  if (desc.length < 120)
    gaps.push('the about is too thin (write a clear job-to-be-done via update_task)');
  if (outcomes.length < 3) gaps.push('fewer than 3 outcomes (add them via set_outcomes)');
  if (buildSteps.length === 0) gaps.push('no build steps (add them via craftbook_add_step)');
  if (bare.length > 0)
    gaps.push(
      `${bare.length} step(s) without a deliverable gate (${bare
        .map((s) => `"${s.name ?? s.id}"`)
        .join(', ')}) — fix with set_step_deliverable`,
    );
  if (!hasVerifier)
    gaps.push(
      'no terminal verification step (append one that calls verify_outcome then set_task_status)',
    );

  ok = gaps.length === 0;
  message = ok
    ? `Plan ${draftRef} is ready: strong about, ${outcomes.length} outcomes, ${buildSteps.length} gated build step(s), and a verification step. Summarize it for the user and tell them to review and activate it.`
    : `The plan is not ready yet — ${gaps.join('; ')}.`;
}

gezel.output(gateResult(ok, message));
