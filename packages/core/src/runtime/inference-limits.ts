import { encodeText } from './files.js';

/** Transport limits shared by the native hosts. Token admission belongs to the
 * provider's tokenizer; a bytes-per-token guess can reject valid conversations. */
export function portableInputLimitError(
  messages: ReadonlyArray<{ content: string }>,
): string | null {
  if (messages.length > 128)
    return 'This conversation has too many messages. Start a new conversation; the saved history stays available.';
  let bytes = 0;
  for (const message of messages) {
    bytes += encodeText(message.content).byteLength;
    if (bytes > 256 * 1024)
      return 'This conversation exceeds the supported input size. Start a new conversation or use smaller file excerpts.';
  }
  return null;
}
