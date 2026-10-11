/**
 * Chat notices for context-window maintenance that succeeded. They ride the
 * `warning` channel (and persist as plain strings in `ChatMessage.warnings`)
 * so the person knows earlier detail was folded away, but nothing went
 * wrong, so the UI renders them without the warning glyph. The emitters and
 * the UI both go through this module so the two can never disagree about
 * which text is a maintenance note.
 */

const AUTO_COMPACTED_PREFIX = 'Auto-compacted ';

export const CONDENSED_TOOL_OUTPUT_NOTICE =
  'Condensed this turn’s older tool output to stay inside the context window. The most recent results are untouched.';

export function autoCompactedNotice(removed: number, contextWindow: number): string {
  return `${AUTO_COMPACTED_PREFIX}${removed} earlier message${removed === 1 ? '' : 's'} in this ${contextWindow.toLocaleString('en-US')}-token context window so the current turn could continue.`;
}

export function isContextMaintenanceNotice(message: string): boolean {
  return message.startsWith(AUTO_COMPACTED_PREFIX) || message === CONDENSED_TOOL_OUTPUT_NOTICE;
}
