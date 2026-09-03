/**
 * Pure helpers shared by the chat timeline and its sticky header: row
 * merging, error classification, and the small formatting utilities that
 * would otherwise sit at module scope in an already-large view.
 */

import type {
  ChatTurnErrorDetail,
  ProviderName,
  ReferencedFile,
  TerminalTimelineEntry,
  TimelineMessage,
} from '@bendyline/gezel';
import { isUserCancelledTurnError } from '../error-report.js';

export type OptimisticTimelineMessage = TimelineMessage & { optimistic?: true };

/**
 * Quote a value for use inside a `[attr="…"]` selector. `CSS.escape`
 * isn't available in every environment we render in (jsdom, older
 * webviews), and session ids are opaque strings we don't control.
 */
export function cssAttrValue(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

export function mergeTerminalEntries(
  snapshot: TerminalTimelineEntry[] | undefined,
  liveEntries: TerminalTimelineEntry[],
): TerminalTimelineEntry[] {
  const byId = new Map((snapshot ?? []).map((entry) => [entry.messageId, entry]));
  for (const entry of liveEntries) byId.set(entry.messageId, entry);
  return [...byId.values()].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Merge a newest-page snapshot into the rows already on screen. Older pages
 * remain intact, while a matching durable user row retires its optimistic
 * counterpart. Shared by completion refreshes and the initial
 * snapshot/subscription handoff reconciliation.
 */
export function mergeTimelineMessages(
  existing: TimelineMessage[],
  snapshot: TimelineMessage[],
): TimelineMessage[] {
  const canonicalUsers = snapshot.filter((message) => message.role === 'user');
  const withoutReconciledOptimistic = existing.filter((message) => {
    if (!(message as OptimisticTimelineMessage).optimistic) return true;
    const optimisticAtMs = Date.parse(message.at);
    return !canonicalUsers.some((real) => {
      if (real.sessionId !== message.sessionId || real.content !== message.content) return false;
      const realAtMs = Date.parse(real.at);
      return Number.isFinite(optimisticAtMs) && Number.isFinite(realAtMs)
        ? Math.abs(realAtMs - optimisticAtMs) < 2 * 60_000
        : true;
    });
  });
  const seen = new Set<string>();
  const merged: TimelineMessage[] = [];
  for (const message of [...withoutReconciledOptimistic, ...snapshot]) {
    const key = `${message.sessionId}:${message.at}:${message.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  merged.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return merged;
}

export function findLastForSession(
  messages: TimelineMessage[],
  sessionId: string,
): TimelineMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.sessionId === sessionId) return messages[i]!;
  }
  return null;
}

export function isModelUnavailableError(message: string): boolean {
  return /model\s+.*\bnot available\b/i.test(message) || /\bunknown model\b/i.test(message);
}

export function isExpectedAvailabilityError(detail?: ChatTurnErrorDetail): boolean {
  return detail?.code === 'capacity-denied' || detail?.code === 'engine-busy';
}

/**
 * Retry is contextual, not a reflex attached to every red surface. Prefer the
 * daemon's structured classification; keep a narrow prose fallback for older
 * daemons and MLX failures whose user-facing copy explicitly recommends a
 * retry. Deterministic "do not retry"/unrunnable failures never get the action.
 */
export function isRetryableFailedTurn(message: string, detail?: ChatTurnErrorDetail): boolean {
  if (isUserCancelledTurnError(message) || isModelUnavailableError(message)) return false;
  if (/\bdo not retry\b|\bcannot run on this machine\b/i.test(message)) return false;
  if (detail?.code === 'engine-busy' || detail?.code === 'capacity-denied') return true;
  if (detail?.code === 'native-engine-crash') return true;
  return /\bretry the turn\b|\bsend (?:the )?message again\b|\bretry \(the cache is warm now\)|\btry a shorter prompt, retry\b/i.test(
    message,
  );
}

const NO_FILES: readonly ReferencedFile[] = [];

/**
 * The message's referenced files, widening the legacy artifact-only field
 * for any surface still sending it. `listTimeline` backfills the current
 * shape on read, so this fallback is for live SSE rows written by an older
 * daemon — a stable empty array otherwise, to keep the bubble's memos warm.
 */
export function referencedFilesOf(message: TimelineMessage): readonly ReferencedFile[] {
  if (message.referencedFiles?.length) return message.referencedFiles;
  if (!message.referencedArtifacts?.length) return NO_FILES;
  return message.referencedArtifacts.map((path) => ({ kind: 'artifact' as const, path }));
}

export function withinHours(iso: string | undefined, ms: number): boolean {
  if (!iso) return false;
  try {
    const t = new Date(iso).getTime();
    return Date.now() - t <= ms;
  } catch {
    return false;
  }
}

export function formatProviderLabel(p: ProviderName): string {
  switch (p) {
    case 'copilot':
      return 'Copilot';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Claude';
    case 'anthropic-cli':
      return 'Claude CLI';
    case 'codex-cli':
      return 'Codex CLI';
    case 'ollama':
      return 'Ollama';
    case 'llama-cpp':
      return 'On-device';
    case 'mlx':
      return 'MLX';
    case 'ds4':
      return 'DwarfStar';
    case 'remote':
      return 'Remote';
  }
}
