import { parseWorkOptionId } from '@bendyline/gezel';

/**
 * Which route the Meester took on a probe, read from what it called.
 *
 * Both arms are scored by the same reader: the old surface's
 * `invoke_craftbook` / `start_project` and the new `start_work({ option })`
 * map onto one route vocabulary, so a probe's pass criterion never mentions
 * a tool name. The FIRST successful route-determining call is the decision —
 * the runner's auto-answerer replies to a question card, and whatever the
 * model does after that answer is not what it chose on its own.
 */

export type RouteKind =
  | 'craftbook'
  | 'project-type'
  | 'new-project'
  | 'task'
  | 'recurring'
  | 'delegate'
  | 'consult'
  | 'ask'
  | 'author'
  | 'status'
  /** The coordinator wrote the deliverable itself instead of routing it. */
  | 'self-built'
  | 'answer'
  | 'none';

export interface ObservedRoute {
  kind: RouteKind;
  /** Craftbook id, project type id, or role, when the route names one. */
  target?: string;
  /** The tool that carried the decision. */
  via?: string;
}

export interface ObservedToolCall {
  name: string;
  success?: boolean;
  /** `key: value` lines, as the chat record renders a call's arguments. */
  argsFull?: string;
  /** The call's result text, as the chat record keeps it. */
  resultText?: string;
}

export interface CreatedProject {
  id: string;
  projectTypeId?: string;
}

export interface AcceptableRoute {
  kind: RouteKind;
  /** Matched against the observed route's target; absent means any target. */
  target?: RegExp;
}

export interface RouteVerdict {
  route: ObservedRoute;
  /** The route is in the probe's acceptable set, target included. */
  accepted: boolean;
  /** The route's kind is acceptable, whatever its target. */
  kindAccepted: boolean;
  firstCall: string | null;
  /** Tool calls before the routing call (all calls when nothing routed). */
  callsBeforeRoute: number;
  /** The model said work had started without any call starting it. */
  fabricatedClaim: boolean;
}

/** One argument's value from a rendered `argsFull`. */
export function argValue(argsFull: string | undefined, key: string): string | undefined {
  if (!argsFull) return undefined;
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(argsFull);
  return match?.[1]?.trim().replace(/^"|"$/g, '');
}

const STATUS_TOOLS = new Set(['manage_task']);
const SELF_BUILD_TOOLS = new Set([
  'write_artifact',
  'write_file',
  'write_document',
  'append_to_file',
]);
const DELEGATE_TOOLS = new Set(['message_gezel', 'ask_specialist', 'ask_gezel']);

/** The route a single call takes, or null for a call that decides nothing. */
export function routeOfCall(call: ObservedToolCall): ObservedRoute | null {
  const via = call.name;
  if (via === 'start_work') {
    const parsed = parseWorkOptionId(argValue(call.argsFull, 'option') ?? '');
    if (!parsed) return routeFromStartResult(call.resultText, via);
    switch (parsed.kind) {
      case 'craftbook':
        return parsed.craftbookId === 'build-loop'
          ? { kind: 'task', via }
          : { kind: 'craftbook', target: parsed.craftbookId, via };
      case 'project-type':
        return { kind: 'project-type', target: parsed.typeId, via };
      case 'new-project':
        return { kind: 'new-project', via };
      case 'task-here':
        return { kind: 'task', via };
      case 'recurring':
        return { kind: 'recurring', target: parsed.key, via };
    }
  }
  if (via === 'invoke_craftbook') {
    const id = argValue(call.argsFull, 'craftbookId');
    return id === 'build-loop'
      ? { kind: 'task', via }
      : { kind: 'craftbook', ...(id ? { target: id } : {}), via };
  }
  if (via === 'start_project' || via === 'start_job' || via === 'fetch_repo') {
    return { kind: 'new-project', via };
  }
  if (via === 'start_project_from_type' || via === 'apply_project_type') {
    const typeId = argValue(call.argsFull, 'typeId');
    return { kind: 'project-type', ...(typeId ? { target: typeId } : {}), via };
  }
  if (via === 'create_task') return { kind: 'task', via };
  if (via === 'ask_user_question') return { kind: 'ask', via };
  if (via === 'craftbook_write') return { kind: 'author', via };
  if (STATUS_TOOLS.has(via)) return { kind: 'status', via };
  const role = /^(delegate|consult)_(.+)$/.exec(via);
  if (role) {
    return { kind: role[1] === 'consult' ? 'consult' : 'delegate', target: role[2]!, via };
  }
  if (DELEGATE_TOOLS.has(via)) return { kind: 'delegate', via };
  return null;
}

/**
 * What a `start_work` call did, read from its result. `start_work` accepts an
 * id copied without its prefix (`language-trainer` for
 * `type:language-trainer`), so the argument alone cannot always say; the
 * executors' result lines can. A typed project's id comes from the project
 * it created (see classifyRoute).
 */
function routeFromStartResult(result: string | undefined, via: string): ObservedRoute {
  const text = result ?? '';
  const invoked = /Invoked craftbook "([^"]+)"/.exec(text)?.[1];
  if (invoked) {
    return invoked === 'build-loop'
      ? { kind: 'task', via }
      : { kind: 'craftbook', target: invoked, via };
  }
  if (/\bas a .+? project\b/.test(text)) return { kind: 'project-type', via };
  if (/^Started project "/m.test(text)) return { kind: 'new-project', via };
  if (/^(?:Switched on|Paused) "/m.test(text)) return { kind: 'recurring', via };
  return { kind: 'none', via };
}

const STARTED_CLAIM_RE =
  /\b(?:I(?:'ve|\s+have)\s+(?:started|created|set\s+up|kicked\s+off|launched|spun\s+up)|(?:is|are)\s+(?:now\s+)?on\s+it|has\s+(?:been\s+)?(?:started|created|set\s+up))\b/i;

/**
 * A consultation or delegation the Meester opened, read from the session it
 * created for the other gezel. A consult blocks the Meester's turn until the
 * specialist answers, which can outlast a probe: Qwen consulted a researcher
 * 49 s into "Python or JavaScript first?" and the reply took 14 minutes, so
 * no committed call ever showed the route and the trial timed out as a
 * failure (S1, 2026-10-17).
 */
export interface ObservedHandoff {
  kind: 'consult' | 'delegate';
  /** The other gezel's role id. */
  role?: string;
}

export interface HandoffSessionView {
  gezelId?: string;
  createdAt?: string;
  taskRef?: string;
  messages?: ReadonlyArray<{ role: string; from?: { gezelId?: string; kind?: string } }>;
}

/**
 * Handoffs the Meester opened, earliest first: another gezel's session whose
 * first message came from the Meester as a consultation or a delegation.
 * Task sessions are left out — a project's kickoff dispatch is the project
 * route, already read from its own call.
 */
export function handoffsFromSessions(
  sessions: readonly HandoffSessionView[],
  meesterId: string,
  roleOf: (gezelId: string) => string | undefined,
): ObservedHandoff[] {
  return [...sessions]
    .filter((s) => s.gezelId && s.gezelId !== meesterId && !s.taskRef)
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .flatMap((s) => {
      const from = s.messages?.find((m) => m.role === 'user')?.from;
      if (from?.gezelId !== meesterId) return [];
      if (from.kind !== 'consultation' && from.kind !== 'delegation') return [];
      const role = roleOf(s.gezelId!);
      return [
        {
          kind: from.kind === 'consultation' ? ('consult' as const) : ('delegate' as const),
          ...(role ? { role } : {}),
        },
      ];
    });
}

export function classifyRoute(input: {
  calls: readonly ObservedToolCall[];
  /** Projects created during the trial (seeded ones excluded). */
  createdProjects: readonly CreatedProject[];
  /** Handoffs to other gezels, earliest first; used when no committed call routed. */
  handoffs?: readonly ObservedHandoff[];
  /** The Meester's turn has ended. */
  finished: boolean;
  /** The Meester's last reply text. */
  assistantText: string;
  acceptable: readonly AcceptableRoute[];
}): RouteVerdict | null {
  const routedAt = input.calls.findIndex(
    (call) => call.success !== false && routeOfCall(call) !== null,
  );
  const handoff = input.handoffs?.[0];
  let route: ObservedRoute;
  if (routedAt < 0 && handoff) {
    route = {
      kind: handoff.kind,
      ...(handoff.role ? { target: handoff.role } : {}),
      via: 'handoff',
    };
  } else if (routedAt >= 0) {
    route = routeOfCall(input.calls[routedAt]!)!;
    // start_project (and a new-project option) may itself route to a type,
    // and a type started by a prefix-less id names no target of its own.
    if (route.kind === 'new-project' || (route.kind === 'project-type' && !route.target)) {
      const typed = input.createdProjects.find((p) => p.projectTypeId);
      if (typed?.projectTypeId) {
        route = { kind: 'project-type', target: typed.projectTypeId, via: route.via };
      }
    }
  } else if (input.finished) {
    const built = input.calls.find(
      (call) => call.success !== false && SELF_BUILD_TOOLS.has(call.name),
    );
    route = built
      ? { kind: 'self-built', via: built.name }
      : { kind: input.assistantText.trim() ? 'answer' : 'none' };
  } else {
    return null;
  }
  const kindAccepted = input.acceptable.some((a) => a.kind === route.kind);
  const accepted = input.acceptable.some(
    (a) =>
      a.kind === route.kind &&
      (!a.target || (route.target !== undefined && a.target.test(route.target))),
  );
  return {
    route,
    accepted,
    kindAccepted,
    firstCall: input.calls[0]?.name ?? null,
    callsBeforeRoute: routedAt >= 0 ? routedAt : input.calls.length,
    fabricatedClaim: routedAt < 0 && !handoff && STARTED_CLAIM_RE.test(input.assistantText),
  };
}
