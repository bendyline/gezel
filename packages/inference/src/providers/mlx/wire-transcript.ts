import type { WireTranscriptEntry } from '../types.js';
import type { ChatMessage } from './chat-protocol.js';

/**
 * The transcript part of an MLX session's message list — everything after
 * its leading system bands — in the `priorMessages` shape the session
 * constructor turns straight back into the same `ChatMessage`s. That round
 * trip is the point: a session reseeded from this renders the same prompt
 * tokens the engine last cached.
 *
 * `undefined` when the list cannot round-trip: images (base64 would bloat a
 * checkpoint and vision KV is never persisted anyway), a system message past
 * the leading bands, or a tool result with no call id.
 */
export function mlxWireTranscript(
  messages: readonly ChatMessage[],
): WireTranscriptEntry[] | undefined {
  let start = 0;
  while (start < messages.length && messages[start]!.role === 'system') start++;
  const out: WireTranscriptEntry[] = [];
  for (const m of messages.slice(start)) {
    if (m.role === 'system') return undefined;
    if (m.images && m.images.length > 0) return undefined;
    if (m.role === 'tool') {
      if (!m.tool_call_id) return undefined;
      out.push({ role: 'tool', content: m.content ?? '', toolCallId: m.tool_call_id });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      out.push({
        role: 'assistant',
        content: m.content ?? '',
        toolCalls: m.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        })),
      });
      continue;
    }
    out.push({ role: m.role, content: m.content ?? '' });
  }
  return out;
}
