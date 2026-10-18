import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CreatedProject,
  type ObservedHandoff,
  type ObservedToolCall,
  type RouteVerdict,
  classifyRoute,
  handoffsFromSessions,
} from './classify.ts';
import { ROUTE_PROBES, type RouteProbe } from './probes.ts';

/**
 * Re-run the current classifier over a finished trial from what it saved —
 * the Meester's session files and each project's history — instead of the
 * verdict its success check wrote at the time. A classifier fix then reaches
 * every trial already on disk, without re-running a model.
 *
 * Reads the same evidence the live check did: the Meester's tool calls in
 * session order (arguments and results), its last reply, and the projects
 * the trial created, typed by their "Applied project type" history event.
 * Seeded projects are excluded by name, as the live check excluded them by id.
 */

const PROBES_BY_SCENARIO = new Map(ROUTE_PROBES.map((probe) => [`route-${probe.id}`, probe]));

export function probeForScenario(scenarioId: string): RouteProbe | undefined {
  return PROBES_BY_SCENARIO.get(scenarioId);
}

interface SavedSession {
  gezelId?: string;
  createdAt?: string;
  taskRef?: string;
  messages?: Array<{
    role: string;
    content: string;
    from?: { gezelId?: string; kind?: string };
    toolCalls?: Array<{ name: string; success?: boolean; argsFull?: string; resultText?: string }>;
  }>;
}

interface SavedState {
  config?: { meesterGezelId?: string };
  gezels?: { gezels?: Array<{ id: string; role?: string; roleBasedName?: string }> };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function trialTranscript(trialDir: string): Promise<{
  calls: ObservedToolCall[];
  lastReply: string;
  handoffs: ObservedHandoff[];
} | null> {
  const state = await readJson<SavedState>(join(trialDir, 'state.json'));
  const meesterId = state?.config?.meesterGezelId;
  if (!meesterId) return null;
  const files = (await readdir(join(trialDir, 'sessions')).catch(() => [] as string[])).filter(
    (name) => name.endsWith('.json'),
  );
  const all = (
    await Promise.all(files.map((name) => readJson<SavedSession>(join(trialDir, 'sessions', name))))
  )
    .filter((s): s is SavedSession => s !== null)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  const roles = new Map(
    (state?.gezels?.gezels ?? []).map((g) => [g.id, g.roleBasedName ?? g.role?.toLowerCase()]),
  );
  const handoffs = handoffsFromSessions(all, meesterId, (id) => roles.get(id));
  const sessions = all.filter((s) => s.gezelId === meesterId);
  const calls: ObservedToolCall[] = [];
  let lastReply = '';
  for (const session of sessions) {
    for (const message of session.messages ?? []) {
      if (message.role !== 'assistant') continue;
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
  return { calls, lastReply, handoffs };
}

async function createdProjects(trialDir: string, probe: RouteProbe): Promise<CreatedProject[]> {
  const dir = join(trialDir, 'project-history');
  const files = await readdir(dir).catch(() => [] as string[]);
  const out: CreatedProject[] = [];
  for (const file of files) {
    const id = file.replace(/\.jsonl$/, '');
    if (id === 'default' || id === 'shared') continue;
    const lines = (await readFile(join(dir, file), 'utf8').catch(() => '')).split('\n');
    let name: string | undefined;
    let projectTypeId: string | undefined;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as {
          kind?: string;
          details?: { name?: string; projectType?: string };
        };
        if (event.kind === 'project.created') name = event.details?.name;
        if (typeof event.details?.projectType === 'string')
          projectTypeId = event.details.projectType;
      } catch {
        // A torn last line from an interrupted trial.
      }
    }
    if (probe.seed?.project && name === probe.seed.project.name) continue;
    out.push({ id, ...(projectTypeId ? { projectTypeId } : {}) });
  }
  return out;
}

/** The verdict the current classifier gives a saved trial, or null when it saved too little. */
export async function rescoreTrial(
  trialDir: string,
  scenarioId: string,
): Promise<RouteVerdict | null> {
  const probe = probeForScenario(scenarioId);
  if (!probe) return null;
  const transcript = await trialTranscript(trialDir);
  if (!transcript) return null;
  return classifyRoute({
    calls: transcript.calls,
    createdProjects: await createdProjects(trialDir, probe),
    handoffs: transcript.handoffs,
    finished: true,
    assistantText: transcript.lastReply,
    acceptable: probe.acceptable,
  });
}
