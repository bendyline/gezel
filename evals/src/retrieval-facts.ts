import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TrialRetrievalArm } from './types.ts';

/**
 * Retrieval facts — what reached a trial's prompts from the indexes: per-turn
 * indexed context (the `retrieval.context-injected` events and the message
 * stamps), the launch reference list (`Task.references` and the daemon's
 * `references subject=` line), and, when a scenario declares an oracle, which
 * golden and decoy documents each channel exposed. The annotated-work A/B
 * reads these to prove each arm was applied — a silent default would
 * otherwise look exactly like "retrieval had no effect".
 */

export interface RetrievalOracle {
  /** docKeys (or citation substrings) of the documents the deliverable should draw on. */
  golden: string[];
  /** docKeys of documents that must not steer the deliverable. */
  decoys: string[];
}

export interface DocExposure {
  referenced: boolean;
  injected: boolean;
  readByTool: boolean;
}

export interface RetrievalFacts {
  arm: TrialRetrievalArm | null;
  policy: { modes: Record<string, number>; inheritedFrom: Record<string, number> };
  turn: {
    /** Every retrieval.context-injected event: the search ran. */
    probes: number;
    /** Events that injected at least one hit. */
    injections: number;
    hitsBySource: Record<string, number>;
    injectedTokens: number;
    /** Rejected candidates per decision reason, summed across events. */
    rejected: Record<string, number>;
    sessionsWithInjection: number;
    /** Relevance-model outcome per turn event (`scored`, `cold`, …), when one ran. */
    relevance: Record<string, number>;
  };
  references: {
    /** `references subject=` daemon lines: a launch searched for its subject. */
    searches: number;
    tasks: number;
    tasksWithReferences: number;
    items: number;
    citations: string[];
    /** Relevance-model outcome per launch search, from the daemon's references line. */
    relevance: Record<string, number>;
  };
  /** Messages carrying a `retrieval` stamp (per-turn injections and launch lists). */
  stampedMessages: number;
  exposure?: Record<string, DocExposure>;
}

interface HistoryEvent {
  id?: string;
  kind?: string;
  details?: Record<string, unknown>;
}

interface SessionDump {
  id?: string;
  messages?: Array<{
    retrieval?: { hits?: unknown[] };
    toolCalls?: Array<{ name?: string; argsFull?: string; argsSummary?: string }>;
  }>;
}

interface StateTask {
  ref?: string;
  references?: { items?: Array<{ uri?: string; path?: string }> };
}

/** `state.json` stores the task list response: `tasks: { tasks, waiting }`. */
interface StateDump {
  tasks?: StateTask[] | { tasks?: StateTask[] };
}

function stateTasks(state: StateDump | null): StateTask[] {
  const tasks = state?.tasks;
  if (!tasks) return [];
  return Array.isArray(tasks) ? tasks : (tasks.tasks ?? []);
}

const READ_TOOLS = new Set(['read_document', 'read_file', 'read_artifact']);

export function summarizeRetrievalForRunDir(
  runDir: string,
  result: { retrievalArm?: TrialRetrievalArm },
  oracle?: RetrievalOracle | null,
): RetrievalFacts | null {
  const events = readHistory(runDir);
  const sessions = readSessions(runDir);
  const state = readJson<StateDump>(join(runDir, 'state.json'));
  const daemonLog = readText(join(runDir, 'daemon.log'));
  if (!result.retrievalArm && events.length === 0 && sessions.length === 0) return null;
  return summarizeRetrieval({
    arm: result.retrievalArm ?? null,
    events,
    sessions,
    state,
    daemonLog,
    oracle: oracle ?? null,
  });
}

export function summarizeRetrieval(input: {
  arm: TrialRetrievalArm | null;
  events: readonly HistoryEvent[];
  sessions: readonly SessionDump[];
  state: StateDump | null;
  daemonLog: string;
  oracle: RetrievalOracle | null;
}): RetrievalFacts {
  const facts: RetrievalFacts = {
    arm: input.arm,
    policy: { modes: {}, inheritedFrom: {} },
    turn: {
      probes: 0,
      injections: 0,
      hitsBySource: {},
      injectedTokens: 0,
      rejected: {},
      sessionsWithInjection: 0,
      relevance: {},
    },
    references: {
      searches: 0,
      tasks: 0,
      tasksWithReferences: 0,
      items: 0,
      citations: [],
      relevance: {},
    },
    stampedMessages: 0,
  };
  const injectedKeys = new Set<string>();
  const injectingSessions = new Set<string>();
  for (const event of input.events) {
    if (event.kind !== 'retrieval.context-injected') continue;
    const details = event.details ?? {};
    facts.turn.probes++;
    bump(facts.policy.modes, String(details.mode ?? 'unknown'));
    bump(facts.policy.inheritedFrom, String(details.inheritedFrom ?? 'unknown'));
    const hits = Array.isArray(details.hits)
      ? (details.hits as Array<Record<string, unknown>>)
      : [];
    if (hits.length > 0) {
      facts.turn.injections++;
      if (typeof details.sessionId === 'string') injectingSessions.add(details.sessionId);
    }
    facts.turn.injectedTokens += Number(details.estimatedTokens ?? 0);
    for (const hit of hits) {
      bump(facts.turn.hitsBySource, String(hit.source ?? 'unknown'));
      for (const key of [hit.docKey, hit.uri, hit.path]) {
        if (typeof key === 'string') injectedKeys.add(key.replace(/#.*$/, ''));
      }
    }
    const relevance = details.relevanceModel as { status?: unknown } | undefined;
    if (relevance && typeof relevance.status === 'string') {
      bump(facts.turn.relevance, relevance.status);
    }
    const rejected = details.rejected;
    if (rejected && typeof rejected === 'object') {
      for (const [reason, count] of Object.entries(rejected as Record<string, number>)) {
        facts.turn.rejected[reason] = (facts.turn.rejected[reason] ?? 0) + Number(count);
      }
    }
  }
  facts.turn.sessionsWithInjection = injectingSessions.size;

  facts.references.searches = (
    input.daemonLog.match(/\[tasks\] references subject=/g) ?? []
  ).length;
  for (const match of input.daemonLog.matchAll(
    /\[tasks\] references subject=.* relevance=(\w+)/g,
  )) {
    bump(facts.references.relevance, match[1]!);
  }
  const referencedKeys = new Set<string>();
  for (const task of stateTasks(input.state)) {
    facts.references.tasks++;
    const items = task.references?.items ?? [];
    if (items.length === 0) continue;
    facts.references.tasksWithReferences++;
    facts.references.items += items.length;
    for (const item of items) {
      const key = item.uri ? item.uri.replace(/#.*$/, '') : `shared:${item.path ?? ''}`;
      referencedKeys.add(key);
      if (item.path) referencedKeys.add(item.path);
      facts.references.citations.push(key);
    }
  }

  const toolReads: string[] = [];
  for (const session of input.sessions) {
    for (const message of session.messages ?? []) {
      if ((message.retrieval?.hits?.length ?? 0) > 0) facts.stampedMessages++;
      for (const call of message.toolCalls ?? []) {
        if (call.name && READ_TOOLS.has(call.name)) {
          toolReads.push(`${call.argsFull ?? ''} ${call.argsSummary ?? ''}`);
        }
      }
    }
  }

  if (input.oracle) {
    const exposure: Record<string, DocExposure> = {};
    for (const key of [...input.oracle.golden, ...input.oracle.decoys]) {
      const needle = key.replace(/^(shared|workspace:[^:]*):/, '');
      exposure[key] = {
        referenced: [...referencedKeys].some((k) => k.includes(needle)),
        injected: [...injectedKeys].some((k) => k.includes(needle)),
        readByTool: toolReads.some((args) => args.includes(needle)),
      };
    }
    facts.exposure = exposure;
  }
  return facts;
}

/**
 * Did the trial actually run under its arm? A failing proof means the trial
 * is re-run, not scored: an arm that silently ran as another is the one
 * result that can never be trusted.
 */
export function retrievalArmProof(facts: RetrievalFacts): { ok: boolean; problems: string[] } {
  const arm = facts.arm;
  if (!arm) return { ok: true, problems: [] };
  const problems: string[] = [];
  if (arm.mode === 'off') {
    if (facts.turn.injections > 0) {
      problems.push(`${facts.turn.injections} per-turn injections in an Off arm`);
    }
  } else {
    if (facts.turn.probes === 0) problems.push('per-turn retrieval never ran');
    const foreign = Object.keys(facts.policy.inheritedFrom).filter((from) => from !== 'install');
    if (foreign.length > 0) {
      problems.push(`some turns ran under another policy source: ${foreign.join(', ')}`);
    }
  }
  if (arm.references) {
    if (facts.references.searches === 0 && facts.references.tasks > 0) {
      problems.push('no launch searched for references');
    }
  } else if (facts.references.tasksWithReferences > 0) {
    problems.push(`${facts.references.tasksWithReferences} tasks carry references with them off`);
  }
  if (arm.mode === 'off' && !arm.references && facts.stampedMessages > 0) {
    problems.push(`${facts.stampedMessages} messages carry retrieval stamps in the control arm`);
  }
  const scoredRuns = (counts: Record<string, number>) =>
    (counts.scored ?? 0) + (counts.partial ?? 0);
  const modelRuns = scoredRuns(facts.turn.relevance) + scoredRuns(facts.references.relevance);
  if (arm.relevanceModel) {
    if (modelRuns === 0 && (facts.turn.probes > 0 || facts.references.searches > 0)) {
      problems.push('the relevance model never scored a candidate');
    }
  } else if (modelRuns > 0) {
    problems.push(`the relevance model scored ${modelRuns} searches in an arm without it`);
  }
  return { ok: problems.length === 0, problems };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function readHistory(runDir: string): HistoryEvent[] {
  const byId = new Map<string, HistoryEvent>();
  const anonymous: HistoryEvent[] = [];
  const files = [join(runDir, 'history.jsonl')];
  const projectDir = join(runDir, 'project-history');
  if (existsSync(projectDir)) {
    for (const name of readdirSync(projectDir).filter((n) => n.endsWith('.jsonl'))) {
      files.push(join(projectDir, name));
    }
  }
  for (const file of files) {
    for (const line of readText(file).split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as HistoryEvent;
        if (event.id) byId.set(event.id, event);
        else anonymous.push(event);
      } catch {
        /* partial line */
      }
    }
  }
  return [...byId.values(), ...anonymous];
}

function readSessions(runDir: string): SessionDump[] {
  const dir = join(runDir, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson<SessionDump>(join(dir, name)))
    .filter((session): session is SessionDump => session !== null);
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
