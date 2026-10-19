/**
 * The composer's sparkle menu: one-shot rewrites of what a person is about to
 * send, shown in the composer for them to read, edit, or undo before Send.
 * Nothing here sends anything. Instructions and reply parsing live together
 * so a host can only ever parse the shape it asked for.
 *
 * Every rewrite keeps the person's facts. The image bench's blind rewrite
 * (Gemma 4 E4B, 2026-10-18) added "1girl, 1boy" to an empty landscape,
 * dropped a count, and put quotes around a mug's description, which tells a
 * text-capable image model to letter it. The image instruction forbids
 * exactly those.
 *
 * Pure and browser-safe.
 */
import type { PromptAssistAction } from './schemas/prompt-assist.js';

const TAG = 'message';

function wrapReply(): string {
  return `Reply with the rewritten message between <${TAG}> and </${TAG}>, and nothing else.`;
}

const KEEP =
  'Keep its meaning and every name, number, date, file name, link and quoted phrase exactly as written. Do not answer it, and do not add requests it does not make.';

/** The one-shot input for an action. */
export function buildPromptAssistInput(
  action: PromptAssistAction,
  text: string,
  opts: { recipient?: string; imageGuide?: string; notes?: readonly string[] } = {},
): string {
  const to = opts.recipient ? ` to ${opts.recipient}` : '';
  const message = `<${TAG}>\n${text}\n</${TAG}>`;
  switch (action) {
    case 'clarify': {
      const notes =
        opts.notes && opts.notes.length > 0
          ? `\n\nApply these suggestions:\n${opts.notes.map((n) => `- ${n}`).join('\n')}`
          : '';
      return `Rewrite the message below, which someone is about to send${to}, so it is clear and easy to act on. ${KEEP}${notes}\n\n${message}\n\n${wrapReply()}`;
    }
    case 'shorten':
      return `Shorten the message below, which someone is about to send${to}. Keep every request and every fact; cut repetition, hedging and filler. ${KEEP}\n\n${message}\n\n${wrapReply()}`;
    case 'proofread':
      return `Fix spelling, grammar and punctuation in the message below. Change nothing else: not the wording, the tone, the order, or the formatting. Use American English.\n\n${message}\n\n${wrapReply()}`;
    case 'review':
      return `Someone is about to send the message below${to}. Name two or three specific changes that would get them a better result: missing context, an ambiguity, a detail the recipient will need. Do not rewrite the message. Reply with one suggestion per line, each starting with "- ", and nothing else.\n\n${message}`;
    case 'shape-image': {
      const guide = opts.imageGuide ? ` The model that will draw it: ${opts.imageGuide}` : '';
      return `Rewrite the request below as a prompt for an image model.${guide} Keep the subject, how many of each thing there are, and any words the image must show, exactly as the person wrote them. Add no objects, people, characters, words or quotation marks they did not ask for, and no tags for people (such as 1girl or 1boy) unless the request names a person of that kind. Describe setting, composition, light and style only where the request implies them, in one short line. Leave out request words such as "please", "can you" or "make me". If the request already reads well for this model, return it unchanged.\n\n${message}\n\n${wrapReply()}`;
    }
  }
}

function stripReasoning(reply: string): string {
  return reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```[a-z]*\s*|```\s*$/gim, '')
    .trim();
}

export type PromptAssistResult = { text: string; unchanged?: true } | { suggestions: string[] };

/**
 * Read a one-shot reply. Null when it is not the asked-for shape or came back
 * empty: the composer then says it could not help rather than replacing the
 * person's words with nothing. A rewrite identical to the draft is marked
 * `unchanged`, which means the draft already read well.
 */
export function parsePromptAssistReply(
  action: PromptAssistAction,
  reply: string,
  original: string,
): PromptAssistResult | null {
  const body = stripReasoning(reply);
  if (action === 'review') {
    const suggestions = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[-*•]\s+/.test(line))
      .map((line) => line.replace(/^[-*•]\s+/, '').trim())
      .filter((line) => line.length > 0)
      .slice(0, 5);
    return suggestions.length > 0 ? { suggestions } : null;
  }
  const tagged = body.match(new RegExp(`<${TAG}>\\s*([\\s\\S]*?)\\s*</${TAG}>`, 'i'));
  const text = (tagged ? tagged[1]! : body.replace(new RegExp(`</?${TAG}>`, 'gi'), '')).trim();
  if (!text) return null;
  return text === original.trim() ? { text, unchanged: true } : { text };
}
