import type { RewriteTextContext, TransformTextMode } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';
import { SQUISQ_DIALECT_NOTE } from '../prompts/squisq-dialect.js';
import { createThinkSplitter } from './think-splitter.js';

/**
 * Contexts whose output lands in a Squisq-rendered surface (documents,
 * task descriptions) and may therefore use the extended dialect. `about`
 * is deliberately excluded — about.md becomes a model's system prompt,
 * where a mermaid diagram is noise — and so is `chat-composer` (a
 * message draft, not a document).
 */
const SQUISQ_SURFACE_CONTEXTS: readonly RewriteTextContext[] = ['generic', 'task-description'];

export interface TransformOpts {
  mode: TransformTextMode;
  /** The selected fragment to rewrite. Empty in insert mode. */
  text: string;
  context?: RewriteTextContext;
  instruction?: string;
  subject?: string;
  parentContext?: string;
  /** Insert mode: bounded document context around the insertion point. */
  textBefore?: string;
  textAfter?: string;
}

export interface TransformHooks {
  onThinking?: (text: string) => void;
  onOutput?: (text: string) => void;
  onQueued?: (aheadOf: number) => void;
}

/**
 * Prompt builder for the transform endpoint. Pure so tests can assert
 * on the exact prompt. Rewrite mode always treats the input as a
 * fragment — whole-document rewrite is not a mode (users select all).
 */
export function buildTransformPrompt(opts: TransformOpts): string {
  const context = opts.context ?? 'generic';
  const userInstruction = opts.instruction?.trim();
  const insert = opts.mode === 'insert';

  const scopeNote = insert
    ? 'You are INSERTING new content at a marked position inside an existing document. Generate ONLY the content to insert — do not repeat or rewrite the surrounding text.'
    : 'The input below is a FRAGMENT from within a larger document. Rewrite ONLY that fragment. Do not add headings, surrounding prose, or wrap it in anything — return a drop-in replacement of the same scope.';

  const instructionBlock = userInstruction
    ? `The user's specific instruction:\n"${userInstruction}"\n\nFollow that instruction first; apply the context guidance above where it doesn't conflict.`
    : 'No specific instruction was provided — improve the text in the direction of the context guidance above.';

  const subjectBlock = opts.subject?.trim() ? `\n## Subject\n${opts.subject.trim()}\n` : '';
  const parentBlock = opts.parentContext?.trim()
    ? `\n## Parent context\n${opts.parentContext.trim()}\n`
    : '';
  const beforeBlock =
    insert && opts.textBefore?.trim()
      ? `\n## Text before the insertion point\n${opts.textBefore}\n`
      : '';
  const afterBlock =
    insert && opts.textAfter?.trim()
      ? `\n## Text after the insertion point\n${opts.textAfter}\n`
      : '';

  return [
    insert
      ? 'You are an editor. Write new content to be inserted into an existing document, following the instruction and context below.'
      : 'You are an editor. Rewrite the text given below so that it is clearer, more useful, and appropriate for its context.',
    '',
    '## Context',
    contextGuidanceFor(context),
    subjectBlock,
    parentBlock,
    '## Scope',
    scopeNote,
    beforeBlock,
    afterBlock,
    '## Instruction',
    instructionBlock,
    '',
    '## Output format',
    insert
      ? '- Return ONLY the new markdown content to insert. No preamble, no explanation, no "here is the content", no code fences wrapping the whole output.'
      : '- Return ONLY the rewritten markdown text. No preamble, no explanation, no "here is the rewrite", no code fences wrapping the whole output.',
    ...(insert
      ? ['- The content must read naturally at the insertion point shown above.']
      : [
          "- Preserve the input's meaning and factual content unless the user's instruction asks otherwise.",
        ]),
    '- Keep markdown formatting intact and use it appropriately.',
    ...(SQUISQ_SURFACE_CONTEXTS.includes(context) ? ['', SQUISQ_DIALECT_NOTE] : []),
    ...(insert ? [] : ['', '## Input', opts.text]),
  ].join('\n');
}

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
    jobLabel: `transform · ${opts.mode}${context !== 'generic' ? ` · ${context}` : ''}`,
    onDelta: (chunk) => splitter.push(chunk),
    onReasoningDelta: (chunk) => hooks.onThinking?.(chunk),
    onQueueWait: ({ aheadOf }) => hooks.onQueued?.(aheadOf),
  });
  splitter.flush();
  return stripFences(raw).trim();
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
  const body = opts.text;
  const userInstruction = opts.instruction?.trim();
  const fromScratch = body.trim().length === 0;

  const contextGuidance = contextGuidanceFor(context);
  const scopeNote = fromScratch
    ? 'The input below is EMPTY. Synthesize a complete first draft from scratch using the subject and parent context above plus the context guidance.'
    : opts.isSelection
      ? 'The input below is a FRAGMENT from within a larger document. Rewrite ONLY that fragment. Do not add headings, surrounding prose, or wrap it in anything — return a drop-in replacement of the same scope.'
      : 'The input below is a COMPLETE document. Rewrite the whole thing.';

  const instructionBlock = userInstruction
    ? `The user's specific instruction for this rewrite:\n"${userInstruction}"\n\nFollow that instruction first; apply the context guidance above where it doesn't conflict.`
    : fromScratch
      ? 'No specific instruction was provided — produce a clean, useful first draft following the context guidance above.'
      : 'No specific instruction was provided — improve the text in the direction of the context guidance above.';

  const subjectBlock = opts.subject?.trim() ? `\n## Subject\n${opts.subject.trim()}\n` : '';
  const parentBlock = opts.parentContext?.trim()
    ? `\n## Parent context\n${opts.parentContext.trim()}\n`
    : '';

  const prompt = [
    'You are an editor. Rewrite the text given below so that it is clearer, more useful, and appropriate for its context.',
    '',
    '## Context',
    contextGuidance,
    subjectBlock,
    parentBlock,
    '## Scope',
    scopeNote,
    '',
    '## Instruction',
    instructionBlock,
    '',
    '## Output format',
    '- Return ONLY the rewritten markdown text. No preamble, no explanation, no "here is the rewrite", no code fences wrapping the whole output.',
    "- Preserve the input's meaning and factual content unless the user's instruction asks otherwise.",
    '- Keep markdown formatting intact and use it appropriately.',
    '',
    '## Input',
    body,
  ].join('\n');

  const raw = await manager.oneShotCompletion(prompt, 120_000, {
    useKlerk: true,
    jobLabel: `rewrite${opts.isSelection ? ' · selection' : ''}${
      context !== 'generic' ? ` · ${context}` : ''
    }`,
  });
  return stripFences(raw).trim();
}

function contextGuidanceFor(context: RewriteTextContext): string {
  switch (context) {
    case 'about':
      return [
        'This text is an "about" document for an AI agent — it describes who the agent is, what they know, and how they should behave.',
        "It is injected into the agent's system prompt when they run tasks.",
        'Good about.md files are written in the second person ("You are..."), are specific and concrete (not generic filler),',
        'and describe expertise, working style, and preferences. They avoid naming a specific person — the role is what matters.',
      ].join(' ');
    case 'chat-composer':
      return [
        'This text is a message the user is about to send to an AI agent in chat.',
        'A good chat message is clear and specific — it names what the user wants, supplies any necessary context,',
        'and is as terse as possible without dropping important detail. It should not read like prose; it should read like a request.',
      ].join(' ');
    case 'task-description':
      return [
        'This text is the long-form description of a task — the "purpose" of the work.',
        'It explains what the task is for, what success looks like, any constraints, and useful background.',
        'A good task description is concrete, written in the imperative or declarative voice, and oriented toward someone who will pick the task up cold.',
        'Use markdown headings only when the body warrants more than a paragraph. Avoid restating the title verbatim.',
      ].join(' ');
    default:
      return [
        'Improve the text for clarity, concision, and correctness while preserving the original intent.',
        "Fix grammar and awkward phrasing. Keep the author's voice.",
      ].join(' ');
  }
}

function stripFences(text: string): string {
  const full = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  if (full && full[1] !== undefined) return full[1];
  return text;
}
