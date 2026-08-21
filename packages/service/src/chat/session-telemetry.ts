/**
 * In-memory per-session progress telemetry. Counts the live signals the
 * chat layer already observes — streamed deltas, wire pulses, heartbeats,
 * engine phases, completed tool calls, GPU swaps — so stall logic, the UI,
 * and the eval harness can read "is real progress happening?" without
 * scraping daemon logs. Counters reset on daemon restart by design: this is
 * a runtime signal, not durable state (nothing here goes through Store).
 */

import type { SessionGpuTask, SessionTelemetry, SessionTurnPhase } from '@bendyline/gezel';

/**
 * Tool names that mutate files on disk. Kept in exact parity with the eval
 * harness's write-call classification so stall thresholds tuned against the
 * eval counters keep their calibration. Deliberately excludes rm / mkdir /
 * rename — deleting or scaffolding is not deliverable progress.
 */
export const FILE_MUTATION_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'write_artifact',
  'replace_in_file',
  'append_to_file',
  'insert_at_marker',
  'copy_artifact_to_workspace',
]);

/** Bound on tracked sessions; oldest-progress rows are evicted beyond it. */
const MAX_TRACKED_SESSIONS = 1000;

interface SessionCounters {
  gezelId: string;
  projectId: string;
  turnsStarted: number;
  providerRequestsStarted: number;
  deltaChunks: number;
  streamedContentChars: number;
  wirePulses: number;
  heartbeats: number;
  enginePhaseEvents: number;
  generationSpurts: number;
  toolCalls: number;
  toolArgChars: number;
  fileMutations: number;
  gpuEvents: number;
  gpuTaskActive: SessionGpuTask | null;
  lastStreamActivityAt: number | null;
  lastToolActivityAt: number | null;
  lastMutationAt: number | null;
  lastGpuActivityAt: number | null;
  currentTurn: {
    startedAt: number;
    phase: SessionTurnPhase;
    phaseStartedAt: number;
    providerRequestsStarted: number;
    streamedContentChars: number;
    toolCalls: number;
    fileMutations: number;
  } | null;
}

export class SessionTelemetryTracker {
  private readonly bySession = new Map<string, SessionCounters>();

  /**
   * Creates the session's row (the only `note*` that does — later signals
   * for sessions never seen here are dropped, so stray bus events can't
   * resurrect a deleted session's counters).
   */
  noteTurnStart(scope: { sessionId: string; gezelId: string; projectId: string }): void {
    let row = this.bySession.get(scope.sessionId);
    if (!row) {
      this.evictIfFull();
      row = emptyCounters(scope.gezelId, scope.projectId);
      this.bySession.set(scope.sessionId, row);
    }
    row.gezelId = scope.gezelId;
    row.projectId = scope.projectId;
    row.turnsStarted += 1;
    const startedAt = Date.now();
    row.currentTurn = {
      startedAt,
      phase: 'preparing',
      phaseStartedAt: startedAt,
      providerRequestsStarted: 0,
      streamedContentChars: 0,
      toolCalls: 0,
      fileMutations: 0,
    };
  }

  noteTurnEnd(sessionId: string): void {
    const row = this.bySession.get(sessionId);
    if (row) row.currentTurn = null;
  }

  noteTurnPhase(sessionId: string, phase: SessionTurnPhase): void {
    const current = this.bySession.get(sessionId)?.currentTurn;
    if (!current || current.phase === phase) return;
    current.phase = phase;
    current.phaseStartedAt = Date.now();
  }

  noteProviderRequestStart(sessionId: string): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.providerRequestsStarted += 1;
    if (!row.currentTurn) return;
    row.currentTurn.providerRequestsStarted += 1;
    if (row.currentTurn.phase !== 'provider') {
      row.currentTurn.phase = 'provider';
      row.currentTurn.phaseStartedAt = Date.now();
    }
  }

  noteDelta(sessionId: string, chars: number): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.deltaChunks += 1;
    row.streamedContentChars += chars;
    row.lastStreamActivityAt = Date.now();
    if (row.currentTurn) row.currentTurn.streamedContentChars += chars;
  }

  noteWirePulse(sessionId: string): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.wirePulses += 1;
    row.lastStreamActivityAt = Date.now();
  }

  noteHeartbeat(sessionId: string): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.heartbeats += 1;
    row.lastStreamActivityAt = Date.now();
  }

  noteEnginePhase(sessionId: string, phase: string): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.enginePhaseEvents += 1;
    if (phase === 'generating') row.generationSpurts += 1;
    row.lastStreamActivityAt = Date.now();
  }

  noteToolCall(sessionId: string, info: { name: string; args?: Record<string, unknown> }): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.toolCalls += 1;
    if (info.args) {
      try {
        row.toolArgChars += JSON.stringify(info.args).length;
      } catch {
        // Circular / non-serializable args — count the call, skip the chars.
      }
    }
    const now = Date.now();
    row.lastToolActivityAt = now;
    if (row.currentTurn) row.currentTurn.toolCalls += 1;
    if (FILE_MUTATION_TOOLS.has(info.name)) {
      row.fileMutations += 1;
      row.lastMutationAt = now;
      if (row.currentTurn) row.currentTurn.fileMutations += 1;
    }
  }

  noteGpuSwap(
    sessionId: string,
    state: 'started' | 'progress' | 'ended',
    task: SessionGpuTask,
  ): void {
    const row = this.bySession.get(sessionId);
    if (!row) return;
    row.gpuEvents += 1;
    row.lastGpuActivityAt = Date.now();
    row.gpuTaskActive = state === 'ended' ? null : task;
  }

  snapshot(sessionId: string, inflight: boolean): SessionTelemetry | null {
    const row = this.bySession.get(sessionId);
    if (!row) return null;
    return toTelemetry(sessionId, row, inflight);
  }

  list(
    inflightIds: ReadonlySet<string>,
    filter?: { projectId?: string; gezelId?: string },
  ): SessionTelemetry[] {
    const out: SessionTelemetry[] = [];
    for (const [sessionId, row] of this.bySession) {
      if (filter?.projectId && row.projectId !== filter.projectId) continue;
      if (filter?.gezelId && row.gezelId !== filter.gezelId) continue;
      out.push(toTelemetry(sessionId, row, inflightIds.has(sessionId)));
    }
    return out;
  }

  delete(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  private evictIfFull(): void {
    if (this.bySession.size < MAX_TRACKED_SESSIONS) return;
    let oldestId: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [sessionId, row] of this.bySession) {
      const at = lastProgressAt(row) ?? 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestId = sessionId;
      }
    }
    if (oldestId !== null) this.bySession.delete(oldestId);
  }
}

function emptyCounters(gezelId: string, projectId: string): SessionCounters {
  return {
    gezelId,
    projectId,
    turnsStarted: 0,
    providerRequestsStarted: 0,
    deltaChunks: 0,
    streamedContentChars: 0,
    wirePulses: 0,
    heartbeats: 0,
    enginePhaseEvents: 0,
    generationSpurts: 0,
    toolCalls: 0,
    toolArgChars: 0,
    fileMutations: 0,
    gpuEvents: 0,
    gpuTaskActive: null,
    lastStreamActivityAt: null,
    lastToolActivityAt: null,
    lastMutationAt: null,
    lastGpuActivityAt: null,
    currentTurn: null,
  };
}

function lastProgressAt(row: SessionCounters): number | null {
  const candidates = [
    row.lastStreamActivityAt,
    row.lastToolActivityAt,
    row.lastMutationAt,
    row.lastGpuActivityAt,
  ].filter((t): t is number => t !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

function toTelemetry(sessionId: string, row: SessionCounters, inflight: boolean): SessionTelemetry {
  return {
    sessionId,
    gezelId: row.gezelId,
    projectId: row.projectId,
    inflight,
    turnsStarted: row.turnsStarted,
    providerRequestsStarted: row.providerRequestsStarted,
    deltaChunks: row.deltaChunks,
    streamedContentChars: row.streamedContentChars,
    wirePulses: row.wirePulses,
    heartbeats: row.heartbeats,
    enginePhaseEvents: row.enginePhaseEvents,
    generationSpurts: row.generationSpurts,
    toolCalls: row.toolCalls,
    toolArgChars: row.toolArgChars,
    fileMutations: row.fileMutations,
    gpuEvents: row.gpuEvents,
    gpuTaskActive: row.gpuTaskActive,
    lastStreamActivityAt: row.lastStreamActivityAt,
    lastToolActivityAt: row.lastToolActivityAt,
    lastMutationAt: row.lastMutationAt,
    lastGpuActivityAt: row.lastGpuActivityAt,
    lastProgressAt: lastProgressAt(row),
    currentTurn: row.currentTurn ? { ...row.currentTurn } : null,
  };
}
