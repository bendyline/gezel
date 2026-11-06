import type { ChatMessageToolCall } from '@bendyline/gezel';

/*
 * Tool calls that finish a turn on their own, so a turn that ends on one
 * without closing prose is not stalled. A closing-summary nudge would keep
 * this session holding the engine slot that the work it started needs, and
 * weak models answer it by doing the same thing again.
 */

/**
 * message_gezel/delegate_* park delivery until the sender releases its turn,
 * so a nudge kept the parked recipient from ever starting, and the sender
 * repeated the handoff.
 */
export function isSuccessfulAsyncHandoffToolCall(toolCall: ChatMessageToolCall): boolean {
  if (!toolCall.success) return false;
  return (
    toolCall.name === 'message_gezel' ||
    toolCall.name === 'ask_gezel' ||
    toolCall.name === 'ask_specialist' ||
    toolCall.name.startsWith('delegate_')
  );
}

/**
 * The launched task's entry turn needs the slot, and its dispatch can still
 * be in flight when the queue is checked. Given the nudge, Gemma 4 E4B
 * launched the same status report again under a new title, past the
 * root-turn dedupe (2026-11-01).
 */
export function isSuccessfulTaskLaunchToolCall(toolCall: ChatMessageToolCall): boolean {
  return (
    toolCall.success === true &&
    (toolCall.name === 'invoke_craftbook' || toolCall.name === 'start_work')
  );
}
