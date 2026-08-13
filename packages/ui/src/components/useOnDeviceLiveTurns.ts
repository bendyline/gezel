/**
 * Shared hook for tracking in-flight on-device turns by sessionId,
 * including the latest `engine_phase` detail so every consumer renders
 * the same phase label at the same time. Used by EngineStatusPill (to
 * drive the header pill + dropdown) and QueueMeter (to annotate the
 * per-session rows inside the popover with their current phase).
 *
 * Deliberately minimal — only tracks what both consumers need by default.
 * EngineStatusPill can opt into a throttled output-volume counter; QueueMeter
 * leaves that off so token deltas don't re-render its larger popover.
 *
 * Each mount of the hook opens its own SSE connection to
 * `/events/chat/all`. That's two connections when both the pill and
 * QueueMeter are mounted, but the endpoint is cheap (in-process, no
 * external fanout) and the simplicity is worth more than a global
 * context here.
 */

import type { ChatEventEnvelope } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';

export interface LiveTurnState {
  phase: 'starting' | 'loading_model' | 'prefill' | 'generating' | 'ready';
  /** Concrete local engine that emitted the phase for this session. */
  provider?: 'llama-cpp' | 'mlx' | 'ds4';
  /** Human-readable label from the phase event's `detail` (or a fallback). */
  label: string;
  /**
   * Gezel that owns this turn, from the event envelope. Lets consumers
   * label a turn by name without a separate sessionId→gezel lookup —
   * QueueMeter uses it to render preparing-window rows while the
   * provider queue (which carries the same id) isn't surfaced yet.
   * Optional because the field is additive; the pill ignores it.
   */
  gezelId?: string;
  /** Project scope from the chat event envelope. */
  projectId?: string;
  /** When we first saw this turn start (used for elapsed-time). */
  startedAt: number;
  /** 0-1 progress, when the phase event carried one (prompt-processing batches). */
  progress?: number;
  /**
   * Generated output volume observed on the chat stream. Includes visible
   * prose, private reasoning, and structured tool arguments so it tracks the
   * engine's eventual completion-token total more closely than visible text
   * alone. Consumers present the derived token count as an estimate because
   * streamed text fragments are not tokenizer boundaries.
   */
  outputChars?: number;
  /**
   * Wall-clock millis of the most recent event that touched this
   * entry (user_message seed, engine_phase update). Used by the idle
   * sweeper to drop entries whose `done` event was missed (SSE
   * disconnect during reconnect, browser tab backgrounded, etc.).
   * Without this the pill stays stuck on the last-known phase
   * indefinitely — a user screenshot of "Preparing · 166s" was exactly
   * this case.
   */
  lastEventAt: number;
}

/**
 * Drop a live-turn entry after this many ms of silence (no
 * engine_phase / done / error event for this session). Larger than
 * the longest typical first-token wait on a cold-loaded local model
 * (~60s on a 30B-class GGUF) so we don't drop legitimately-slow
 * turns; smaller than the runtime's `streamingIdleMs` watchdog
 * (5 min) so the UI clears earlier than the runtime would. Server
 * publishing `done` reliably is the right fix; this is the
 * defense-in-depth fallback.
 */
const LIVE_TURN_MAX_IDLE_MS = 90_000;

/**
 * Subscribes to `engine_phase` / `user_message` / `done` / `error`
 * events and maintains a Map of in-flight turns. Returns `undefined`
 * (not the empty map) when the caller has opted out by passing
 * `enabled: false` — lets the caller gate subscription on whether
 * the user is on the llama-cpp provider at all.
 */
export function useOnDeviceLiveTurns(
  enabled: boolean,
  trackOutput = false,
): Map<string, LiveTurnState> {
  const [liveTurns, setLiveTurns] = useState<Map<string, LiveTurnState>>(new Map());
  const pendingOutputRef = useRef(
    new Map<string, { chars: number; gezelId: string; projectId: string }>(),
  );
  const outputFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLiveTurns(new Map());
      return;
    }
    const ctrl = new AbortController();
    const flushPendingOutput = () => {
      outputFlushTimerRef.current = null;
      if (pendingOutputRef.current.size === 0) return;
      const pending = pendingOutputRef.current;
      pendingOutputRef.current = new Map();
      setLiveTurns((prev) => {
        const next = new Map(prev);
        const now = Date.now();
        for (const [sessionId, addition] of pending) {
          const prior = next.get(sessionId);
          next.set(sessionId, {
            phase: prior?.phase ?? 'generating',
            ...(prior?.provider ? { provider: prior.provider } : {}),
            label: prior?.label ?? phaseBaseLabel('generating'),
            gezelId: prior?.gezelId ?? addition.gezelId,
            projectId: prior?.projectId ?? addition.projectId,
            startedAt: prior?.startedAt ?? now,
            lastEventAt: now,
            ...(prior?.progress !== undefined ? { progress: prior.progress } : {}),
            outputChars: (prior?.outputChars ?? 0) + addition.chars,
          });
        }
        return next;
      });
    };
    const queueOutputFlush = () => {
      if (outputFlushTimerRef.current !== null) return;
      outputFlushTimerRef.current = setTimeout(flushPendingOutput, 250);
    };
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const { sessionId, gezelId, projectId, event } = env as ChatEventEnvelope;
          if (event.type === 'engine_phase') {
            if (
              event.provider !== 'llama-cpp' &&
              event.provider !== 'mlx' &&
              event.provider !== 'ds4'
            )
              continue;
            const phase = event.phase;
            const detail = event.detail;
            const progress = event.progress;
            setLiveTurns((prev) => {
              const next = new Map(prev);
              const prior = next.get(sessionId);
              if (phase === 'ready') {
                next.delete(sessionId);
                return next;
              }
              next.set(sessionId, {
                phase,
                provider: event.provider,
                label: detail ?? phaseBaseLabel(phase),
                gezelId,
                projectId,
                startedAt: prior?.startedAt ?? Date.now(),
                lastEventAt: Date.now(),
                outputChars: prior?.outputChars ?? 0,
                ...(typeof progress === 'number' ? { progress } : {}),
              });
              return next;
            });
          } else if (event.type === 'user_message') {
            pendingOutputRef.current.delete(sessionId);
            setLiveTurns((prev) => {
              // Always reset on user_message — a fresh user turn means
              // any prior turn for this session must have ended. If
              // `done` was missed for the old turn (SSE reconnect,
              // disconnected tab, server restart), this is the recovery
              // point: showing a fresh "Preparing · 0s" beats showing
              // the previous turn's stale "Preparing · 166s". The
              // reported bug was the bail-out case where the old entry
              // persisted across turn boundaries indefinitely.
              const next = new Map(prev);
              const prior = next.get(sessionId);
              next.set(sessionId, {
                phase: 'prefill',
                ...(prior?.provider ? { provider: prior.provider } : {}),
                label: 'Preparing',
                gezelId,
                projectId,
                startedAt: Date.now(),
                lastEventAt: Date.now(),
                outputChars: 0,
              });
              return next;
            });
          } else if (
            event.type === 'delta' ||
            event.type === 'reasoning_delta' ||
            event.type === 'tool_args_delta'
          ) {
            if (!trackOutput) continue;
            const pending = pendingOutputRef.current.get(sessionId);
            pendingOutputRef.current.set(sessionId, {
              chars: (pending?.chars ?? 0) + event.content.length,
              gezelId: pending?.gezelId ?? gezelId,
              projectId: pending?.projectId ?? projectId,
            });
            queueOutputFlush();
          } else if (event.type === 'done' || event.type === 'error') {
            pendingOutputRef.current.delete(sessionId);
            setLiveTurns((prev) => {
              if (!prev.has(sessionId)) return prev;
              const next = new Map(prev);
              next.delete(sessionId);
              return next;
            });
          }
        }
      } catch {
        /* aborted / stream closed */
      }
    })();
    return () => {
      ctrl.abort();
      if (outputFlushTimerRef.current !== null) clearTimeout(outputFlushTimerRef.current);
      outputFlushTimerRef.current = null;
      pendingOutputRef.current.clear();
    };
  }, [enabled, trackOutput]);

  // Idle sweeper: drop entries whose last event was >LIVE_TURN_MAX_IDLE_MS
  // ago. Runs every 5s — cheap, scales with the (always small) live-
  // turn map. Fires alongside the SSE handler above so a missed `done`
  // event clears within ~95s instead of staying stuck forever. The
  // user keeps seeing a fresh, accurate pill on the next turn even if
  // the connection dropped during the previous one.
  //
  // Doesn't run when `enabled` is false (caller opted out — usually
  // because no local provider is active, so there's nothing to track
  // anyway).
  useEffect(() => {
    if (!enabled) return;
    const sweep = setInterval(() => {
      setLiveTurns((prev) => {
        if (prev.size === 0) return prev;
        const now = Date.now();
        let changed = false;
        const next = new Map(prev);
        for (const [sid, state] of prev.entries()) {
          if (now - state.lastEventAt > LIVE_TURN_MAX_IDLE_MS) {
            next.delete(sid);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 5_000);
    return () => clearInterval(sweep);
  }, [enabled]);

  return liveTurns;
}

export function phaseBaseLabel(phase: LiveTurnState['phase']): string {
  switch (phase) {
    case 'starting':
      return 'Starting engine';
    case 'loading_model':
      return 'Loading model';
    case 'prefill':
      return 'Thinking it through';
    case 'generating':
      return 'Generating';
    case 'ready':
      return 'Ready';
  }
}
