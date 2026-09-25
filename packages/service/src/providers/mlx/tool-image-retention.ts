/**
 * Tool-returned images ride one request after the tool that returned them.
 *
 * `preview_document` hands back slide renders as a vision message, and the
 * session kept it in history. Every later request resent all of it, and a
 * request carrying images disables the prefix cache, so each remaining turn
 * of a powerpoint-deck evaluate step re-encoded six slide images and
 * re-prefilled ~33K text tokens: about three minutes a turn (qwen3.8-27b,
 * 2026-09-23). Once the model has answered after seeing them, later requests
 * carry a note instead of the pixels. A model that needs to look again calls
 * the tool again.
 *
 * Only the runtime's own tool-image message is retired. A picture the user
 * attached stays, because a follow-up question about it is ordinary chat.
 */

export const TOOL_IMAGES_MESSAGE =
  'Images returned by the preceding tools. Inspect the pixels before judging them.';

interface RetainableMessage {
  role: string;
  content?: unknown;
  images?: string[];
}

export function retireInspectedToolImages<T extends RetainableMessage>(messages: T[]): T[] {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return messages;
  let changed = false;
  const out = messages.map((message, index) => {
    if (
      index > lastAssistant ||
      message.role !== 'user' ||
      !message.images?.length ||
      message.content !== TOOL_IMAGES_MESSAGE
    ) {
      return message;
    }
    changed = true;
    const { images, ...rest } = message;
    return {
      ...rest,
      content: `${images.length} image(s) returned by an earlier tool call were inspected in a previous turn and are no longer attached. Call that tool again to look at them again.`,
    } as T;
  });
  return changed ? out : messages;
}
