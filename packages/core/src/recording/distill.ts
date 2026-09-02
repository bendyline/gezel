import type { ChatMessage } from '../schemas/gezel.js';
import type { HistoryEvent } from '../schemas/history.js';
import {
  RUN_RECORDING_SCHEMA_VERSION,
  type RunRecording,
  type RunRecordingActor,
  type RunRecordingProvenance,
  type RunRecordingScene,
  type RunRecordingScreenshot,
  type RunRecordingTrial,
} from '../schemas/run-recording.js';
import type { ChatSession } from '../schemas/session.js';

/**
 * Distill a run's raw capture (persisted sessions + history log + task
 * notes + actor roster + screenshot index) into a `RunRecording` — the
 * ordered scene timeline the movie layer plays back.
 *
 * PURE and deterministic: no fs, no clock, no randomness. Callers load
 * files (evals `recording/distill-io.ts`, later the service) and hand in
 * already-typed values. Fidelity degrades gracefully: every input except
 * `sessions` is optional, and missing tool-call timestamps fall back to
 * the containing message's commit time — exactly what pre-enrichment
 * run dirs provide (backfill mode).
 *
 * The ≤1 MB publishable-transcript target lives HERE as policy, not in
 * the schema: excerpt caps, a scene ceiling, and importance-tiered
 * downsampling, with what was dropped recorded in `budget`.
 */

export interface DistillTaskNotes {
  ref: string;
  projectId: string;
  num: number;
  title?: string;
  craftbookId?: string;
  notes: Array<{ id?: string; at: string; author?: string; stepId?: string; text: string }>;
}

export interface DistillScreenshotIndexEntry {
  /** Store-relative path of the HTML/file the screenshot renders. */
  sourcePath: string;
  sourceStore?: string;
  /** Filename inside the recording's screenshots/ dir. */
  png: string;
  width?: number;
  height?: number;
}

export interface DistillInputs {
  sessions: ChatSession[];
  historyEvents?: HistoryEvent[];
  taskNotes?: DistillTaskNotes[];
  /** Roster from capture (`recording/actors.json`); a synthetic user actor is added. */
  actors?: RunRecordingActor[];
  screenshots?: DistillScreenshotIndexEntry[];
  trial?: RunRecordingTrial;
  provenance?: RunRecordingProvenance;
}

export interface DistillOptions {
  /** Hard ceiling on scene count after tier-dropping. Default 2000. */
  maxScenes?: number;
  /** Excerpt cap in characters. Default 400. */
  maxExcerptChars?: number;
  /** Serialized-size budget in bytes. Default 1 MiB. */
  maxBytes?: number;
}

const DEFAULT_MAX_SCENES = 2000;
const DEFAULT_MAX_EXCERPT_CHARS = 400;
const DEFAULT_MAX_BYTES = 1024 * 1024;
export const USER_ACTOR_ID = 'user';

/**
 * Drop order when over budget, lowest first. The load-bearing scenes —
 * delegation, step-transition, gate-verdict, artifact-produced,
 * user-prompt, turn-aborted — are never dropped.
 */
const DROP_TIERS: RunRecordingScene['kind'][][] = [
  ['reasoning'],
  ['note', 'question'],
  ['reply'],
  ['tool-call'],
];
const NEVER_DROP = new Set<RunRecordingScene['kind']>([
  'delegation',
  'step-transition',
  'gate-verdict',
  'artifact-produced',
  'user-prompt',
  'turn-aborted',
]);

export function distillRunRecording(inputs: DistillInputs, opts?: DistillOptions): RunRecording {
  const maxScenes = opts?.maxScenes ?? DEFAULT_MAX_SCENES;
  const maxExcerptChars = opts?.maxExcerptChars ?? DEFAULT_MAX_EXCERPT_CHARS;
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;

  const actors = buildActorRoster(inputs);
  const knownActorIds = new Set(actors.map((actor) => actor.id));
  const scenes: RunRecordingScene[] = [];
  let truncatedExcerpts = 0;
  const excerpt = (text: string | undefined): string | undefined => {
    if (!text) return undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length <= maxExcerptChars) return trimmed;
    truncatedExcerpts += 1;
    return `${trimmed.slice(0, maxExcerptChars - 1)}…`;
  };

  for (const session of inputs.sessions) {
    for (const message of session.messages) {
      if (message.hidden) continue;
      if (message.synthetic) {
        if (message.synthetic === 'turn-aborted') {
          const reason = excerpt(message.content);
          scenes.push({
            kind: 'turn-aborted',
            at: message.at,
            actorId: session.gezelId,
            sessionId: session.id,
            ...(session.taskRef ? { taskRef: session.taskRef } : {}),
            ...(reason ? { reason } : {}),
          });
        }
        continue;
      }
      if (message.role === 'user') {
        if (message.from) {
          const body = excerpt(stripRelayPrefix(message.content));
          scenes.push({
            kind: 'delegation',
            at: message.at,
            actorId: message.from.gezelId,
            ...(message.from.sessionId ? { sessionId: message.from.sessionId } : {}),
            toActorId: session.gezelId,
            toSessionId: session.id,
            ...(message.from.kind ? { delegationKind: message.from.kind } : {}),
            ...(session.taskRef ? { taskRef: session.taskRef } : {}),
            ...(body ? { excerpt: body } : {}),
          });
        } else if (message.origin !== 'system' && !message.nudge) {
          const body = excerpt(message.content);
          scenes.push({
            kind: 'user-prompt',
            at: message.at,
            actorId: USER_ACTOR_ID,
            sessionId: session.id,
            ...(session.taskRef ? { taskRef: session.taskRef } : {}),
            ...(body ? { excerpt: body } : {}),
          });
        }
        continue;
      }
      // Assistant message: reasoning → tool calls → reply, in that order.
      if (message.reasoning && message.reasoning.trim().length > 0) {
        const body = excerpt(message.reasoning);
        scenes.push({
          kind: 'reasoning',
          at: message.at,
          actorId: session.gezelId,
          sessionId: session.id,
          ...(session.taskRef ? { taskRef: session.taskRef } : {}),
          ...(typeof message.reasoningDurationMs === 'number'
            ? { durationMs: message.reasoningDurationMs }
            : {}),
          ...(body ? { excerpt: body } : {}),
        });
      }
      for (const call of coalesceToolCalls(message.toolCalls ?? [])) {
        const summary = excerpt(call.argsSummary);
        scenes.push({
          kind: 'tool-call',
          at: call.at ?? message.at,
          actorId: session.gezelId,
          sessionId: session.id,
          ...(session.taskRef ? { taskRef: session.taskRef } : {}),
          name: call.name,
          success: call.success,
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
          ...(call.count > 1 ? { count: call.count } : {}),
          ...(call.path ? { path: call.path } : {}),
          ...(summary ? { argsSummary: summary } : {}),
          ...(call.diffStats ? { diffStats: call.diffStats } : {}),
        });
      }
      if (message.content && message.content.trim().length > 0) {
        const body = excerpt(message.content);
        scenes.push({
          kind: 'reply',
          at: message.at,
          actorId: session.gezelId,
          sessionId: session.id,
          ...(session.taskRef ? { taskRef: session.taskRef } : {}),
          ...(body ? { excerpt: body } : {}),
        });
      }
    }
  }

  for (const event of inputs.historyEvents ?? []) {
    const details = (event.details ?? {}) as Record<string, unknown>;
    const stepId = firstString(details.stepId, details.step);
    const taskRef = firstString(details.ref, details.taskRef);
    if (
      event.kind === 'task.step.activated' ||
      event.kind === 'task.step.completed' ||
      event.kind === 'task.step.redriven' ||
      event.kind === 'task.step.stalled'
    ) {
      const phase = event.kind.slice('task.step.'.length) as
        | 'activated'
        | 'completed'
        | 'redriven'
        | 'stalled';
      const stepName = firstString(details.stepName, details.name);
      const summary = excerpt(event.summary);
      scenes.push({
        kind: 'step-transition',
        at: event.at,
        ...(event.gezelId ? { actorId: event.gezelId } : {}),
        ...(taskRef ? { taskRef } : {}),
        stepId: stepId ?? 'step',
        ...(stepName ? { stepName } : {}),
        phase,
        ...(summary ? { excerpt: summary } : {}),
      });
      continue;
    }
    if (event.kind === 'task.step.gated') {
      const summary = excerpt(event.summary);
      scenes.push({
        kind: 'gate-verdict',
        at: event.at,
        ...(event.gezelId ? { actorId: event.gezelId } : {}),
        ...(taskRef ? { taskRef } : {}),
        ...(stepId ? { stepId } : {}),
        verdict: 'fail',
        ...(typeof details.attempt === 'number' && details.attempt > 0
          ? { attempt: details.attempt }
          : {}),
        ...(summary ? { excerpt: summary } : {}),
      });
      continue;
    }
    if (event.kind === 'workspace.write') {
      const path = firstString(details.path, details.file);
      if (!path) continue;
      scenes.push({
        kind: 'artifact-produced',
        at: event.at,
        ...(event.gezelId ? { actorId: event.gezelId } : {}),
        store: 'workspace',
        path,
        ...(typeof details.bytes === 'number' ? { bytes: details.bytes } : {}),
      });
    }
  }

  for (const task of inputs.taskNotes ?? []) {
    for (const note of task.notes) {
      const body = excerpt(note.text);
      scenes.push({
        kind: 'note',
        at: note.at,
        ...(note.author && knownActorIds.has(note.author) ? { actorId: note.author } : {}),
        taskRef: task.ref,
        ...(note.stepId ? { stepId: note.stepId } : {}),
        ...(body ? { excerpt: body } : {}),
      });
    }
  }

  // Screenshots: attach to the LAST produced scene for each source file
  // (the state the run shipped), and list them all for gallery use.
  const screenshots: RunRecordingScreenshot[] = [];
  for (const shot of inputs.screenshots ?? []) {
    const file = `screenshots/${shot.png}`;
    let attached: (RunRecordingScene & { kind: 'artifact-produced' }) | undefined;
    for (const scene of scenes) {
      if (scene.kind !== 'artifact-produced') continue;
      if (pathsMatch(scene.path, shot.sourcePath)) attached = scene;
    }
    if (attached) attached.screenshotRef = file;
    screenshots.push({
      file,
      caption: shot.sourcePath,
      ...(shot.width ? { width: shot.width } : {}),
      ...(shot.height ? { height: shot.height } : {}),
    });
  }

  // Chronological, stable for equal timestamps (emission order preserves
  // the reasoning → tool → reply ordering within a message).
  const indexed = scenes.map((scene, index) => ({ scene, index }));
  indexed.sort((a, b) => {
    const ta = Date.parse(a.scene.at);
    const tb = Date.parse(b.scene.at);
    if (ta !== tb) return ta - tb;
    return a.index - b.index;
  });
  let ordered = indexed.map((entry) => entry.scene);

  // Budget pass 1: scene ceiling via importance tiers.
  let droppedScenes = 0;
  for (const tier of DROP_TIERS) {
    if (ordered.length <= maxScenes) break;
    const tierSet = new Set(tier);
    const keep: RunRecordingScene[] = [];
    const candidates: number[] = [];
    ordered.forEach((scene, index) => {
      if (tierSet.has(scene.kind) && !NEVER_DROP.has(scene.kind)) candidates.push(index);
      keep.push(scene);
    });
    const excess = ordered.length - maxScenes;
    if (candidates.length === 0) continue;
    const toDrop = new Set<number>();
    if (candidates.length <= excess) {
      for (const index of candidates) toDrop.add(index);
    } else {
      // Even sampling across the run so the middle doesn't vanish wholesale.
      const stride = candidates.length / excess;
      for (let i = 0; i < excess; i++) toDrop.add(candidates[Math.floor(i * stride)]!);
    }
    droppedScenes += toDrop.size;
    ordered = keep.filter((_, index) => !toDrop.has(index));
  }
  if (ordered.length > maxScenes) {
    droppedScenes += ordered.length - maxScenes;
    ordered = ordered.slice(0, maxScenes);
  }

  const recording: RunRecording = {
    schemaVersion: RUN_RECORDING_SCHEMA_VERSION,
    ...(inputs.trial ? { trial: inputs.trial } : {}),
    ...(inputs.provenance ? { provenance: inputs.provenance } : {}),
    actors,
    scenes: ordered,
    ...(screenshots.length > 0 ? { screenshots } : {}),
    budget: { droppedScenes, truncatedExcerpts },
  };

  // Budget pass 2: byte ceiling. Halve excerpts, then thin tool-calls.
  let serialized = utf8Length(JSON.stringify(recording));
  let shrinkFactor = 1;
  while (serialized > maxBytes && shrinkFactor < 16) {
    shrinkFactor *= 2;
    const cap = Math.max(64, Math.floor(maxExcerptChars / shrinkFactor));
    let shrunk = 0;
    for (const scene of recording.scenes) {
      if (scene.excerpt && scene.excerpt.length > cap) {
        scene.excerpt = `${scene.excerpt.slice(0, cap - 1)}…`;
        shrunk += 1;
      }
    }
    recording.budget.truncatedExcerpts += shrunk;
    if (shrunk === 0) {
      // Excerpts are minimal already: drop the droppable half of the
      // remaining scenes and re-measure.
      const before = recording.scenes.length;
      recording.scenes = recording.scenes.filter(
        (scene, index) => NEVER_DROP.has(scene.kind) || index % 2 === 0,
      );
      recording.budget.droppedScenes += before - recording.scenes.length;
      if (recording.scenes.length === before) break;
    }
    serialized = utf8Length(JSON.stringify(recording));
  }

  return recording;
}

function buildActorRoster(inputs: DistillInputs): RunRecordingActor[] {
  const actors = new Map<string, RunRecordingActor>();
  for (const actor of inputs.actors ?? []) actors.set(actor.id, actor);
  for (const session of inputs.sessions) {
    if (!actors.has(session.gezelId)) {
      actors.set(session.gezelId, { id: session.gezelId, name: session.gezelId, kind: 'gezel' });
    }
  }
  if (!actors.has(USER_ACTOR_ID)) {
    actors.set(USER_ACTOR_ID, { id: USER_ACTOR_ID, name: 'You', kind: 'user' });
  }
  return [...actors.values()];
}

interface CoalescedToolCall {
  name: string;
  success: boolean;
  count: number;
  at?: string;
  durationMs?: number;
  argsSummary?: string;
  path?: string;
  diffStats?: { addedLines: number; removedLines: number };
}

/** Collapse consecutive same-name calls within one message into one scene. */
function coalesceToolCalls(calls: NonNullable<ChatMessage['toolCalls']>): CoalescedToolCall[] {
  const out: CoalescedToolCall[] = [];
  for (const call of calls) {
    const prev = out[out.length - 1];
    if (prev && prev.name === call.name) {
      prev.count += 1;
      prev.success = prev.success && call.success;
      if (prev.durationMs !== undefined) prev.durationMs += call.durationMs;
      continue;
    }
    out.push({
      name: call.name,
      success: call.success,
      count: 1,
      ...(call.at ? { at: call.at } : {}),
      durationMs: call.durationMs,
      ...(call.argsSummary ? { argsSummary: call.argsSummary } : {}),
      ...(call.path ? { path: call.path } : {}),
      ...(typeof call.addedLines === 'number' && typeof call.removedLines === 'number'
        ? { diffStats: { addedLines: call.addedLines, removedLines: call.removedLines } }
        : {}),
    });
  }
  return out;
}

function stripRelayPrefix(content: string): string {
  return content.replace(/^\[(?:Message|Question) from [^\]]+\]:\s*/, '');
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function pathsMatch(scenePath: string, sourcePath: string): boolean {
  const a = scenePath.replace(/\\/g, '/');
  const b = sourcePath.replace(/\\/g, '/');
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
