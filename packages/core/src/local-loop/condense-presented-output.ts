/** Shorten a response already presented to the model without implying that
 * delivery failed. This is transcript maintenance, never a read receipt. */
export function condensePresentedToolOutput(text: string, maxChars = 500): string {
  const limit = Math.max(500, Number.isFinite(maxChars) ? Math.floor(maxChars) : 500);
  if (text.length <= limit) return text;
  // A conservative warning: the original response may itself have omitted
  // data. Do not relabel a delivery cutoff as a complete source read.
  const originalCutoff = /…\[(?:tool output|middle) truncated:/.test(text);
  const notice = `[Earlier tool response shortened for context after being presented. This is not a new read failure. Do not restart completed reads; reopen only specific details needed now.${
    originalCutoff ? ' The original response was also truncated; unread content may remain.' : ''
  }]\n`;
  const separator = '\n…[context excerpt omitted]…\n';
  const available = Math.max(0, limit - notice.length - separator.length);
  const head = Math.ceil(available / 2);
  const tail = available - head;
  // Preserve error headers and tails as well as ordinary source excerpts.
  return notice + text.slice(0, head) + separator + (tail ? text.slice(-tail) : '');
}
