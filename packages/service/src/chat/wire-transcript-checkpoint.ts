/**
 * Restart continuity for local-engine sessions: checkpoint the exact
 * transcript a session sends, and reseed a rebuilt session with it when the
 * saved history still agrees.
 *
 * Why not just rebuild from saved history? `buildToolEvidenceReplay` is right
 * for what it does — it dedupes re-reads, spends a budget on the most recent
 * results, and labels every restored result `[recovered from an earlier
 * turn]` — but the prompt it renders shares only the system head with the
 * one the engine cached before the restart. MLX persists that cache across a
 * graceful stop, and its 48 linear-attention layers cannot be trimmed back to
 * a shorter shared prefix, so a rebuilt transcript re-prefills everything
 * after the system prompt. Measured on the incident that motivated this: a
 * resumed 69k-token task turn reused 14k cached tokens and re-prefilled 55k
 * — four minutes on a 27B, with a person's chat stuck behind it.
 *
 * The checkpoint is only ever a better rendering of the same conversation.
 * When the saved history no longer matches it (edited, compacted, a turn the
 * checkpoint never saw), the restore declines and the caller falls back to
 * the replay, exactly as before.
 */
import { createHash } from 'node:crypto';
import type { ChatMessage, SessionWireTranscript } from '@bendyline/gezel';
import { stripReasoningTags } from '../providers/local-tool-call-salvage.js';
import type { WireTranscriptEntry } from '../providers/types.js';

export interface WireTranscriptBasis {
  count: number;
  digest: string;
}

/** Identity of the saved messages a checkpoint was taken against. */
export function wireTranscriptBasis(messages: readonly ChatMessage[]): WireTranscriptBasis {
  const hash = createHash('sha256');
  for (const m of messages) {
    hash.update(m.role);
    hash.update('\u0000');
    hash.update(m.at);
    hash.update('\u0000');
    hash.update(m.content);
    hash.update('\u0001');
  }
  return { count: messages.length, digest: hash.digest('hex').slice(0, 32) };
}

export function buildWireTranscriptCheckpoint(args: {
  sessionId: string;
  providerName: string;
  inTurn: boolean;
  messages: readonly ChatMessage[];
  transcript: WireTranscriptEntry[];
  savedAt: string;
}): SessionWireTranscript {
  return {
    version: 1,
    sessionId: args.sessionId,
    providerName: args.providerName,
    savedAt: args.savedAt,
    inTurn: args.inTurn,
    basis: wireTranscriptBasis(args.messages),
    transcript: args.transcript,
  };
}

export type WireTranscriptRestore =
  | { ok: true; entries: WireTranscriptEntry[]; note: string }
  | { ok: false; reason: string };

/**
 * Prior messages for a session rebuilt from `record`, taken from its
 * checkpoint — or the reason the checkpoint cannot stand in for the saved
 * history.
 *
 * Accepted shapes of the saved messages past the checkpoint's basis:
 *   - nothing — the checkpoint is exactly the history;
 *   - the turn's own aborted reply (`synthetic: 'turn-aborted'`), when the
 *     checkpoint was taken mid-turn: its completed rounds are already in the
 *     checkpoint and the interrupted one produced nothing the next prompt
 *     should carry;
 *   - one ordinary reply, when the process died between persisting a turn
 *     and checkpointing its end: appended as plain text;
 *   - with `omitLastUser`, a trailing user message (the send about to supply
 *     it live) is ignored, as the replay path ignores it.
 * Anything else — a user message the checkpoint never saw, several replies,
 * an edited history — declines.
 */
export function restoreFromWireTranscript(
  checkpoint: SessionWireTranscript | null,
  record: { providerName: string; messages: readonly ChatMessage[] },
  opts: { omitLastUser?: boolean } = {},
): WireTranscriptRestore {
  if (!checkpoint) return { ok: false, reason: 'no checkpoint' };
  if (checkpoint.providerName !== record.providerName) {
    return { ok: false, reason: `checkpoint is from ${checkpoint.providerName}` };
  }
  const messages =
    opts.omitLastUser && record.messages.at(-1)?.role === 'user'
      ? record.messages.slice(0, -1)
      : record.messages;
  if (messages.length < checkpoint.basis.count) {
    return { ok: false, reason: 'saved history is shorter than the checkpoint' };
  }
  const basis = wireTranscriptBasis(messages.slice(0, checkpoint.basis.count));
  if (basis.digest !== checkpoint.basis.digest) {
    return { ok: false, reason: 'saved history changed since the checkpoint' };
  }
  const extra = messages.slice(checkpoint.basis.count);
  if (extra.length === 0) {
    return { ok: true, entries: [...checkpoint.transcript], note: 'exact' };
  }
  if (extra.length > 1 || extra[0]!.role !== 'assistant') {
    return { ok: false, reason: `${extra.length} saved message(s) newer than the checkpoint` };
  }
  const reply = extra[0]!;
  if (reply.synthetic === 'turn-aborted') {
    return checkpoint.inTurn
      ? { ok: true, entries: [...checkpoint.transcript], note: 'interrupted turn' }
      : { ok: false, reason: 'an aborted reply the checkpoint did not cover' };
  }
  if (reply.synthetic) {
    return { ok: false, reason: `a ${reply.synthetic} message newer than the checkpoint` };
  }
  return {
    ok: true,
    entries: [
      ...checkpoint.transcript,
      { role: 'assistant', content: stripReasoningTags(reply.content) },
    ],
    note: 'final reply appended',
  };
}

/**
 * True when every assistant tool call is answered by a tool result before the
 * next non-tool message. Chat templates reject a call with no result, so an
 * end-of-turn checkpoint — not yet proven by being sent — must pass this.
 */
export function wireTranscriptIsPaired(entries: readonly WireTranscriptEntry[]): boolean {
  let open = new Set<string>();
  for (const entry of entries) {
    if (entry.role === 'tool') {
      if (!open.delete(entry.toolCallId)) return false;
      continue;
    }
    if (open.size > 0) return false;
    open = 'toolCalls' in entry ? new Set(entry.toolCalls.map((call) => call.id)) : new Set();
  }
  return open.size === 0;
}
