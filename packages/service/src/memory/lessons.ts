/**
 * Gezel-scope lessons distillation. Periodically (alongside the memory
 * compactor's sweep) the Klerk reads a gezel's recent gezel-scope
 * memories and rewrites `memories/lessons.md` — a small, curated
 * "lessons from past work" document of transferable preferences and
 * practices. ChatManager injects it into the STABLE system-prompt
 * prefix right after the about.md body, so a dev gezel's accumulated
 * generic knowledge actually reaches every new session.
 *
 * Lessons COMPLEMENT similarity recall, they don't replace it: recall
 * surfaces episodic gezel/project hits matched to the first message;
 * lessons are the standing distillate that needs no query to apply.
 */

import { type GezelConfig, createLogger } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';
import type { HistoryManager } from '../history/manager.js';
import type { CompactOneShot } from './compaction.js';
import type { MemoryManager } from './manager.js';

const log = createLogger('memory');

const DEFAULT_LESSONS_MAX_CHARS = 1500;
const DEFAULT_LESSONS_LOOKBACK_DAYS = 28;
/** Don't distill from a near-empty corpus — the output would be noise. */
const LESSONS_MIN_INPUT_CHARS = 400;

const LESSONS_PROMPT = (maxChars: number, lookbackDays: number) =>
  `You are distilling durable working lessons for an AI agent from its recent memory notes. Produce the agent's "Lessons from past work" document: transferable preferences and practices that have proven out across projects.

Rules:
- REWRITE the document from scratch, merging the current document with the new notes. Do not append. Drop weak or superseded bullets — this document stays curated, not cumulative.
- Include only transferable knowledge: coding practices, debugging tactics, communication and review preferences, tooling habits, recurring pitfalls and how to avoid them.
- FORBIDDEN: project-specific facts (file paths, repository or project names, task or ticket references), completion status ("X is finished", "Y is deployed"), one-off events, anything meaningful only inside a single project.
- Format: markdown bullets, optionally grouped under at most 3 short headings. No preamble, no closing remarks.
- HARD LIMIT: ${maxChars} characters. Fewer, stronger bullets beat many weak ones.
- If there are no durable lessons yet, respond with exactly: NONE.

Current document:
`;

export interface LessonsArgs {
  store: Store;
  memory: MemoryManager;
  oneShot: CompactOneShot;
  history?: HistoryManager;
  config: GezelConfig;
  gezelId: string;
}

/**
 * Distill one gezel's recent gezel-scope memories into lessons.md.
 * Failure-safe: NONE / empty / thrown one-shot leaves the previous
 * document untouched (the write is a single atomic swap).
 */
export async function runLessonsDistillation(args: LessonsArgs): Promise<{ updated: boolean }> {
  const { store, memory, oneShot, history, config, gezelId } = args;

  const settings = config.memory?.lessons ?? {};
  if (settings.enabled === false) return { updated: false };
  const maxChars = settings.maxChars ?? DEFAULT_LESSONS_MAX_CHARS;
  const lookbackDays = settings.lookbackDays ?? DEFAULT_LESSONS_LOOKBACK_DAYS;

  const notes = await memory.getRecent('gezel', gezelId, lookbackDays);
  if (notes.trim().length < LESSONS_MIN_INPUT_CHARS) return { updated: false };
  const current = await store.readMemoryLessons(gezelId);

  let raw: string;
  try {
    raw = (
      await oneShot(
        `${LESSONS_PROMPT(maxChars, lookbackDays)}${current.trim() || '(empty)'}\n\nMemory notes from the last ${lookbackDays} days:\n${notes}`,
        120_000,
        { useKlerk: true, jobLabel: `lessons · ${gezelId}` },
      )
    ).trim();
  } catch (err) {
    log.warn(`[lessons] ${gezelId} distillation failed:`, err instanceof Error ? err.message : err);
    return { updated: false };
  }

  if (!raw || raw === 'NONE') return { updated: false };

  // Belt-and-braces over the prompt's stated cap: hard-truncate at 1.2×
  // on a line boundary so a runaway reply can't bloat the stable prompt.
  let content = raw;
  const hardCap = Math.floor(maxChars * 1.2);
  if (content.length > hardCap) {
    const cut = content.slice(0, hardCap);
    const lastNewline = cut.lastIndexOf('\n');
    content = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  }

  await store.writeMemoryLessons(gezelId, `${content}\n`);
  await history?.log({
    kind: 'memory.lessons-updated',
    gezelId,
    summary: `Distilled lessons.md for ${gezelId} (${content.length} chars)`,
    details: { gezelId, chars: content.length },
  });
  log.info(`[lessons] ${gezelId}: lessons.md updated (${content.length} chars)`);
  return { updated: true };
}
