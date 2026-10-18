import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import {
  type CreatedProject,
  type ObservedHandoff,
  type ObservedToolCall,
  classifyRoute,
  handoffsFromSessions,
} from '../work-routing/classify.ts';
import { ROUTE_PROBES, type RouteProbe } from '../work-routing/probes.ts';

/**
 * Route probes for the suggest_work / start_work A/B (suite `work-routing`).
 *
 * One message to the Meester per trial, scored on the route it takes — the
 * first successful routing call, or a reply when it makes none — and ended
 * the moment that route is known. A trial is minutes, not the forty a first
 * project needs, which is what makes several arms × two models × three reps
 * fit in a night.
 *
 * The same probes run in every arm. Arms differ only in their behavior flags
 * (`tools.work-routing`, `prompt.work-options-prelude`), and the grader reads
 * routes, not tool names, so both surfaces are scored by one rule.
 *
 * Embeddings are on, as they are in production: craftbook ranking without
 * them is lexical-only in both arms, which would measure a configuration no
 * person runs.
 */

const PROBE_TIMEOUT_MS = 8 * 60_000;
/** A Meester that has made this many calls without routing has not routed. */
const MAX_CALLS_WITHOUT_ROUTE = 8;
const SEEDED_PROJECTS_KEY = 'work-routing:seeded-projects';
const PROBE_PROJECT_KEY = 'work-routing:project';

async function meesterCalls(
  client: GezelClient,
  meesterId: string,
): Promise<{ calls: ObservedToolCall[]; lastReply: string; replied: boolean }> {
  const { sessions } = await client.listChatSessions({ gezelId: meesterId });
  const ordered = [...(sessions ?? [])].sort((a, b) =>
    String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')),
  );
  const calls: ObservedToolCall[] = [];
  let lastReply = '';
  let replied = false;
  for (const listed of ordered) {
    const session = await client.getChatSession(listed.id);
    for (const message of session.messages ?? []) {
      if (message.role !== 'assistant') continue;
      replied = true;
      for (const call of message.toolCalls ?? []) {
        calls.push({
          name: call.name,
          ...(call.success !== undefined ? { success: call.success } : {}),
          ...(call.argsFull ? { argsFull: call.argsFull } : {}),
          ...(call.resultText ? { resultText: call.resultText } : {}),
        });
      }
      if (message.content.trim()) lastReply = message.content.trim();
    }
  }
  return { calls, lastReply, replied };
}

/**
 * Consultations and delegations the Meester has opened, read from the other
 * gezels' sessions. A consult holds the Meester's turn until the specialist
 * answers, so its call is not committed yet; the session it opened already
 * shows the route.
 */
async function meesterHandoffs(client: GezelClient, meesterId: string): Promise<ObservedHandoff[]> {
  const { sessions } = await client.listChatSessions().catch(() => ({ sessions: [] }));
  const others = (sessions ?? []).filter((s) => s.gezelId && s.gezelId !== meesterId);
  if (others.length === 0) return [];
  const full = await Promise.all(others.map((s) => client.getChatSession(s.id).catch(() => null)));
  const roles = new Map<string, string | undefined>();
  for (const gezelId of new Set(others.map((s) => s.gezelId!))) {
    const gezel = await client.getGezel(gezelId).catch(() => null);
    roles.set(gezelId, gezel?.role?.toLowerCase());
  }
  return handoffsFromSessions(
    full.filter((s): s is NonNullable<typeof s> => s !== null),
    meesterId,
    (id) => roles.get(id),
  );
}

async function createdProjects(
  client: GezelClient,
  seeded: ReadonlySet<string>,
): Promise<CreatedProject[]> {
  const { projects } = await client.listProjects();
  const out: CreatedProject[] = [];
  for (const summary of projects ?? []) {
    if (summary.id === 'default' || summary.id === 'shared' || seeded.has(summary.id)) continue;
    const project = await client.getProject(summary.id).catch(() => null);
    out.push({
      id: summary.id,
      ...(project?.projectType?.id ? { projectTypeId: project.projectType.id } : {}),
    });
  }
  return out;
}

async function seedProbe(ctx: EvalContext, probe: RouteProbe): Promise<string> {
  const { client, log } = ctx;
  const seeded = new Set<string>();
  let projectId = 'default';
  if (probe.seed?.docblocks) {
    try {
      await client.installToolset('docblocks', {
        sourceId: 'bundled',
        scope: { kind: 'shared' },
      });
      log('[scenario:setup] installed the docblocks toolset');
    } catch (err) {
      log(
        `[scenario:setup] docblocks unavailable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  if (probe.seed?.project) {
    const created = await client.createProject({
      name: probe.seed.project.name,
      about: probe.seed.project.about,
    });
    projectId = created.id;
    seeded.add(created.id);
    for (const [path, content] of Object.entries(probe.seed.project.files ?? {})) {
      await client.writeProjectWorkspaceFile(created.id, { path, content });
    }
    log(`[scenario:setup] seeded project ${created.id}`);
  }
  if (probe.seed?.runningDeckTask) {
    // Inline steps, not the PowerPoint book: the book needs the docblocks
    // toolset, and without it task creation answers 409 and the trial never
    // starts (every S1 deck-status trial, 2026-10-16). The probe only needs
    // a deck task to exist; nothing dispatches it.
    const task = await client.createTask('default', {
      title: 'Alaska deck',
      description: 'A PowerPoint presentation about Alaska for the travel club meeting next week.',
      steps: [{ name: 'Outline the slides' }, { name: 'Build the deck' }],
    });
    log(`[scenario:setup] seeded running deck task ${task.ref}`);
  }
  ctx.state?.set(SEEDED_PROJECTS_KEY, seeded);
  ctx.state?.set(PROBE_PROJECT_KEY, projectId);
  return projectId;
}

function probeScenario(probe: RouteProbe): EvalScenario {
  const inProject = Boolean(probe.seed?.project);
  return {
    id: `route-${probe.id}`,
    description: `Route probe (${probe.category}): which route the Meester takes for "${probe.prompt.slice(0, 60)}${probe.prompt.length > 60 ? '…' : ''}". Ends as soon as the route is known.`,
    prompt: probe.prompt,
    timeoutMs: PROBE_TIMEOUT_MS,
    repairPolicy: 'runtime',
    requiresEmbeddings: true,
    ...(inProject ? { skipInitialPrompt: true } : {}),
    setup: async (ctx: EvalContext): Promise<void> => {
      const projectId = await seedProbe(ctx, probe);
      if (inProject) {
        await ctx.client.sendChatMessage(ctx.meesterId, { message: probe.prompt, projectId });
        ctx.log(`[scenario:setup] sent the probe to the meester in project ${projectId}`);
      }
    },
    successCheck: async (ctx: EvalContext): Promise<SuccessCheckResult> => {
      const { client, meesterId, logChanged } = ctx;
      const seeded =
        (ctx.state?.get(SEEDED_PROJECTS_KEY) as Set<string> | undefined) ?? new Set<string>();
      const [{ calls, lastReply, replied }, inflight, projects, handoffs] = await Promise.all([
        meesterCalls(client, meesterId),
        client.listInflightTurns({ gezelId: meesterId }).catch(() => ({ inflight: [] })),
        createdProjects(client, seeded),
        meesterHandoffs(client, meesterId),
      ]);
      const finished = replied && inflight.inflight.length === 0;
      const verdict = classifyRoute({
        calls,
        createdProjects: projects,
        handoffs,
        finished: finished || calls.length >= MAX_CALLS_WITHOUT_ROUTE,
        assistantText: lastReply,
        acceptable: probe.acceptable,
      });
      logChanged(
        'route',
        `[scenario] route-${probe.id}: ${calls.length} call(s) [${calls.map((c) => c.name).join(', ')}] finished=${finished}`,
      );
      if (!verdict) return { done: false };
      const diagnostics = {
        probe: probe.id,
        category: probe.category,
        heldOut: probe.heldOut === true,
        route: verdict.route,
        accepted: verdict.accepted,
        kindAccepted: verdict.kindAccepted,
        firstCall: verdict.firstCall,
        callsBeforeRoute: verdict.callsBeforeRoute,
        fabricatedClaim: verdict.fabricatedClaim,
        calls: calls.map((c) => c.name),
      };
      const described = `${verdict.route.kind}${verdict.route.target ? `:${verdict.route.target}` : ''}${verdict.route.via ? ` via ${verdict.route.via}` : ''}`;
      return verdict.accepted
        ? { done: true, success: true, reason: `routed ${described}`, diagnostics }
        : {
            done: true,
            success: false,
            reason: `routed ${described}; acceptable: ${probe.acceptable
              .map((a) => `${a.kind}${a.target ? `:${a.target.source}` : ''}`)
              .join(' | ')}`,
            diagnostics,
          };
    },
  };
}

export function workRoutingScenarios(): EvalScenario[] {
  return ROUTE_PROBES.map(probeScenario);
}

export const WORK_ROUTING_SCENARIO_IDS: readonly string[] = ROUTE_PROBES.map(
  (probe) => `route-${probe.id}`,
);
