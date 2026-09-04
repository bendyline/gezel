import type { GezelSummary, TimelineMessage } from '@bendyline/gezel';
import {
  displayName,
  handoffHeadline,
  handoffKindLabel,
  parseTaskHandoffNote,
} from '@bendyline/gezel';
import { GezelIcon } from './GezelIcon.js';
import { RoleSuffix, StreamingStatusLine, useElapsedSeconds } from './chat-bubbles.js';
import type { LiveSlot } from './chat-live-slot.js';
import {
  countSegmentTools,
  liveStatusLabel,
  queueNoticeIsFresh,
  segmentsHaveText,
} from './chat-live-slot.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

/**
 * Render a single-line plain-text preview of a markdown message body.
 * Used by the sticky context-header to show the originating user
 * prompt without leaking raw `@[Name](gezel:id)` mention syntax,
 * `**bold**`, code fences, etc. The full text is available in the
 * sticky's `title` attribute for users who want to read the original.
 *
 * Deliberately regex-based and forgiving — the input is a chat message
 * (typically one short paragraph), not arbitrary CommonMark, so a
 * dedicated parser would be overkill. Order matters: image refs
 * before plain links (the `!` would survive otherwise), mention links
 * before plain links (so `@[Name]` keeps its `@`).
 */
function previewifyMarkdown(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // ![alt](src) → alt
    .replace(/@\[([^\]]+)\]\([^)]+\)/g, '@$1') // @[Name](gezel:id) → @Name
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/\*\*([^*]+)\*\*/g, '$1') // **bold** → bold
    .replace(/__([^_]+)__/g, '$1') // __bold__ → bold
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1') // *italic* → italic
    .replace(/(?<!_)_([^_]+)_(?!_)/g, '$1') // _italic_ → italic
    .replace(/~~([^~]+)~~/g, '$1') // ~~strike~~ → strike
    .replace(/`+([^`]+)`+/g, '$1') // `code` → code
    .replace(/^\s*#+\s+/gm, '') // # heading → heading
    .replace(/^\s*>\s+/gm, '') // > quote → quote
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered-list markers
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pinned at the top of the chat scroll viewport — surfaces the
 * user prompt + the assistant bubble header for whatever's
 * currently being scrolled past. Keeps the conversation context
 * visible while the user reads through a long response.
 *
 * Exported for its unit test (same reason as `staleLiveSessionIds`): it is
 * the second place that decides an author label, so it can drift from the
 * bubble's without a test holding the two together.
 */
export function ChatStickyHeader({
  payload,
  gezels,
}: {
  payload: {
    userMsg: TimelineMessage;
    assistantInfo:
      | { kind: 'live'; sessionId: string; slot: LiveSlot }
      | { kind: 'message'; msg: TimelineMessage };
  };
  gezels: Map<string, GezelSummary>;
}): React.ReactNode {
  const { userMsg, assistantInfo } = payload;
  // For the live-slot case we drive the same `THINKING · Ns · K
  // tools · ····` line the streaming bubble renders. For
  // completed-message case the bubble has no live status — just
  // the author label.
  const isLive = assistantInfo.kind === 'live';
  const slotForLive = isLive ? assistantInfo.slot : null;
  const liveElapsed = useElapsedSeconds(isLive ? (slotForLive?.startedAt ?? null) : null);
  const assistantGezelId = isLive ? assistantInfo.sessionId : assistantInfo.msg.gezelId;
  const assistantGezel = gezels.get(
    isLive ? (slotForLive?.gezelId ?? '') : assistantInfo.msg.gezelId,
  );
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const assistantName = assistantGezel
    ? displayName(
        { name: assistantGezel.name, roleBasedName: assistantGezel.roleBasedName },
        roleBasedNameOnlyMode,
      )
    : 'Gezel';
  // A task dispatch seed rides the user role but is the machinery talking —
  // the bubble labels it System, and the sticky header has to agree or the
  // attribution flips as the user scrolls. A seed the card parser recognises
  // goes one better: the header carries the same one-line hand-off sentence
  // the card shows, instead of the dispatch paragraph truncated mid-word.
  const handoffNote = userMsg.origin === 'system' ? parseTaskHandoffNote(userMsg.content) : null;
  const userPreview = handoffNote
    ? handoffHeadline(handoffNote, assistantName)
    : previewifyMarkdown(userMsg.content);
  return (
    <div className="chat-sticky-header" aria-live="polite">
      <div className="chat-sticky-header-user" title={userMsg.content}>
        <span className="chat-sticky-header-author">
          {handoffNote
            ? handoffKindLabel(handoffNote).toUpperCase()
            : userMsg.origin === 'system'
              ? 'SYSTEM'
              : 'YOU'}
        </span>
        <span className="chat-sticky-header-preview">{userPreview}</span>
      </div>
      <div className="chat-sticky-header-assistant" key={assistantGezelId}>
        <GezelIcon
          svg={assistantGezel?.icon ?? null}
          poppetje={assistantGezel?.poppetje}
          iconOverride={assistantGezel?.iconOverride}
          name={assistantName}
          size={18}
        />
        <span className="chat-sticky-header-author">{assistantName}</span>
        {!roleBasedNameOnlyMode && assistantGezel?.role && (
          <RoleSuffix role={assistantGezel.role} />
        )}
        {isLive && slotForLive && (
          <StreamingStatusLine
            failed={Boolean(slotForLive.error)}
            queued={
              slotForLive.queueAhead !== undefined &&
              queueNoticeIsFresh(slotForLive.queuedAt, Date.now()) &&
              !segmentsHaveText(slotForLive.segments)
            }
            queueAhead={slotForLive.queueAhead}
            elapsedSeconds={liveElapsed}
            toolCount={countSegmentTools(slotForLive.segments)}
            wirePulseCount={slotForLive.wirePulseCount}
            {...(liveStatusLabel(slotForLive)
              ? { thinkingLabel: liveStatusLabel(slotForLive) }
              : {})}
            {...(slotForLive.thinkingProgress !== undefined
              ? { thinkingProgress: slotForLive.thinkingProgress }
              : {})}
            {...(slotForLive.thinkingDetail ? { thinkingDetail: slotForLive.thinkingDetail } : {})}
            {...(slotForLive.awaitingGezelName
              ? { awaitingGezelName: slotForLive.awaitingGezelName }
              : {})}
          />
        )}
      </div>
    </div>
  );
}
