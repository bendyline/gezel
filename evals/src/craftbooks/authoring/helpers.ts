import {
  type Craftbook,
  type CraftbookStep,
  type CraftbookSummary,
  type GateScriptRef,
  type Task,
  normalizeStepGate,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { postSniffFeedback } from '../../sniff-feedback.ts';
import type { EvalContext, SuccessCheckResult } from '../../types.ts';
import { findProjectIdByName } from '../shared.ts';

/**
 * Shared plumbing for the craftbook AUTHORING scenarios (the format A/B
 * matrix — see [bin/ab-craftbook-format.ts](../../bin/ab-craftbook-format.ts)).
 * These scenarios grade whether a model can author / repair / select a
 * craftbook, so the graders here read the craftbook catalog and the task
 * graph rather than sniffing one artifact. Everything workspace-shaped is
 * reused from [shared.ts](../shared.ts) and [gates.ts](../gates.ts).
 *
 * IMPORTANT: scenario prompts must stay format-blind — they never name the
 * craftbook document codec. The A/B lever is `GEZEL_CRAFTBOOK_DOC_FORMAT`
 * on the trial daemon, threaded via `TrialOptions.craftbookDocFormat`.
 */

/**
 * The anti-detour rule every authoring scenario pins into the project
 * about AND its kickoff message. The first smoke trial showed why: the
 * meester created a fresh project for "the craftbook work", stranding the
 * seeded fixture (and the grader) in the original project — the model
 * then authored a perfectly good book the eval couldn't credit.
 */
export const AUTHORING_PROJECT_PIN =
  'Do ALL work inside THIS project — never create another project for this job (no start_project / create_project). ' +
  "The seeded input files and the graded outputs live in THIS project's workspace; work done in any other project is invisible to the evaluation.";

/**
 * Steer the model onto the craftbook tool surface. The first matrix trial
 * showed the failure this prevents: the meester delegated the whole job as
 * ad-hoc file work (`delegate_builder` → bare `write_file`s) and never
 * touched a craftbook tool, so no reusable recipe ever existed. The A/B
 * measures whether a model can EMIT/EDIT the craftbook document — tool
 * discovery is not the variable under test, so the prompt names the
 * surface. Deliberately format-blind: tool names only, never the codec.
 */
export const AUTHORING_TOOL_STEER =
  'The deliverable of the authoring part is the CRAFTBOOK ITSELF, and you must author it YOURSELF, in this chat, ' +
  'BEFORE any delegation. You HAVE the two tools this needs: craftbook_read and craftbook_write. ' +
  'First call craftbook_read on any existing book with the full-document format to see the document shape, then save ' +
  'your new book in one call with craftbook_write (create: true, content: the full document). If craftbook_write ' +
  'reports validation problems, fix them and call it again with the corrected FULL document. ' +
  'Do NOT delegate the authoring to another gezel and do NOT have anyone write the output files by hand first — ' +
  'files written without a saved reusable craftbook do not count. Only after craftbook_write succeeds should you ' +
  'invoke the book (invoke_craftbook) and let the crew execute its steps. ' +
  'Work autonomously: never stop to ask which approach to take — author the book now.';

/**
 * About-prose for the dedicated authoring worker. The meester persona is
 * structurally wrong for the authoring scenarios: its role summary says
 * "does not build directly" and its prelude is delegation-heavy, so on a
 * 27B it confabulated "craftbook_read/craftbook_write are not in my
 * toolset" THREE runs in a row — with both tools verifiably present in
 * its post-cap tool list. A worker whose whole persona IS craftbook
 * authorship removes that friction; the A/B measures document emission,
 * not persona wrangling. Role 'Voorman' keeps the craftbooks toolset
 * group + a generous cap on medium tiers.
 */
const AUTHORING_WORKER_ABOUT = [
  'You are the recipe smith of this workshop: you author and maintain reusable craftbooks',
  '(step-by-step recipes with gated deliverables) and then run them.',
  'Your working loop: read an existing book with craftbook_read (full-document format) to see',
  'the document shape; author or edit a book and save it in ONE call with craftbook_write',
  '(create: true for a new book, content: the FULL document); if craftbook_write reports',
  'validation problems, fix them and resend the corrected full document; then invoke the book',
  'with invoke_craftbook and drive the resulting task to completion.',
  'You do the authoring YOURSELF — never delegate the authoring, never stop to ask which',
  'approach to take, and never substitute ad-hoc file writing for saving the craftbook.',
].join(' ');

/** Find-or-create the dedicated authoring worker and return its gezel id. */
export async function ensureAuthoringWorker(ctx: EvalContext, name: string): Promise<string> {
  try {
    const created = await ctx.client.createGezel({
      name,
      role: 'Voorman',
      description: 'Authors and runs reusable craftbooks.',
      about: AUTHORING_WORKER_ABOUT,
    });
    ctx.log(`[authoring:setup] created authoring worker "${name}" id=${created.id}`);
    return created.id;
  } catch (err) {
    const { gezels } = await ctx.client.listGezels();
    const existing = gezels.find((gezel) => gezel.name === name);
    if (!existing) throw err;
    ctx.log(`[authoring:setup] reusing authoring worker "${name}" id=${existing.id}`);
    return existing.id;
  }
}

/** Send the scenario kickoff directly to the authoring worker, scoped to the project. */
export async function sendWorkerKickoff(
  ctx: EvalContext,
  workerId: string,
  projectId: string,
  message: string,
): Promise<void> {
  await ctx.client.sendChatMessage(workerId, { message, projectId });
  ctx.log(`[authoring:setup] sent kickoff to worker ${workerId} in project ${projectId}`);
}

/** Find-or-create the scenario project and return its id. */
export async function ensureAuthoringProject(
  ctx: EvalContext,
  opts: { name: string; about: string; missionObjectives: string },
): Promise<string> {
  const existing = await findProjectIdByName(ctx.client, opts.name);
  if (existing) {
    ctx.log(`[authoring:setup] reusing project "${opts.name}" id=${existing}`);
    return existing;
  }
  const created = await ctx.client.createProject({
    name: opts.name,
    about: `${opts.about}\n\n### Eval harness rules\n${AUTHORING_PROJECT_PIN}`,
    missionObjectives: `${opts.missionObjectives}\n${AUTHORING_PROJECT_PIN}`,
  });
  ctx.log(`[authoring:setup] created project "${opts.name}" id=${created.id}`);
  return created.id;
}

/**
 * Send the scenario kickoff to the Meester scoped to the scenario
 * project. Authoring scenarios use `skipInitialPrompt: true` because the
 * runner's default kickoff lands in the `default` project — the authored
 * book + task graph must live in the seeded project the grader watches.
 */
export async function sendMeesterKickoff(
  ctx: EvalContext,
  projectId: string,
  message: string,
): Promise<void> {
  await ctx.client.sendChatMessage(ctx.meesterId, { message, projectId });
  ctx.log(`[authoring:setup] sent kickoff to meester in project ${projectId}`);
}

/**
 * Model-authored (non-bundled) craftbooks visible to the project: local
 * books plus project-scoped books. Trial daemons boot with a fresh
 * GEZEL_HOME, so any non-bundled book was authored during this trial.
 */
export async function authoredCraftbookSummaries(
  client: GezelClient,
  projectId: string,
): Promise<CraftbookSummary[]> {
  const { craftbooks } = await client.listCraftbooks({ source: 'all', projectId });
  return craftbooks.filter((cb) => cb.source !== 'bundled');
}

export interface AuthoredCraftbookMatch {
  summary: CraftbookSummary;
  craftbook: Craftbook;
}

/**
 * Best model-authored craftbook for the scenario: prefers a `nameHint`
 * match (id or name), then the highest step count. Returns `null` when no
 * authored book with at least `minSteps` steps exists yet.
 */
export async function findAuthoredCraftbook(
  client: GezelClient,
  opts: { projectId: string; minSteps: number; nameHint?: RegExp },
): Promise<AuthoredCraftbookMatch | null> {
  const summaries = await authoredCraftbookSummaries(client, opts.projectId);
  const eligible = summaries.filter((cb) => cb.stepCount >= opts.minSteps);
  if (eligible.length === 0) return null;
  const hintScore = (cb: CraftbookSummary): number =>
    opts.nameHint && (opts.nameHint.test(cb.id) || opts.nameHint.test(cb.name)) ? 1 : 0;
  eligible.sort((a, b) => hintScore(b) - hintScore(a) || b.stepCount - a.stepCount);
  const best = eligible[0];
  if (!best) return null;
  const { craftbook } = await client.getCraftbook(best.id, {
    source: best.source === 'bundled' ? undefined : best.source,
    projectId: opts.projectId,
  });
  return { summary: best, craftbook };
}

/** A task sourced from (or embedding) the given craftbook id. */
export function taskReferencesCraftbook(task: Task, craftbookId: string): boolean {
  if (task.craftbook.id === craftbookId) return true;
  return (task.sourceCraftbookIds ?? []).some((source) => source.catalogId === craftbookId);
}

export async function findTaskForCraftbook(
  client: GezelClient,
  projectId: string,
  craftbookId: string,
): Promise<Task | null> {
  const { tasks } = await client.listProjectTasks(projectId);
  return tasks.find((task) => taskReferencesCraftbook(task, craftbookId)) ?? null;
}

/**
 * Grader resilience against the new-project detour: find the task sourced
 * from `craftbookId` in ANY project, preferring `preferredProjectId`.
 * Returns the task plus the project it actually lives in, so callers
 * grade THAT project's workspace. The prompt-side pin makes the detour
 * rare; this makes it non-fatal — real authored work still gets credit.
 */
export async function findTaskForCraftbookAnywhere(
  client: GezelClient,
  preferredProjectId: string,
  craftbookId: string,
): Promise<{ task: Task; projectId: string } | null> {
  const preferred = await findTaskForCraftbook(client, preferredProjectId, craftbookId);
  if (preferred) return { task: preferred, projectId: preferredProjectId };
  const { projects } = await client.listProjects();
  for (const project of projects) {
    if (project.id === preferredProjectId) continue;
    const task = await findTaskForCraftbook(client, project.id, craftbookId).catch(() => null);
    if (task) return { task, projectId: project.id };
  }
  return null;
}

/** Gated = the runtime can hold the step: a gate or an advanceWhen. */
export function isStepGated(step: Pick<CraftbookStep, 'gate' | 'advanceWhen'>): boolean {
  return step.gate !== undefined || step.advanceWhen !== undefined;
}

/** Ids of non-terminal (build) steps with neither a gate nor an advanceWhen. */
export function ungatedBuildStepIds(
  steps: ReadonlyArray<Pick<CraftbookStep, 'id' | 'terminal' | 'gate' | 'advanceWhen'>>,
): string[] {
  return steps.filter((step) => !step.terminal && !isStepGated(step)).map((step) => step.id);
}

/** `scope: 'craftbook'` script refs on a step's gate (normalized across gate generations). */
export function craftbookGateScriptRefs(step: Pick<CraftbookStep, 'gate'>): GateScriptRef[] {
  if (!step.gate) return [];
  return normalizeStepGate(step.gate).scripts.filter((ref) => ref.scope === 'craftbook');
}

/**
 * Anti-stub floor for custom inline gate scripts. A bare always-approve
 * (`gezel.output(gateResult(true))` and nothing else) must not pass:
 * require real length, an import from `@bendyline/gezel-sdk/checks`, and
 * the `gezel.output(gateResult(...))` stamp the runtime contract demands.
 */
export function checkGateScriptSubstance(
  source: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  const text = (source ?? '').trim();
  if (text.length < 200) {
    return {
      ok: false,
      reason: `gate script source is ${text.length} chars — too short to be a real check (a bare always-approve stub does not count); import from @bendyline/gezel-sdk/checks and verify the deliverable`,
    };
  }
  if (!/["']@bendyline\/gezel-sdk\/checks["']/.test(text)) {
    return {
      ok: false,
      reason:
        'gate script does not import from "@bendyline/gezel-sdk/checks" — use the checks helpers to verify the deliverable instead of approving unconditionally',
    };
  }
  if (/from\s+["'](?:node:)?fs(?:\/promises)?["']/.test(text)) {
    return {
      ok: false,
      reason:
        'gate script imports raw fs — it runs in an isolated scratch dir and can never see the workspace deliverable (reads ENOENT forever); use gezel.fs or workspaceFromGezel(gezel) instead',
    };
  }
  if (!/\bgateResult\s*\(/.test(text)) {
    return {
      ok: false,
      reason:
        'gate script never calls gateResult(...) — the gate contract requires stamping a structured result',
    };
  }
  if (!/\bgezel\.output\s*\(/.test(text)) {
    return {
      ok: false,
      reason:
        'gate script never calls gezel.output(...) — the runtime reads the gate decision from the script output stamp',
    };
  }
  return { ok: true };
}

/** Parse a JSON deliverable and require a non-empty array of objects. */
export function parseJsonRecords(
  text: string | null,
  path: string,
  minRecords: number,
): { ok: true; records: Array<Record<string, unknown>> } | { ok: false; reason: string } {
  if (text === null) return { ok: false, reason: `${path} does not exist yet` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${path} is not valid JSON: ${msg.slice(0, 160)}` };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      reason: `${path} must be a top-level array of records, got ${typeof parsed}`,
    };
  }
  if (parsed.length < minRecords) {
    return {
      ok: false,
      reason: `${path} has ${parsed.length} records; expected at least ${minRecords}`,
    };
  }
  for (const [index, record] of parsed.entries()) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return { ok: false, reason: `${path} record ${index} is not an object` };
    }
  }
  return { ok: true, records: parsed as Array<Record<string, unknown>> };
}

/** Parse a JSON deliverable and require any object or array payload. */
export function parseJsonValue(
  text: string | null,
  path: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (text === null) return { ok: false, reason: `${path} does not exist yet` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${path} is not valid JSON: ${msg.slice(0, 160)}` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, reason: `${path} must contain a structured (object or array) payload` };
  }
  return { ok: true, value: parsed };
}

export interface AuthoringPollArgs {
  scenarioId: string;
  projectId: string;
  /** Total number of graded milestones — `score = total - failures`. */
  totalChecks: number;
  /** Ordered failure list; the first entry drives the repair nudge. */
  failures: string[];
  /** Monotonic-ish progress proxy for the runner's fingerprint. */
  bytes: number;
  /** Virtual surface named in the feedback message (not a real file). */
  repairPath: string;
  repairDirective: string;
  successReason: string;
}

/**
 * Terminal bookkeeping shared by every authoring `successCheck` poll:
 * record the sniff for the progress fingerprint, log the changed state,
 * finish on zero failures, otherwise post one deduped repair nudge and
 * keep polling. `expectedDeliverable: null` — the fixes are craftbook /
 * task tool calls, not a direct file write.
 */
export async function finishAuthoringPoll(
  ctx: EvalContext,
  args: AuthoringPollArgs,
): Promise<SuccessCheckResult> {
  const score = Math.max(0, args.totalChecks - args.failures.length);
  ctx.recordSniff?.({
    key: args.scenarioId,
    score,
    bytes: args.bytes,
    ...(args.failures[0] !== undefined ? { failReason: args.failures[0] } : {}),
  });
  ctx.logChanged(
    `authoring:${args.scenarioId}`,
    `[scenario] ${args.scenarioId} checks=${score}/${args.totalChecks} failures=${args.failures.join(' | ') || 'none'}`,
  );
  if (args.failures.length === 0) {
    return { done: true, success: true, reason: args.successReason };
  }
  await postSniffFeedback(
    ctx,
    args.repairPath,
    {
      ok: false,
      signals: [],
      score,
      failReason: args.failures[0],
      missingRequiredSignals: args.failures.slice(0, 4),
    },
    {
      projectId: args.projectId,
      expectedDeliverable: null,
      repairDirective: args.repairDirective,
    },
  );
  return { done: false };
}

/** Sum of text lengths — a cheap monotonic-ish progress proxy. */
export function progressBytes(...parts: Array<string | null | undefined>): number {
  return parts.reduce((acc, part) => acc + (part?.length ?? 0), 0);
}

/**
 * Count craftbook-surface tool calls across the project's sessions —
 * folded into the progress proxy so ACTIVE AUTHORING moves the sniff.
 * Without this, a slow model iterating on `craftbook_write` validation
 * (each full-document attempt is ~90s of generation on a 27B) looks
 * identical to a stall and the retry-loop watchdog guillotines it
 * mid-recovery — wild-caught on the v6 matrix, where the book landed
 * seconds after the kill fired.
 */
export async function countCraftbookToolCalls(
  ctx: EvalContext,
  projectId: string,
): Promise<number> {
  const maybeClient = ctx.client as unknown as {
    listChatSessions?: (filter?: { projectId?: string }) => Promise<{
      sessions: Array<{ id: string; messages?: Array<{ toolCalls?: Array<{ name?: string }> }> }>;
    }>;
    getChatSession?: (
      sessionId: string,
    ) => Promise<{ messages?: Array<{ toolCalls?: Array<{ name?: string }> }> }>;
  };
  if (
    typeof maybeClient.listChatSessions !== 'function' ||
    typeof maybeClient.getChatSession !== 'function'
  ) {
    return 0;
  }
  try {
    const { sessions } = await maybeClient.listChatSessions({ projectId });
    let count = 0;
    for (const listed of sessions ?? []) {
      const session = listed.messages ? listed : await maybeClient.getChatSession(listed.id);
      for (const message of session.messages ?? []) {
        for (const call of message.toolCalls ?? []) {
          const name = call.name ?? '';
          if (
            name.startsWith('craftbook_') ||
            name === 'invoke_craftbook' ||
            name === 'suggest_craftbook'
          ) {
            count++;
          }
        }
      }
    }
    return count;
  } catch {
    return 0;
  }
}
