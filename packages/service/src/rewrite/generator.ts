import type { RewriteTextContext } from '@bendyline/gezel';
import type { ChatManager } from '../chat/manager.js';

/**
 * LLM-backed "rewrite this text" helper. Used by the squisq editor toolbar
 * to improve about.md content, chat drafts, etc.
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
