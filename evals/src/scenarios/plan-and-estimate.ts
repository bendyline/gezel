import {
  type PlanRow,
  planStructure,
  requireOrderedSections,
  wordBand,
} from '@bendyline/gezel/checks';
import { postSniffFeedback } from '../sniff-feedback.ts';
import type { SniffResult } from '../success-check.ts';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { provisionScenarioGezel } from './helpers.ts';

/**
 * Plan-and-estimate (D2 class 3): turn a brief into a plan with on-roster
 * owners, sequence-valid dependencies, and checkable done-states. The
 * user-facing plan is graded independently from the Planner's delegation
 * mechanics; `planner-file-handoff` is the separate coordination probe.
 *
 * Traps in the brief: a hard ordering constraint (movers can only be
 * booked AFTER the floor plan is signed off), a contractor who is
 * explicitly NOT allowed to own tasks (must not appear in the Owner
 * column), and a roster the owners must come from.
 */

const PROJECT_NAME = 'Harbourview Office Relocation';
const PLANNER_NAME = 'Ismay';
const IMPLEMENTER_NAME = 'Deepak';
export const PLAN_PATH = 'plan.md';

const PLAN_MUTATION_TOOLS = new Set([
  'write_file',
  'replace_in_file',
  'replace_lines',
  'append_to_file',
  'insert_at_marker',
  'apply_patch',
  'copy_artifact_to_workspace',
]);
const PLANNER_RETRY_MARKER = '[scenario collaboration check]';
const MAX_PLANNER_HANDOFF_RETRIES = 2;

export type PlanHandoffStatus = 'none' | 'pending' | 'failed' | 'completed';

interface PlanHandoffMessageLike {
  role: string;
  content: string;
  from?: { gezelId: string };
  toolCalls?: Array<{
    name: string;
    success: boolean;
    path?: string;
    argsFull?: string;
  }>;
}

export const PLAN_ROSTER = ['Beatrix', 'Cas', 'Femke', 'Joris', 'Sanne'];

export const PLAN_SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'brief.md',
    content: [
      '# Brief: relocate the studio to Harbourview by September 30',
      '',
      'We are moving the 18-person studio to the Harbourview building. Plan the move.',
      '',
      'Three workstreams MUST be planned:',
      '1. **Floor plan** — seating, meeting rooms, and the workshop corner. The floor',
      '   plan needs a formal sign-off.',
      '2. **Movers** — physical logistics. HARD CONSTRAINT: movers can only be booked',
      '   AFTER the floor plan is signed off (the quote depends on it).',
      '3. **Network** — internet, wifi, and the print/scan corner, live before day one.',
      '',
      'Ola from Brightline Fitouts is our external contractor for the workshop corner',
      'build; Ola advises and executes but CANNOT own tasks in our plan — every task',
      'owner must be a member of our own team (see team.md).',
    ].join('\n'),
  },
  {
    path: 'team.md',
    content: [
      '# Team roster (task owners come from this list)',
      '',
      '- Beatrix — studio lead',
      '- Cas — operations',
      '- Femke — design',
      '- Joris — IT',
      '- Sanne — workshop',
    ].join('\n'),
  },
];

export const PLAN_MISSION_OBJECTIVES = [
  'Produce plan.md for the Harbourview relocation with sections Objective, Assumptions,',
  'Work plan, Risks — the Work plan as a Markdown table with columns',
  'ID | Task | Owner | Depends on | Done when (at least 8 rows). Owners come from',
  'team.md (Beatrix, Cas, Femke, Joris, Sanne); the external contractor Ola must not',
  'own tasks. Dependencies must reference earlier rows only — booking the movers',
  'depends on the floor plan sign-off. Cover the floor plan, movers, and network',
  'workstreams. Keep the whole plan under 1200 words.',
].join(' ');

export const PLAN_IMPLEMENTER_BRIEF = [
  'Write the complete relocation plan as `plan.md` in this project workspace.',
  'The project is fully specified; do not ask the user for more input. Use the supplied',
  'project context from brief.md and team.md: move the 18-person studio to Harbourview',
  'by September 30; plan seating, meeting rooms, the workshop corner, physical movers,',
  'internet/wifi, and the print/scan corner; the network must be live before day one.',
  'Ola from Brightline Fitouts advises and executes the workshop build but cannot own',
  'a task. Structure: four sections in order —',
  'Objective, Assumptions,',
  'Work plan, Risks. The Work plan section is a Markdown table with columns exactly',
  '`ID | Task | Owner | Depends on | Done when` and at least 8 rows: IDs like T1, T2, …;',
  'every Owner from the team.md roster (Beatrix, Cas, Femke, Joris, Sanne — the',
  'contractor Ola cannot own tasks); "Depends on" lists earlier row IDs (or "-");',
  '"Done when" is an observable completion state, not "done". Respect the hard',
  'ordering constraint: booking the movers depends on the floor plan sign-off row.',
  'Cover all three workstreams: floor plan, movers, network. Keep the whole document',
  'under 1200 words. Write the file before replying; return only its path and a short precis.',
].join(' ');

export interface PlanHandoffArgs {
  gezel: string;
  project: string;
  question: string;
  timeoutMs: number;
  expectedDeliverable: { kind: 'file'; filePath: typeof PLAN_PATH };
}

/**
 * The Planner role is intentionally coordination-only: it has team tools but no
 * workspace read/write groups. Give it a deterministic synchronous handoff to a
 * writable implementer instead of asking it to imitate a workspace worker.
 */
export function planHandoffArgs(implementerId: string, projectId: string): PlanHandoffArgs {
  return {
    gezel: implementerId,
    project: projectId,
    question: PLAN_IMPLEMENTER_BRIEF,
    timeoutMs: 15 * 60_000,
    expectedDeliverable: { kind: 'file', filePath: PLAN_PATH },
  };
}

export function planKickoffMessage(implementerId: string, projectId: string): string {
  const handoff = planHandoffArgs(implementerId, projectId);
  return [
    'This relocation brief is fully specified. You are the coordination-only Planner:',
    'you deliberately do not have project-workspace read or write tools. Do not call',
    '`read_document` for brief.md or team.md — that tool reads the global document',
    'library, not this project workspace. Do not ask the user for files or clarification.',
    '',
    'Deepak is the writable Developer already assigned to this project. Your next and only',
    'action must be this blocking file handoff:',
    `ask_gezel(${JSON.stringify(handoff)})`,
    '',
    '`ask_gezel` waits for the Developer and the expected-deliverable contract makes them',
    'write plan.md in this project before replying. When it returns, do not recreate the',
    'file or start another handoff; end with a one-sentence status using the returned path.',
  ].join('\n');
}

// Stable user-shaped evidence for grader lint; setup substitutes real ids.
export const PLAN_KICKOFF_MESSAGE = planKickoffMessage('<developer-gezel-id>', '<project-id>');

function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^workspace\//i, '')
    .replace(/\/+/g, '/')
    .toLowerCase();
}

function isPlannerFileHandoffMessage(
  message: PlanHandoffMessageLike,
  plannerId: string,
  filePath: string,
): boolean {
  if (message.role !== 'user' || message.from?.gezelId !== plannerId) return false;
  const annotatedPath = message.content.match(
    /\[Deliverable expected as a FILE at `([^`]+)`\./i,
  )?.[1];
  return (
    annotatedPath !== undefined &&
    normalizeWorkspacePath(annotatedPath) === normalizeWorkspacePath(filePath)
  );
}

function assistantMutatedPlan(message: PlanHandoffMessageLike, filePath: string): boolean {
  if (message.role !== 'assistant') return false;
  return (message.toolCalls ?? []).some(
    (call) =>
      call.success &&
      PLAN_MUTATION_TOOLS.has(call.name) &&
      typeof call.path === 'string' &&
      normalizeWorkspacePath(call.path) === normalizeWorkspacePath(filePath),
  );
}

/**
 * Target-side proof that the Planner's file handoff was more than a tool
 * attempt: the Developer received the runtime's file-deliverable annotation
 * from that Planner, then successfully mutated the requested file in the
 * immediately following assistant turn. A later Meester/harness rescue is a
 * new user turn with a different `from.gezelId`, so it cannot satisfy this.
 */
export function planHandoffStatusForMessages(
  messages: readonly PlanHandoffMessageLike[],
  plannerId: string,
  filePath = PLAN_PATH,
): PlanHandoffStatus {
  let latest: PlanHandoffStatus = 'none';
  for (let i = 0; i < messages.length; i++) {
    if (!isPlannerFileHandoffMessage(messages[i]!, plannerId, filePath)) continue;

    latest = 'pending';
    for (let j = i + 1; j < messages.length; j++) {
      const response = messages[j]!;
      if (response.role === 'user') {
        latest = 'failed';
        break;
      }
      if (response.role !== 'assistant') continue;
      latest = assistantMutatedPlan(response, filePath) ? 'completed' : 'failed';
      if (latest === 'completed') return latest;
      break;
    }
  }
  return latest;
}

// ─────────────────────────────────────────────────────────────────────
// Pure grader.

const REQUIRED_SECTIONS = ['Objective', 'Assumptions', 'Work plan', 'Risks'];
const FLOOR_PLAN_RE = /floor[\s-]*plan/i;

const WORKSTREAM_SIGNALS: Array<{ signal: string; re: RegExp; label: string }> = [
  { signal: 'ws-floor-plan', re: FLOOR_PLAN_RE, label: 'the floor plan workstream' },
  { signal: 'ws-movers', re: /movers?\b/i, label: 'the movers workstream' },
  { signal: 'ws-network', re: /network|wifi|internet/i, label: 'the network workstream' },
];

function rowText(row: PlanRow): string {
  return `${row.task} ${row.doneWhen}`;
}

function dependsOnAny(
  rows: readonly PlanRow[],
  startId: string,
  targets: ReadonlySet<string>,
): boolean {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (targets.has(id)) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return (byId.get(id)?.dependsOn ?? []).some(visit);
  };
  return (byId.get(startId)?.dependsOn ?? []).some(visit);
}

function moverBookingDependsOnFloorSignoff(rows: readonly PlanRow[]): {
  ok: boolean;
  detail?: string;
} {
  const floorSignoffs = rows.filter((row) => {
    const text = rowText(row);
    return FLOOR_PLAN_RE.test(text) && /sign[\s-]*off|signed|approv(?:e|ed|al)/i.test(text);
  });
  if (floorSignoffs.length === 0) {
    return {
      ok: false,
      detail: 'no Work plan row represents formal floor-plan sign-off',
    };
  }
  const moverBookings = rows.filter((row) => {
    const text = rowText(row);
    return /(?:book|confirm|contract)[^|]{0,40}movers?|movers?[^|]{0,40}(?:book|confirm|contract)/i.test(
      text,
    );
  });
  if (moverBookings.length === 0) {
    return { ok: false, detail: 'no Work plan row books the movers' };
  }
  const signoffIds = new Set(floorSignoffs.map((row) => row.id));
  const unsequenced = moverBookings.find((row) => !dependsOnAny(rows, row.id, signoffIds));
  return unsequenced
    ? {
        ok: false,
        detail: `row ${unsequenced.id} books the movers but does not depend on the floor-plan sign-off row (${[...signoffIds].join(', ')})`,
      }
    : { ok: true };
}

export function checkRelocationPlan(markdown: string): SniffResult {
  const signals: string[] = [];
  let failReason: string | undefined;
  const fail = (reason: string) => {
    failReason ??= reason;
  };

  const sections = requireOrderedSections(markdown, REQUIRED_SECTIONS);
  if (sections.ok) signals.push('ordered-sections');
  else
    fail(
      `missing/mis-ordered section: add an "## ${sections.missing}" heading in order (Objective, Assumptions, Work plan, Risks)`,
    );

  const plan = planStructure(markdown, {
    minRows: 8,
    ownerRoster: PLAN_ROSTER,
    requireEarlierOnly: true,
  });
  if (!plan.ok) {
    fail(`plan table: ${plan.detail}`);
  } else {
    const sequencing = moverBookingDependsOnFloorSignoff(plan.rows);
    if (sequencing.ok) signals.push('plan-structure');
    else fail(`plan table: ${sequencing.detail}`);
  }

  for (const ws of WORKSTREAM_SIGNALS) {
    if (plan.rows.some((row) => ws.re.test(rowText(row)))) signals.push(ws.signal);
    else
      fail(
        `the Work plan table never covers ${ws.label} — mentioning it elsewhere does not assign actionable work`,
      );
  }

  const band = wordBand(markdown, { max: 1200 });
  if (band.ok) signals.push('word-ceiling');
  else fail(`too long: ${band.detail} — plans must stay under 1200 words`);

  const requiredCount = 1 + 1 + WORKSTREAM_SIGNALS.length + 1;
  return {
    ok: signals.length >= requiredCount,
    signals,
    score: signals.length,
    ...(failReason ? { failReason } : {}),
  };
}

export function planRepairDirective(): string {
  return [
    `Patch \`${PLAN_PATH}\` to fix exactly the named gap. The Work plan table needs`,
    'columns `ID | Task | Owner | Depends on | Done when`, owners from team.md only',
    '(never the contractor), dependencies pointing at EARLIER rows, and observable',
    '"Done when" states. Your next tool call should be write_file (or replace_in_file)',
    'on plan.md.',
  ].join(' ');
}

// ─────────────────────────────────────────────────────────────────────
// Harness plumbing.

async function findProjectId(client: EvalContext['client']): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function findImplementerId(client: EvalContext['client']): Promise<string | undefined> {
  const { gezels } = await client.listGezels();
  return gezels.find((gezel) => gezel.name === IMPLEMENTER_NAME)?.id;
}

async function findPlannerId(client: EvalContext['client']): Promise<string | undefined> {
  const { gezels } = await client.listGezels();
  return gezels.find((gezel) => gezel.name === PLANNER_NAME)?.id;
}

async function loadGezelProjectSessions(
  client: EvalContext['client'],
  gezelId: string,
  projectId: string,
): Promise<
  Array<{
    id: string;
    lastActivityAt: string;
    messages: PlanHandoffMessageLike[];
  }>
> {
  try {
    const { sessions } = await client.listChatSessions({ gezelId, projectId });
    const full = await Promise.all(
      sessions.map(async (summary) => {
        const session = await client.getChatSession(summary.id).catch(() => null);
        return session
          ? {
              id: session.id,
              lastActivityAt: session.lastActivityAt,
              messages: session.messages,
            }
          : null;
      }),
    );
    return full.filter((session): session is NonNullable<typeof session> => session !== null);
  } catch {
    return [];
  }
}

async function planHandoffStatus(
  client: EvalContext['client'],
  plannerId: string,
  implementerId: string,
  projectId: string,
): Promise<PlanHandoffStatus> {
  const sessions = await loadGezelProjectSessions(client, implementerId, projectId);
  const statuses = sessions.map((session) =>
    planHandoffStatusForMessages(session.messages, plannerId),
  );
  if (statuses.includes('completed')) return 'completed';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('failed')) return 'failed';
  return 'none';
}

function plannerAlreadyIssuedSuccessfulHandoff(
  messages: readonly PlanHandoffMessageLike[],
): boolean {
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant');
  return (lastAssistant?.toolCalls ?? []).some(
    (call) =>
      call.success &&
      (call.name === 'ask_gezel' || call.name === 'message_gezel') &&
      call.argsFull?.includes('expectedDeliverable:') === true &&
      call.argsFull.includes(PLAN_PATH),
  );
}

function plannerHandoffRetryMessage(implementerId: string, projectId: string): string {
  return [
    PLANNER_RETRY_MARKER,
    `The Developer has not completed your required \`${PLAN_PATH}\` handoff.`,
    'Do not put a file declaration inside `checks`; `checks` is only for completion gates.',
    'Your next and only action must be this exact blocking call:',
    `ask_gezel(${JSON.stringify(planHandoffArgs(implementerId, projectId))})`,
    'After it returns, end with one sentence containing the returned path.',
  ].join('\n');
}

async function maybeRetryPlannerHandoff(
  ctx: EvalContext,
  plannerId: string,
  implementerId: string,
  projectId: string,
  status: PlanHandoffStatus,
): Promise<void> {
  if (status === 'pending' || status === 'completed') return;
  const sessions = await loadGezelProjectSessions(ctx.client, plannerId, projectId);
  const latest = sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
  if (!latest || latest.messages.at(-1)?.role !== 'assistant') return;

  const retryCount = latest.messages.filter(
    (message) => message.role === 'user' && message.content.includes(PLANNER_RETRY_MARKER),
  ).length;
  if (retryCount >= MAX_PLANNER_HANDOFF_RETRIES) return;

  // A successful async call can commit just before its parked target send
  // becomes visible. Avoid racing that dispatch; a delivered target message
  // will move the status to pending/completed on a later poll.
  if (status === 'none' && plannerAlreadyIssuedSuccessfulHandoff(latest.messages)) return;

  await ctx.client.sendChatMessage(plannerId, {
    projectId,
    message: plannerHandoffRetryMessage(implementerId, projectId),
  });
  ctx.log(
    `[scenario] asked ${PLANNER_NAME} to retry the exact blocking ${PLAN_PATH} handoff (${retryCount + 1}/${MAX_PLANNER_HANDOFF_RETRIES})`,
  );
}

async function readWorkspaceText(
  client: EvalContext['client'],
  projectId: string,
  filePath: string,
): Promise<string | null> {
  try {
    const blob = await client.fetchProjectWorkspaceBlob(projectId, filePath);
    return await blob.text();
  } catch {
    return null;
  }
}

async function ensureProjectAndSeed(ctx: EvalContext): Promise<string> {
  const { client, log } = ctx;
  let projectId = await findProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Planning the studio relocation to the Harbourview building: floor plan, movers, ' +
        'and network workstreams, owned by the in-house team per the brief.',
      missionObjectives: PLAN_MISSION_OBJECTIVES,
    });
    projectId = created.id;
    log(`[scenario:setup] created project name="${PROJECT_NAME}" id=${projectId}`);
  }
  if (!projectId) throw new Error('plan-and-estimate setup: failed to resolve project id');

  for (const f of PLAN_SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${PLAN_SEED_FILES.length} brief files`);

  return projectId;
}

async function setupPlanAndEstimate(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  const projectId = await ensureProjectAndSeed(ctx);

  const implementer = await provisionScenarioGezel(ctx, {
    preferredName: IMPLEMENTER_NAME,
    role: 'Developer',
    label: 'plan author',
  });
  await client.addGezelToProject(projectId, implementer.id);

  await client.sendChatMessage(implementer.id, {
    message: PLAN_IMPLEMENTER_BRIEF,
    projectId,
  });
  log(`[scenario:setup] sent the plan brief directly to writable author ${implementer.name}`);
}

async function setupPlannerFileHandoff(ctx: EvalContext): Promise<void> {
  const { client, log } = ctx;
  const projectId = await ensureProjectAndSeed(ctx);

  const planner = await provisionScenarioGezel(ctx, {
    preferredName: PLANNER_NAME,
    role: 'Planner',
    label: 'planner',
  });
  await client.addGezelToProject(projectId, planner.id);

  const implementer = await provisionScenarioGezel(ctx, {
    preferredName: IMPLEMENTER_NAME,
    role: 'Developer',
    label: 'implementer',
  });
  await client.addGezelToProject(projectId, implementer.id);

  await client.sendChatMessage(planner.id, {
    message: planKickoffMessage(implementer.id, projectId),
    projectId,
  });
  log(
    `[scenario:setup] sent blocking handoff kickoff to ${planner.name} for implementer ${implementer.name}`,
  );
}

export const planAndEstimateScenario: EvalScenario = {
  id: 'plan-and-estimate',
  description:
    'Produces a reviewable relocation plan whose Work-plan table has on-roster owners, sequence-valid dependencies (movers after floor-plan sign-off), and checkable done-states — graded independently from the Planner-to-Developer handoff route.',
  prompt: [
    `Heads up: ${IMPLEMENTER_NAME} is drafting the relocation plan in the "${PROJECT_NAME}"`,
    "project. You do not need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [
    { signal: 'ordered-sections', pattern: /objective, assumptions,\s*work plan, risks/ },
    { signal: 'plan-structure', pattern: /id \| task \| owner \| depends on \| done when/ },
    { signal: 'ws-floor-plan', pattern: /floor plan/ },
    { signal: 'ws-movers', pattern: /movers/ },
    { signal: 'ws-network', pattern: /network/ },
    { signal: 'word-ceiling', pattern: /under 1200 words/ },
  ],
  evidenceTexts: [PLAN_MISSION_OBJECTIVES, PLAN_IMPLEMENTER_BRIEF],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup: setupPlanAndEstimate,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] relocation project not present yet');
      return { done: false };
    }
    const implementerId = await findImplementerId(client);
    if (!implementerId) {
      logChanged('crew', `[scenario] waiting for ${IMPLEMENTER_NAME} to be present`);
      return { done: false };
    }
    const markdown = await readWorkspaceText(client, projectId, PLAN_PATH);
    if (markdown === null) {
      logChanged('sniff', `[scenario] ${PLAN_PATH} not present yet score=0/6`);
      recordSniff?.({
        key: 'plan-and-estimate',
        score: 0,
        bytes: 0,
        failReason: `${PLAN_PATH} is absent`,
      });
      return { done: false };
    }
    const check = checkRelocationPlan(markdown);
    logChanged(
      'sniff',
      `[scenario] plan-and-estimate bytes=${markdown.length} score=${check.score}/6 signals=${check.signals.join(',') || 'none'}${check.failReason ? ` failReason="${check.failReason}"` : ''}`,
    );
    recordSniff?.({
      key: 'plan-and-estimate',
      score: check.score,
      bytes: markdown.length,
      ...(check.failReason ? { failReason: check.failReason } : {}),
    });
    if (check.ok) {
      return {
        done: true,
        success: true,
        reason: `Plan satisfies structure + workstreams + ceiling (signals: ${check.signals.join(', ')})`,
      };
    }
    if (check.failReason) {
      await postSniffFeedback(ctx, PLAN_PATH, check, {
        projectId,
        sourceText: markdown,
        repairDirective: planRepairDirective(),
        targetGezelId: implementerId,
      });
    }
    return { done: false };
  },
};

/**
 * Pure coordination probe. Unlike `plan-and-estimate`, this scenario does not
 * judge the plan's prose or table: it asks only whether the coordination-only
 * Planner made a file-deliverable handoff and the addressed Developer mutated
 * that file in the resulting target turn.
 */
export const plannerFileHandoffScenario: EvalScenario = {
  id: 'planner-file-handoff',
  description:
    'The coordination-only Planner makes a blocking file handoff to a writable Developer; target-side session evidence must show the Planner-origin file contract and a successful plan.md mutation in that response.',
  prompt: [
    `Heads up: ${PLANNER_NAME} is coordinating a file handoff in the "${PROJECT_NAME}"`,
    "project. You do not need to do anything — just confirm you've seen this note.",
  ].join(' '),
  requiredPromptEvidence: [{ signal: 'planner-handoff', pattern: /ask_gezel/ }],
  evidenceTexts: [PLAN_KICKOFF_MESSAGE],
  timeoutMs: 25 * 60_000,
  progressTimeoutMs: 15 * 60_000,
  setup: setupPlannerFileHandoff,
  skipInitialPrompt: true,
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    const projectId = await findProjectId(client);
    if (!projectId) {
      logChanged('project', '[scenario] relocation project not present yet');
      return { done: false };
    }
    const [plannerId, implementerId] = await Promise.all([
      findPlannerId(client),
      findImplementerId(client),
    ]);
    if (!plannerId || !implementerId) {
      logChanged(
        'crew',
        `[scenario] waiting for ${!plannerId ? PLANNER_NAME : IMPLEMENTER_NAME} to be present`,
      );
      return { done: false };
    }

    const handoffStatus = await planHandoffStatus(client, plannerId, implementerId, projectId);
    const markdown = await readWorkspaceText(client, projectId, PLAN_PATH);
    const complete = handoffStatus === 'completed' && markdown !== null;
    const failReason =
      handoffStatus === 'completed'
        ? `${PLAN_PATH} is absent after the completed Planner handoff`
        : `Planner handoff is ${handoffStatus}: ${IMPLEMENTER_NAME} must receive the ${PLAN_PATH} file contract from ${PLANNER_NAME} and successfully mutate it in that response`;

    logChanged(
      'sniff',
      `[scenario] planner-file-handoff score=${complete ? 1 : 0}/1 plannerHandoff=${handoffStatus} planPresent=${markdown !== null}${complete ? '' : ` failReason="${failReason}"`}`,
    );
    recordSniff?.({
      key: 'planner-file-handoff',
      score: complete ? 1 : 0,
      bytes: markdown?.length ?? 0,
      ...(complete ? {} : { failReason }),
    });
    if (complete) {
      return {
        done: true,
        success: true,
        reason: `Planner-origin file handoff completed and ${IMPLEMENTER_NAME} mutated ${PLAN_PATH}`,
      };
    }

    await maybeRetryPlannerHandoff(ctx, plannerId, implementerId, projectId, handoffStatus);
    return { done: false };
  },
};
