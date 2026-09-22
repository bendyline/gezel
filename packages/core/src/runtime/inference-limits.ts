import type { HandoffChainLimits } from '../handoff-limits.js';
import { encodeText } from './files.js';

/**
 * How far one turn may hand work down the crew on a device that runs one
 * turn at a time: three ancestors deep, six handoffs per root turn. The
 * desktop's consultation graph has its own, larger budget.
 */
export const PORTABLE_HANDOFF_LIMITS: HandoffChainLimits = { maxDepth: 3, maxCount: 6 };

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

/**
 * How much of a tool result the model reads back on this host. The persisted
 * receipt is bounded separately, by the shared receipt builder; this is the
 * working-memory budget of an on-device model with a small context.
 */
export const PORTABLE_TOOL_RESULT_MODEL_CAP = 12_000;
