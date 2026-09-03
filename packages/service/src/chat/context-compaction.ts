import { type ChatMessage, type ChatSession, createLogger, nowIso } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import { renderTranscript } from '../memory/summarizer.js';
import type { LLMSession, ProviderName } from '../providers/types.js';
import type { ChatEventBus } from './events.js';

const log = createLogger('context-compaction');

/** Default point at which local sessions compact their older transcript. */
export const CONTEXT_COMPACT_RATIO = 0.7;

/** Number of recent messages retained verbatim during context compaction. */
const COMPACTION_KEEP_TAIL = 6;

const COMPACTION_PROMPT = `You are summarizing the earlier portion of an in-progress conversation between a user and an AI agent. Your output will REPLACE that earlier portion in the agent's context window — the agent must be able to continue correctly using ONLY your summary plus the most recent few turns.

CRITICAL: this conversation is being compacted because the agent ran out of context. Your single most important job is to prevent the agent from re-attempting things that already happened. The agent will read your output and decide what to do next; if the summary doesn't make it crystal clear which directions are exhausted, the agent will loop and re-trigger compaction.

Use these section headings, in this order, omitting any section that has nothing to put in it:

## Decisions made
- Concrete decisions and the reasoning behind them.

## User intent and constraints
- What the user is trying to accomplish, and any specific constraints / requirements / preferences they've stated.

## Approaches already tried (do NOT repeat without new information)
- Each thing the agent attempted, with the outcome. Be explicit about *what was tried* and *why it didn't finish the job* — was the result wrong, did a tool fail, did the user redirect, was the answer rejected? If an approach was already tried and abandoned, list it here so the agent doesn't re-launch it.

## Open work
- Outstanding tasks the agent committed to but hasn't completed, with enough detail to resume.
- Open questions awaiting the user.

## Key references
- Names of files, artifacts, tools, gezels, and tasks that were touched. One bullet each.

## Errors and recoveries
- Errors encountered, what triggered them, how they were handled.

Drop conversational filler, pleasantries, and verbatim tool outputs (just note "read X, found Y"). Be concrete and specific — vague summaries cause loops. No preamble; start with the first heading.

Earlier conversation:

`;

export interface CompactSessionNowResult {
  compacted: boolean;
  reason?: 'not-found' | 'busy' | 'too-short' | 'failed';
  removedCount?: number;
  compactionCount?: number;
  transcriptTokens?: number;
}

interface CompactionContext {
  contextWindow: number;
  estimatedTokensBefore: number;
  autoCompactRatio: number;
}

interface OneShotOptions {
  gezelId?: string;
  providerName?: ProviderName;
  model?: string;
  jobLabel?: string;
}

interface ContextCompactorHost {
  store: Pick<Store, 'readConfig' | 'writeSession'>;
  events: Pick<ChatEventBus, 'publish'>;
  getSessionRecord(sessionId: string): Promise<ChatSession | null>;
  getLiveSession(sessionId: string): LLMSession | null | undefined;
  isSessionTurnPending(sessionId: string): boolean;
  resetSession(sessionId: string): Promise<void>;
  oneShotCompletion(prompt: string, timeoutMs: number, opts: OneShotOptions): Promise<string>;
  invalidateSessionCache(sessionId: string): void;
  history?: Pick<HistoryManager, 'log'>;
}

/**
 * Owns transcript compaction for both the pre-turn pressure path and the
 * context meter's off-turn action. ChatManager supplies session lifecycle
 * callbacks; this module owns the rewrite and its audit/event bookkeeping.
 */
export class ContextCompactor {
  constructor(private readonly host: ContextCompactorHost) {}

  async compactInFlight(
    record: ChatSession,
    context: CompactionContext,
  ): Promise<{ removedCount: number; compactionCount: number } | null> {
    if (record.messages.length <= COMPACTION_KEEP_TAIL + 2) return null;
    const splitAt = record.messages.length - COMPACTION_KEEP_TAIL;
    const toCompact = record.messages.slice(0, splitAt);
    const tail = record.messages.slice(splitAt);
    const transcript = renderTranscript(toCompact);
    if (!transcript.trim()) return null;

    const compactionConfig = await this.host.store.readConfig().catch(() => null);
    const compactionGezelId = compactionConfig?.klerkGezelId ?? record.gezelId;
    let synthesis: string;
    try {
      synthesis = await this.host.oneShotCompletion(`${COMPACTION_PROMPT}${transcript}`, 60_000, {
        providerName: record.providerName,
        ...(record.model ? { model: record.model } : {}),
        ...(compactionGezelId ? { gezelId: compactionGezelId } : {}),
        jobLabel: `compaction · ${record.id.slice(0, 8)}`,
      });
    } catch (err) {
      log.warn(
        `in-flight compaction failed for session ${record.id.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
      );
      return null;
    }

    const trimmed = synthesis.trim();
    if (!trimmed) return null;
    const compactedAt = nowIso();
    const compactionCount = (record.compactionCount ?? 0) + 1;
    const synthetic: ChatMessage = {
      role: 'assistant',
      content: `[Earlier in this conversation, summarized to fit the model context:\n\n${trimmed}]`,
      at: compactedAt,
      synthetic: 'compaction-summary',
      contextCompaction: {
        removedCount: toCompact.length,
        contextWindow: context.contextWindow,
        estimatedTokensBefore: context.estimatedTokensBefore,
        compactionCount,
        autoCompactRatio: context.autoCompactRatio,
      },
    };

    record.messages = [synthetic, ...tail];
    record.compactionCount = compactionCount;
    record.lastCompactedAt = compactedAt;
    this.host.invalidateSessionCache(record.id);
    if (typeof record.summarizedUpTo === 'number') {
      record.summarizedUpTo = Math.min(record.summarizedUpTo, record.messages.length);
    }
    if (typeof record.extractedUpTo === 'number') {
      record.extractedUpTo = Math.min(record.extractedUpTo, record.messages.length);
    }
    await this.host.store.writeSession(record);

    void this.host.history
      ?.log({
        kind: 'chat.compacted',
        projectId: record.projectId,
        gezelId: record.gezelId,
        summary: `Compacted ${toCompact.length} message${toCompact.length === 1 ? '' : 's'} → ${trimmed.length} char synthesis (compaction #${record.compactionCount})`,
        details: {
          sessionId: record.id,
          removedCount: toCompact.length,
          synthesisLength: trimmed.length,
          compactionCount: record.compactionCount,
        },
      })
      .catch((err) => {
        log.warn(
          `history.log for chat.compacted failed: ${err instanceof Error ? err.message : err}`,
        );
      });

    log.info(
      `compacted session ${record.id.slice(0, 8)}: ${toCompact.length} messages → 1 synthesis (${trimmed.length} chars)`,
    );
    return { removedCount: toCompact.length, compactionCount };
  }

  async compactSessionNow(sessionId: string): Promise<CompactSessionNowResult> {
    if (this.host.isSessionTurnPending(sessionId)) {
      return { compacted: false, reason: 'busy' };
    }
    const record = await this.host.getSessionRecord(sessionId);
    if (!record) return { compacted: false, reason: 'not-found' };
    const liveSession = this.host.getLiveSession(sessionId);
    const measuredChars = liveSession?.estimatePromptChars?.call(liveSession);
    const estimatedTokensBefore =
      measuredChars === undefined ? transcriptTokens(record) : Math.ceil(measuredChars / 4);
    const numCtx = liveSession?.numCtx ?? record.contextWindow ?? 0;
    const autoCompactRatio = record.contextAutoCompactRatio ?? CONTEXT_COMPACT_RATIO;
    const compacted = await this.compactInFlight(record, {
      contextWindow: numCtx,
      estimatedTokensBefore,
      autoCompactRatio,
    });
    if (!compacted) {
      return {
        compacted: false,
        reason: record.messages.length <= COMPACTION_KEEP_TAIL + 2 ? 'too-short' : 'failed',
      };
    }

    await this.host.resetSession(sessionId);
    this.host.events.publish(
      { sessionId, gezelId: record.gezelId, projectId: record.projectId },
      {
        type: 'context_compacted',
        removedCount: compacted.removedCount,
        model: record.model ?? record.providerName,
        ...(numCtx > 0 ? { numCtx } : {}),
        estimatedTokensBefore,
        autoCompactRatio,
        compactionCount: compacted.compactionCount,
        mode: 'between-turn',
      },
    );
    record.contextEstimatedTokens = undefined;
    await this.host.store.writeSession(record).catch((err) => {
      log.warn(
        `compact-now writeSession failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : err}`,
      );
    });
    return {
      compacted: true,
      removedCount: compacted.removedCount,
      compactionCount: compacted.compactionCount,
      transcriptTokens: transcriptTokens(record),
    };
  }
}

/** Transcript-only context floor; the live provider owns the standing prefix. */
function transcriptTokens(record: ChatSession): number {
  let chars = 0;
  for (const message of record.messages) {
    chars += message.content.length;
    for (const call of message.toolCalls ?? []) {
      chars +=
        call.name.length +
        (call.argsFull ?? call.argsSummary ?? '').length +
        (call.resultText ?? '').length;
    }
  }
  return Math.ceil(chars / 4);
}
