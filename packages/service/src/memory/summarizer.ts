import {
  type ChatMessage,
  type ChatSession,
  type GezelConfig,
  createLogger,
} from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import type { HistoryManager } from '../history/manager.js';
import { type MemoryKind, isMemoryKind } from './daily-markdown.js';
import { EmbeddingsDisabledError } from './embeddings.js';
import type { MemoryManager } from './manager.js';

const DEFAULT_MIN_USER_TURNS = 2;
/**
 * Rough char budget for the transcript we hand to the summarizer. Tightly
 * bounded so this works against tiny ollama context windows.
 */
const TRANSCRIPT_BUDGET = 20_000;

const log = createLogger('memory');

const SUMMARY_PROMPT = `You are a session-summarization system. A gezel (AI teammate) and a user have just finished a working session; your job is to distill what happened into durable project memory so the next session — possibly run by a different gezel — picks up where this one left off.

Extract one concise sentence per genuinely useful item, one per line, no bullets or numbering. Focus on:
- **Intent** — what the user asked for, the underlying goal.
- **Key decisions** — choices made, tradeoffs accepted.
- **Files / artifacts touched** — created, edited, referenced.
- **Open questions** — things that were NOT resolved; next steps.

Tag every line with its kind — start each line with FACT:, DECISION:, PREF:, or STATUS:
- DECISION for choices made and tradeoffs accepted.
- PREF for user preferences and working styles.
- STATUS for temporary conditions true right now (a missing credential, an unresolved question, a next step).
- FACT for everything else durable (intent, artifacts touched, context learned).

Do NOT record task or project completion or progress (e.g. "the feature is done", "the project is complete") — the task system already tracks that.

Skip greetings, small talk, trivial exchanges, and blow-by-blow narration of tool calls. If nothing in the transcript is worth remembering, respond with exactly: NONE.

Transcript:
`;

interface SummarizeArgs {
  record: ChatSession;
  chat: ChatManager;
  memory: MemoryManager;
  config: GezelConfig;
  history?: HistoryManager;
  /** Set when invoked by the idle scheduler so the history log notes the reason. */
  trigger: 'archive' | 'idle';
}

/**
 * Distill a chat session into project-scoped memory. Idempotent against
 * `record.summarizedUpTo` — won't re-summarize until at least one new
 * user turn has landed since the last pass. Failures are swallowed: the
 * archive path can't afford to block on a memory operation.
 */
export async function summarizeSessionForMemory(args: SummarizeArgs): Promise<void> {
  const { record, chat, memory, config, history, trigger } = args;

  const settings = config.summarization ?? {};
  if (settings.enabled === false) return;

  const minUserTurns = settings.minUserTurns ?? DEFAULT_MIN_USER_TURNS;
  const userTurns = record.messages.filter((m) => m.role === 'user').length;
  if (userTurns < minUserTurns) {
    log.info(
      `[summarize] skip session ${record.id.slice(0, 8)} — only ${userTurns} user turn(s) < min ${minUserTurns}`,
    );
    return;
  }

  if (
    typeof record.summarizedUpTo === 'number' &&
    record.summarizedUpTo >= record.messages.length
  ) {
    log.info(
      `[summarize] skip session ${record.id.slice(0, 8)} — already summarized up to this turn`,
    );
    return;
  }

  const transcript = renderTranscript(record.messages);
  if (!transcript.trim()) return;

  let raw: string;
  try {
    raw = await chat.oneShotCompletion(`${SUMMARY_PROMPT}${transcript}`, 180_000, {
      jobLabel: `summary · ${record.id.slice(0, 8)}`,
      ambient: true,
      ...(settings.provider
        ? {
            // Explicit per-install summarization override wins over the
            // Klerk default — keeps the back-compat path for users who
            // pinned summaries to a specific provider/model.
            providerName: settings.provider,
            ...(settings.model ? { model: settings.model } : {}),
          }
        : { useKlerk: true }),
    });
  } catch (err) {
    log.warn(
      `[summarize] session ${record.id.slice(0, 8)} failed:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  const text = raw.trim();
  if (!text || text === 'NONE') return;

  const lines = text
    .split('\n')
    .map((l) => l.replace(/^[-*\d.\s]+/, '').trim())
    .filter((l) => l.length > 0 && l !== 'NONE')
    .map(parseSummaryLine);

  if (lines.length === 0) return;

  try {
    for (const line of lines) {
      // Session summaries are project memory by design — the per-turn
      // extractor owns gezel-scope (transferable) routing.
      await memory.save('project', record.projectId, line.text, line.kind);
    }
  } catch (err) {
    if (err instanceof EmbeddingsDisabledError) {
      log.info('[summarize] embeddings disabled — not persisting');
      return;
    }
    log.warn(
      `[summarize] memory.save failed for session ${record.id.slice(0, 8)}:`,
      err instanceof Error ? err.message : err,
    );
    return;
  }

  await history?.log({
    kind: 'memory.auto-summarized',
    projectId: record.projectId,
    gezelId: record.gezelId,
    summary: `Summarized session "${record.title}" into ${lines.length} ${lines.length === 1 ? 'memory' : 'memories'} (${trigger})`,
    details: { sessionId: record.id, trigger, lineCount: lines.length },
  });

  log.info(`[summarize] session ${record.id.slice(0, 8)} → ${lines.length} memories (${trigger})`);
}

const SUMMARY_KIND_RE = /^(FACT|DECISION|PREF|STATUS)\s*:\s*(.+)$/i;

/** Parse an optional `KIND:` prefix off a summary line; untagged → fact. */
function parseSummaryLine(line: string): { text: string; kind: MemoryKind } {
  const m = line.match(SUMMARY_KIND_RE);
  if (m) {
    const kind = m[1]!.toLowerCase();
    return { text: m[2]!.trim(), kind: isMemoryKind(kind) ? kind : 'fact' };
  }
  return { text: line, kind: 'fact' };
}

/**
 * Stamp `summarizedAt` + `summarizedUpTo` on the record. Caller writes
 * back to disk. Extracted so the ChatManager can update its live-state
 * copy in the same pass as the persisted one.
 */
export function markSessionSummarized(record: ChatSession): void {
  record.summarizedAt = new Date().toISOString();
  record.summarizedUpTo = record.messages.length;
}

/**
 * Render a sequence of chat messages as a `User: …` / `Gezel: …`
 * transcript that fits within {@link TRANSCRIPT_BUDGET} chars. Walks
 * newest-first so the tail (more recent = more signal) survives any
 * truncation. Exported so the in-flight compaction path
 * ({@link import('../chat/manager.js').ChatManager.compactInFlight})
 * can reuse the same shape — both feed an LLM that needs the same
 * "transcript in, distilled summary out" framing.
 */
export function renderTranscript(messages: readonly ChatMessage[]): string {
  const lines: string[] = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    const who = m.role === 'user' ? 'User' : 'Gezel';
    const line = `${who}: ${m.content}`;
    if (chars + line.length > TRANSCRIPT_BUDGET) {
      lines.unshift(`(… ${i + 1} earlier turn(s) truncated for length …)`);
      break;
    }
    lines.unshift(line);
    chars += line.length + 2;
  }
  return lines.join('\n\n');
}
