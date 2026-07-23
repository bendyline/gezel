import type { GezelClient } from '@bendyline/gezel-client';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.js';

/**
 * job-hunt-track — the bundled Job Hunt project type's rails, end to end:
 * typed create (two-gezel crew + seeds + named store tools), then one
 * conversational turn with the coach that must land a REAL application
 * record in the workspace pipeline store.
 *
 * The grader reads pipeline.json (the rosterStore document the type seeds
 * and its `application-store` script mutates). Pure verdict helpers are
 * exported for the winnable-grader unit test (job-hunt.test.ts) — they run
 * without a daemon.
 */

const PROJECT_NAME = 'Job Hunt Eval';

export const KICKOFF_MESSAGE =
  'I applied to Acme yesterday for a Staff Engineer role (through their careers page, ' +
  'no referral). Track it, and then tell me where my pipeline stands.';

export const JOB_HUNT_SIGNALS = ['application-recorded', 'event-logged', 'stage-valid'] as const;

interface PipelineDoc {
  version?: number;
  role?: unknown;
  stages?: unknown;
  records?: unknown;
}

interface ActivityDoc {
  version?: number;
  events?: unknown;
}

export interface JobHuntVerdict {
  ok: boolean;
  signals: string[];
  failReason?: string;
}

/**
 * Pure verdict over the pipeline + activity documents. Required signal:
 * an application whose company mentions Acme, in a non-empty stage.
 * Optional color: an activity event logged, and the stage being one of
 * the declared stages.
 */
export function checkPipelineTracked(
  pipeline: PipelineDoc | null,
  activity: ActivityDoc | null,
): JobHuntVerdict {
  const signals: string[] = [];
  const records = Array.isArray(pipeline?.records) ? (pipeline?.records as unknown[]) : [];
  const acme = records.find((r) => {
    const rec = r as { fields?: { company?: unknown }; status?: unknown };
    return (
      typeof rec.fields?.company === 'string' &&
      /acme/i.test(rec.fields.company) &&
      typeof rec.status === 'string' &&
      rec.status.length > 0
    );
  }) as { status?: string } | undefined;
  if (acme) signals.push('application-recorded');

  const stages = Array.isArray(pipeline?.stages) ? (pipeline?.stages as unknown[]) : [];
  if (acme && stages.includes(acme.status)) signals.push('stage-valid');

  const events = Array.isArray(activity?.events) ? (activity?.events as unknown[]) : [];
  if (events.length > 0) signals.push('event-logged');

  if (!acme) {
    return {
      ok: false,
      signals,
      failReason:
        records.length === 0
          ? 'pipeline.json has no records yet'
          : 'no record names Acme as the company',
    };
  }
  return { ok: true, signals };
}

async function readWorkspaceJson(
  client: GezelClient,
  projectId: string,
  filePath: string,
): Promise<unknown | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return JSON.parse(await blob.text());
  } catch {
    return null;
  }
}

async function findProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function setup(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  let coachId: string | null = null;
  if (!projectId) {
    const created = await client.createTypedProject({
      name: PROJECT_NAME,
      projectType: { typeId: 'job-hunt', params: { role: 'Staff Engineer' } },
    });
    projectId = created.project.id;
    coachId = created.applied.gezelsCreated.find((g) => g.voorman)?.id ?? null;
    log(
      `[scenario:setup] typed-create project id=${projectId} crew=${created.applied.gezelsCreated
        .map((g) => g.templateId)
        .join('+')} tools=${created.applied.toolsBound.join(',')}`,
    );
  } else {
    log(`[scenario:setup] reusing existing project id=${projectId}`);
  }
  if (!projectId) throw new Error('job-hunt setup: failed to resolve project id');

  if (!coachId) {
    const detail = await client.getProject(projectId);
    coachId = detail?.voormanGezelId ?? null;
  }
  if (!coachId) throw new Error('job-hunt setup: no voorman coach on the project');

  await client.sendChatMessage(coachId, { message: KICKOFF_MESSAGE, projectId });
  log(`[scenario:setup] sent kickoff to coach ${coachId} in project ${projectId}`);
}

export const jobHuntScenario: EvalScenario = {
  id: 'job-hunt-track',
  description:
    'Bundled Job Hunt type rails: typed create seeds the crew + pipeline, then the coach must ' +
    'record a mentioned application through the named store tools (or run_script) so it lands ' +
    'in workspace pipeline.json.',
  prompt: [
    `Heads up: the "${PROJECT_NAME}" project's coach is tracking a new application.`,
    "You don't need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [{ signal: 'company-named', pattern: /Acme/i }],
  evidenceTexts: [KICKOFF_MESSAGE],
  timeoutMs: 10 * 60_000,
  setup,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] job-hunt project not present yet');
      return { done: false };
    }

    const [pipeline, activity] = await Promise.all([
      readWorkspaceJson(client, projectId, 'pipeline.json'),
      readWorkspaceJson(client, projectId, 'activity.json'),
    ]);
    const verdict = checkPipelineTracked(
      pipeline as PipelineDoc | null,
      activity as ActivityDoc | null,
    );
    const records = Array.isArray((pipeline as PipelineDoc | null)?.records)
      ? ((pipeline as PipelineDoc).records as unknown[]).length
      : 0;
    logChanged(
      'sniff',
      `[scenario] job-hunt records=${records} score=${verdict.signals.length}/${JOB_HUNT_SIGNALS.length} signals=${verdict.signals.join(',') || 'none'}${verdict.failReason ? ` failReason="${verdict.failReason}"` : ''}`,
    );
    recordSniff?.({ key: 'job-hunt', score: verdict.signals.length, bytes: records });

    if (verdict.ok) {
      return {
        done: true,
        success: true,
        reason: `pipeline.json tracks the Acme application (signals: ${verdict.signals.join(', ')})`,
      };
    }
    return { done: false };
  },
};
