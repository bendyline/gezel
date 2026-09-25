import {
  type RewriteTextContext,
  type TransformHooks,
  type TransformOpts,
  buildRewritePrompt,
  buildTransformPrompt,
  cleanTransformOutput,
  createThinkSplitter,
} from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
export { buildTransformPrompt, type TransformOpts, type TransformHooks } from '@bendyline/gezel';

/**
 * Streaming transform runner behind `POST /api/ai/transform`. Routes
 * through the Klerk like `rewriteText`, but surfaces live progress:
 * providers with a real reasoning channel feed `onThinking` directly,
 * while inline `<think>`-tag streams are split so the tags never reach
 * the caller. The returned string (fence-stripped) is authoritative —
 * the delta hooks are advisory preview only.
 */
export async function transformText(
  manager: ChatManager,
  opts: TransformOpts,
  hooks: TransformHooks = {},
): Promise<string> {
  const prompt = buildTransformPrompt(opts);
  const splitter = createThinkSplitter({
    onThinking: (t) => hooks.onThinking?.(t),
    onOutput: (t) => hooks.onOutput?.(t),
  });
  const context = opts.context ?? 'generic';
  const raw = await manager.oneShotCompletion(prompt, 120_000, {
    useKlerk: true,
    // The person is blocked on this modal. Task handoffs and other autonomous
    // work use the background lane, so classify the transform as interactive:
    // it can claim reserved foreground headroom immediately, or take the next
    // physical engine slot at the safe boundary between inference rounds.
    lane: 'interactive',
    jobLabel: `transform · ${opts.mode}${context !== 'generic' ? ` · ${context}` : ''}`,
    onDelta: (chunk) => splitter.push(chunk),
    onReasoningDelta: (chunk) => hooks.onThinking?.(chunk),
    onQueueWait: ({ aheadOf }) => hooks.onQueued?.(aheadOf),
  });
  splitter.flush();
  return cleanTransformOutput(raw);
}

/**
 * LLM-backed "rewrite this text" helper. Used by the squisq editor toolbar
 * to improve about.md content, chat drafts, etc.
 *
 * @deprecated Legacy blocking path behind `POST /api/ai/rewrite` — kept
 * for published-client compatibility. New callers use {@link transformText}.
 */
export async function rewriteText(
  manager: ChatManager,
  opts: {
    text: string;
    context?: RewriteTextContext;
    instruction?: string;
    isSelection?: boolean;
    subject?: string;
    parentContext?: string;
  },
): Promise<string> {
  const context = opts.context ?? 'generic';
  const prompt = buildRewritePrompt(opts);
  const raw = await manager.oneShotCompletion(prompt, 120_000, {
    useKlerk: true,
    // Legacy clients block on this request just like the streaming transform
    // dialog, so it must not sit behind autonomous background task work.
    lane: 'interactive',
    jobLabel: `rewrite${opts.isSelection ? ' · selection' : ''}${
      context !== 'generic' ? ` · ${context}` : ''
    }`,
  });
  return cleanTransformOutput(raw);
}
