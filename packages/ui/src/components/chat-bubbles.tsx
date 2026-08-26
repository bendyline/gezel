import type {
  ChatEvent,
  ChatMessageToolCall,
  ChatTurnErrorDetail,
  Question,
  ReferencedFile,
  SessionGpuTask,
  ToolCallAudio,
  ToolCallCard,
  ToolCallImage,
  ToolCallVideo,
} from '@bendyline/gezel';
import type { TaskHandoffNote } from '@bendyline/gezel';
import {
  handoffContextLine,
  handoffHeadline,
  handoffKindLabel,
  parseTaskHandoffNote,
  promoteBareChannelNames,
} from '@bendyline/gezel';
import type { MediaProvider, SurfaceScheme } from '@bendyline/squisq';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

// Chat-bubble light surface — shared with the Home intro's embedded
// Handboek page; the scheme and its rationale live in
// [chat-theme.ts](./chat-theme.ts).
const CHAT_BUBBLE_LIGHT_SURFACE: SurfaceScheme = GEZEL_LIGHT_SURFACE;
import { LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import type { FontFamily, Theme } from '@bendyline/squisq/schemas';
import {
  type CSSProperties,
  type MouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { isUserCancelledTurnError } from '../error-report.js';
import { Tooltip } from '../primitives/index.js';
import { requestSettingsSection } from '../settings-nav.js';
import { useEffectiveTheme } from '../theme.js';
import { AudioPlayer } from './AudioPlayer.js';
import { DraftPlanCard } from './DraftPlanCard.js';
import { GezelIcon } from './GezelIcon.js';
import { ImagePreview } from './ImagePreview.js';
import { PendingQuestionCard } from './PendingQuestionCard.js';
import { ReportErrorLink } from './ReportErrorLink.js';
import { ToolArgsSummary } from './ToolArgsSummary.js';
import { ToolCraftbookCard } from './ToolCraftbookCard.js';
import { ToolDiffBlock } from './ToolDiffBlock.js';
import type { OpenChatReference } from './chat-open-command.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from './chat-theme.js';
import { formatElapsedClock } from './elapsed-time.js';
import { fileRefFromHref, linkifyFileRefs } from './file-linkify.js';
import { shouldDisplayIntent } from './intent-display.js';
import { openTabAction, runNavActions } from './nav-actions.js';
import {
  type PendingToolCall,
  dropExecutedPending,
  formatPendingArgsPreview,
  parsePendingToolCalls,
} from './pending-tool-calls.js';
import { stripVisibleToolCallMarkup } from './strip-tool-call-markup.js';
import { renderToolArgsFragment } from './tool-args-fragment.js';
import { formatDurationShort, toolDisplayName, toolErrorSummary } from './tool-display.js';

/**
 * Build the inline style for a rendered bubble body: the gezel's font
 * family plus an optional `--gezel-font-scale` CSS variable (consumed by
 * `.msg-body-rendered .squisq-linear-content` in
 * styles/shared-content.css to size the font proportionally). Returns
 * undefined when neither applies.
 */
function bubbleBodyStyle(fontFamily?: string, fontScale?: number): CSSProperties | undefined {
  const scaled = fontScale !== undefined && fontScale !== 1;
  if (!fontFamily && !scaled) return undefined;
  return {
    // Both channels: `fontFamily` inherits into plain `.msg-body` text,
    // while `--gezel-chat-font` reaches Squisq-rendered content whose
    // inline system-ui stack the stylesheet overrides (see the
    // `.msg-body-rendered .squisq-linear-content` rule).
    ...(fontFamily ? ({ fontFamily, '--gezel-chat-font': fontFamily } as CSSProperties) : {}),
    ...(scaled ? ({ '--gezel-font-scale': String(fontScale) } as CSSProperties) : {}),
  };
}

export interface ToolActivity {
  name: string;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  /** File path the tool touched, when the tool carries one. */
  path?: string;
  /** Ordered file paths touched by a batched filesystem tool. */
  paths?: string[];
  /** Compact, human one-liner — rendered inline with the name. */
  argsSummary?: string;
  /** Full, readable args (every field, untruncated) for the expand + copy affordance. */
  argsFull?: string;
  /** Short full response, or a bounded beginning/end summary for a long response. */
  resultText?: string;
  /** True when `resultText` is a bounded summary rather than the complete response. */
  resultTruncated?: boolean;
  /**
   * Project the tool fired against. Required on cross-project surfaces
   * like the Meester's global timeline so a `write_artifact` call in
   * project X doesn't silently create a References-pane entry that
   * resolves against the default project. Set by whoever publishes the
   * ToolActivity (the SSE envelope handler in ChatTimelineView, or the
   * ChatComposer using its own `projectId` prop).
   */
  projectId?: string;
  /**
   * Image artifacts the tool returned (Playwright `browser_*` screenshots,
   * etc.). Paths are relative to the project's artifacts/ root. Rendered
   * as clickable thumbnails under the tool row.
   */
  images?: ToolCallImage[];
  /**
   * Audio artifacts the tool returned (synthesize_speech narrations).
   * Same artifact-path resolution as `images`. Rendered as inline
   * playback rows under the tool entry.
   */
  audios?: ToolCallAudio[];
  /**
   * Video artifacts the tool returned (`generate_video`). Rendered as an
   * inline `<video>` player under the tool row.
   */
  videos?: ToolCallVideo[];
  /**
   * Unified diff describing the change a surgical-edit tool made
   * (`replace_in_file`, `apply_patch`, `insert_at_marker`). When set, the
   * tool row gets a collapsible `<ToolDiffBlock>` underneath showing
   * the before/after with `+`/`-` line coloring.
   */
  diff?: string;
  addedLines?: number;
  removedLines?: number;
  /**
   * Rich inline card payload for tools with special renderings
   * (craftbook start, step advance). When set, a `<ToolCraftbookCard>`
   * renders beneath the tool row — and, on completed bubbles, promoted
   * above the collapsed step list like generated media.
   */
  card?: ToolCallCard;
}

export type InlineWarning = Extract<ChatEvent, { type: 'warning' }>;
type WarningValue = string | InlineWarning;

export interface MessageBubbleProps {
  role: 'user' | 'assistant';
  content: string;
  authorLabel: string;
  authorIcon: string | null;
  /** Author's persisted poppetje. Preferred over `authorIcon` for rendering. */
  authorPoppetje?: import('@bendyline/gezel').Poppetje | null;
  /** When true and the gezel has a custom icon.svg, show that instead of the poppetje. */
  authorIconOverride?: boolean;
  /**
   * The gezel's role (Meester, Voorman, Reviewer, etc.) — rendered as
   * a muted suffix to the right of the name. Optional; user bubbles
   * ignore this. Pulled from the gezel's frontmatter at the call site.
   */
  authorRole?: string;
  /**
   * Native-title tooltip for the author name + icon. Used to surface
   * "which provider + model is actually handling this session"
   * on hover, so drift between the user's Default-provider pick
   * and what a given session actually dispatches to is visible
   * without digging through logs. Format is caller's choice —
   * short phrases render best. Assistant bubbles only.
   */
  authorTooltip?: string;
  /**
   * When set, render a muted pill next to the author role — used to
   * surface that this session's provider/model differs from the user's
   * current global default. The caller decides *when* drift is shown
   * (compare session-pinned routing to `config.provider` +
   * `config.defaultModel`) and *what* the pill text says. Omit to
   * hide the pill entirely — its presence itself is the signal.
   */
  driftLabel?: string;
  /**
   * When the message was injected by another gezel (via `messageGezel`),
   * this names the sender. Drives the distinct "Aldric → Maya" bubble.
   */
  from?: { gezelId: string; gezelName: string };
  /**
   * This user message was delivered from the mid-turn queue as a nudge
   * (typed while the previous turn was streaming). Renders a small
   * "nudged" chip after the author label. User bubbles only.
   */
  nudge?: boolean;
  /**
   * The machinery authored this user-role message — a task dispatch seed,
   * a step handoff, a page reaction. Labels the bubble **System** instead
   * of "You" and mutes it, so internal instructions ("call
   * `advance_task_step`…") never read as words the person typed. User
   * bubbles only.
   */
  origin?: 'system';
  /**
   * Name of the gezel whose session this bubble lives in — used as the
   * receiver label in the "sender → receiver" header. Required when
   * `from` is set.
   */
  receiverLabel?: string;
  /** Project name to surface as "re: {project}" context. Optional. */
  projectLabel?: string;
  /** Extra classes applied to the wrapper (e.g. timeline fade). */
  extraClass?: string;
  /**
   * Identifies this rendered bubble for the chat-timeline's
   * IntersectionObserver — used by the sticky context header to
   * track which bubble the user has scrolled past. Pass-through
   * to a DOM `data-msg-id` attribute on the wrapper. Same pattern
   * for `dataSessionId`; together they let the observer derive
   * "topmost-occluding assistant + most-recent user message in
   * the same session" without re-deriving from React state.
   */
  dataMsgId?: string;
  dataSessionId?: string;
  /**
   * Resolver for pasted-image references inside the content. User and
   * assistant messages always render through Squisq's markdown pipeline;
   * when this is supplied, relative image references such as
   * `![...](images/…)` can additionally resolve against the session.
   */
  mediaProvider?: MediaProvider | null;
  /**
   * Real project files the assistant reply mentioned — artifacts drawer
   * and workspace tree alike. Drives the chip row rendered under the
   * bubble and — combined with the markdown pipeline — linkification of
   * matching inline code spans. Populated by the server-side parser at
   * message-persist time and backfilled on read for pre-existing
   * messages.
   */
  referencedFiles?: readonly ReferencedFile[];
  /**
   * Task refs (`projectId/num`) the assistant reply mentioned. Same
   * shape as `referencedFiles` — populated by the server-side
   * parser, gated on the task existing. Surfaced as click-through
   * chips next to the file chips.
   */
  referencedTasks?: string[];
  /**
   * Indexed-context sources this USER turn consulted (proactive retrieval) —
   * citations only, never the retrieved text. Renders as a collapsed
   * "Consulted N sources" row so the RAG pipeline reads as visible diligence
   * rather than invisible machinery. Rows with a path deep-link through the
   * same nav actions as search results (line-anchored).
   */
  retrieval?: {
    hits: ReadonlyArray<{
      source: string;
      projectId?: string;
      path?: string;
      line?: number;
      lineEnd?: number;
      score: number;
    }>;
  };
  /**
   * Called when a chip or an inline code-span link is activated. The
   * timeline wraps this to include the originating message's
   * `projectId`, so cross-project surfaces like the Meester's global
   * timeline can route the lookup to the correct project.
   */
  onFileReference?: (file: ReferencedFile) => void;
  /**
   * Opens a path carried by a successful file-tool row in the same
   * References viewer as `/open`. Unlike `onFileReference`, this also
   * supports shared-library documents, which never appear in the reply
   * parser's `ReferencedFile` union.
   */
  onOpenReference?: (reference: OpenChatReference) => void;
  /**
   * Called when a referenced-task chip is activated. Receives the full
   * `projectId/num` ref. Surfaces like the Meester's timeline can wire
   * this to dispatch a `gezel:open-tab` event with `kind: 'task'`.
   */
  onTaskReference?: (ref: string) => void;
  /**
   * Opens a task BESIDE the chat (the rail's Task pane) — the inline
   * craftbook cards' primary open verb, distinct from `onTaskReference`
   * (which surfaces wire to the full task tab). Absent → the card falls
   * back to the full-tab open itself.
   */
  onFocusTask?: (ref: string) => void;
  /**
   * MCP tool invocations from the turn that produced this reply. When
   * present + non-empty, a collapsible "N steps" expando renders at the
   * top of the bubble. Assistant messages only — user/handoff bubbles
   * ignore this.
   */
  toolCalls?: ChatMessageToolCall[];
  /**
   * Chain-of-thought the local providers captured from `<think>` /
   * `<reasoning>` tags during this turn. When present, renders below
   * the tool history expando as a collapsed "Thinking" disclosure so
   * users can re-read the model's deliberation without it dominating
   * the bubble. Assistant messages only.
   */
  reasoning?: string;
  /**
   * Observed span of the provider's streamed reasoning chunks. Omitted
   * when the provider only exposes reasoning after the turn, since total
   * response latency would incorrectly include queueing and tool work.
   */
  reasoningDurationMs?: number;
  /**
   * Tool-call bodies the salvage layer couldn't parse on this turn.
   * When the visible content is empty AND this is non-empty, the
   * bubble derives a "what the model was trying to do" summary from
   * the parsed tool name and renders the bodies in a collapsible
   * expander — far more useful than the generic "No response" copy
   * the empty-bubble placeholder used to fall back to.
   */
  attemptedToolCalls?: Array<{ body: string; reason?: string }>;
  /**
   * Project the message lives under. Used by the tool-history expando
   * to load image artifact thumbnails (the `images[]` on a tool call
   * are project-scoped paths). Optional because not every caller has
   * a project in scope (the live composer passes its own; reload paths
   * pass the session's project).
   */
  projectId?: string;
  /**
   * Phase-announcement offsets captured during the turn
   * (Copilot `report_intent`). When present, the body renders as
   * `[text slice] <IntentDivider> [next slice] …` so the bubble shows
   * the same HR dividers the live streaming bubble showed while the
   * turn was in flight.
   */
  intents?: Array<{ label: string; afterChars: number }>;
  /**
   * The structured question this assistant turn posed via
   * `ask_user_question` (looked up by `pendingQuestionId`). When set,
   * the card renders below the body. Pending questions stay
   * interactive; answered ones collapse to a one-line summary.
   */
  question?: Question;
  /** Called by the card after the user answers / skips. */
  onQuestionAnswered?: (q: Question) => void;
  /**
   * Chat bubble font override (CSS `font-family` value). For normal
   * assistant bubbles this is the session gezel's font; for inter-gezel
   * handoff bubbles (`from` set) it's the *sender* gezel's font. User
   * bubbles ignore this — typography is a gezel identity thing.
   */
  fontFamily?: string;
  /**
   * Per-font size-adjustment factor (default 1) that keeps differently
   * proportioned typefaces reading at roughly the same visual size.
   * Applied as the `--gezel-font-scale` CSS variable on the bubble body.
   */
  fontScale?: number;
  /**
   * When true, the gutter toolbar reveals a second "copy debug bundle"
   * button on assistant bubbles — fetches the freshly-computed system
   * prompt + recent messages + model metadata for this session and
   * copies it as a markdown bundle for prompt-debugging investigations.
   * Driven by `config.debugMode`. Hidden in normal use.
   */
  debugMode?: boolean;
  /**
   * The session id this bubble belongs to — required for the debug
   * bundle fetch. Already passed via `dataSessionId` for the timeline's
   * IntersectionObserver, but the toolbar button needs it as a prop
   * since it's used in a callback rather than read from the DOM.
   */
  sessionId?: string;
  /**
   * The message's `at` ISO timestamp — used by the debug bundle fetch
   * to slice the message window up to this bubble. The recent message
   * window in the bundle reflects what the model would have seen if
   * it were rebuilt at this point in the transcript.
   */
  messageAt?: string;
  /**
   * True when this bubble is an empty intermediate of the continuation
   * loop — the model emitted tools but no closing text on this turn,
   * AND the next assistant message in the same session has real
   * content. The empty bubble still renders so the timeline stays
   * granular, but the "Ask again or prompt for a recap" placeholder
   * is replaced with a quieter "(continued in the next turn)" line —
   * the recap actually happened, the user doesn't need to act.
   * Computed at the timeline level via next-row peek.
   */
  recoveredInNextTurn?: boolean;
  /**
   * Skip the author header row. The threaded timeline sets this on
   * consecutive replies by the same gezel so an author run reads as
   * one voice (Slack-style) instead of restating "SOFIYA · Language
   * Trainer" above every bubble. Assistant bubbles only — user and
   * handoff headers always render.
   */
  suppressHeader?: boolean;
  /**
   * Short relative-time label ("14m ago") appended to the header.
   * The threaded timeline sets it on thread roots and on late replies
   * — with replies grouped under their trigger, vertical adjacency no
   * longer implies wall-clock adjacency, so the header carries the
   * time cue.
   */
  timestampLabel?: string;
}

/**
 * Role badge rendered to the right of the gezel name in chat-message
 * headers. Two well-known roles get an iconic glyph in addition to the
 * text — meester (the team concierge / front-door figure) gets a top
 * hat, voorman (project foreman) gets a star matching the existing
 * sidebar convention. Other roles render with just the text, in muted
 * styling, so a custom-named "Reviewer" or "Designer" still surfaces
 * without us having to invent a glyph for every variant.
 */
export function RoleSuffix({ role }: { role?: string }) {
  if (!role) return null;
  const key = role.toLowerCase().trim();
  let glyph: string | null = null;
  if (key === 'meester') glyph = '🎩';
  else if (key === 'voorman') glyph = '⭐';
  return (
    <span className="msg-role-suffix">
      {glyph && (
        <span className="msg-role-glyph" aria-hidden>
          {glyph}
        </span>
      )}
      {role}
    </span>
  );
}

/**
 * A task hand-off, rendered as a short letter rather than the dispatch
 * paragraph the model was actually sent. The seed's four sentences of
 * tool-calling procedure are written for the model and read as noise in a
 * transcript, so they move into the "Full note" expando — one line of
 * provenance rather than the opening of the thread. `msg-user` stays on the
 * wrapper because the timeline's sticky-header pass identifies the turn a
 * reply belongs to by that class.
 */
function HandoffNoteCard({
  note,
  receiver,
  full,
  projectLabel,
  timestampLabel,
  extraClass,
  dataMsgId,
  dataSessionId,
  onTaskReference,
}: {
  note: TaskHandoffNote;
  receiver: string;
  full: string;
  projectLabel?: string;
  timestampLabel?: string;
  extraClass?: string;
  dataMsgId?: string;
  dataSessionId?: string;
  onTaskReference?: (ref: string) => void;
}) {
  const context = handoffContextLine(note);
  return (
    <div
      className={`msg msg-user msg-system msg-handoff-note${extraClass ? ` ${extraClass}` : ''}`}
      data-msg-id={dataMsgId}
      data-session-id={dataSessionId}
    >
      <div className="msg-handoff-note-card">
        <div className="msg-handoff-note-head">
          <span className="msg-handoff-note-kind">{handoffKindLabel(note)}</span>
          {projectLabel && <span className="msg-handoff-note-project">· in {projectLabel}</span>}
          {timestampLabel && <span className="msg-role-time">· {timestampLabel}</span>}
        </div>
        <p className="msg-handoff-note-headline">{handoffHeadline(note, receiver)}</p>
        {context && <p className="msg-handoff-note-context">{context}</p>}
        <div className="msg-handoff-note-actions">
          {onTaskReference ? (
            <button
              type="button"
              className="msg-ref-chip"
              onClick={() => onTaskReference(note.taskRef)}
              title="Open this task"
            >
              Task {note.taskRef}
            </button>
          ) : (
            <span className="msg-handoff-note-ref">Task {note.taskRef}</span>
          )}
          <details className="msg-handoff-note-details">
            <summary>Full note</summary>
            <p className="msg-handoff-note-full">{full}</p>
          </details>
        </div>
      </div>
    </div>
  );
}

export function MessageBubble({
  role,
  content,
  authorLabel,
  authorIcon,
  authorPoppetje,
  authorIconOverride,
  authorRole,
  authorTooltip,
  driftLabel,
  from,
  nudge,
  origin,
  receiverLabel,
  projectLabel,
  extraClass,
  mediaProvider,
  referencedFiles,
  referencedTasks,
  retrieval,
  onFileReference,
  onOpenReference,
  onTaskReference,
  onFocusTask,
  toolCalls,
  reasoning,
  reasoningDurationMs,
  attemptedToolCalls,
  projectId,
  intents,
  question,
  onQuestionAnswered,
  fontFamily,
  fontScale,
  dataMsgId,
  dataSessionId,
  debugMode,
  sessionId,
  messageAt,
  recoveredInNextTurn,
  suppressHeader,
  timestampLabel,
}: MessageBubbleProps) {
  // When the assistant reply referenced real files, pre-process the
  // markdown so code spans matching those filenames become clickable
  // links. Rewriting happens once per bubble. Also runs the
  // display-only tool-call markup scrub here — when the salvage layer
  // missed a malformed tool-call shape (truncated tags, hybrid formats),
  // the markup persists in the stored message; this hides it from the
  // user without altering the persisted transcript (so the model's
  // next-turn view still contains exactly what it emitted).
  //
  // Also runs `promoteBareChannelNames` so any bare `thought\n` /
  // `analysis\n` leaks that landed in the persisted message (e.g. from
  // a profile that didn't opt into `reasoning.strip-channel-tags`, or
  // a message saved before that behavior shipped) get cleaned up at
  // render time. Idempotent — text that's already been promoted is a
  // no-op.
  const displayContent = useMemo(() => {
    const scrubbed = promoteBareChannelNames(stripVisibleToolCallMarkup(content));
    if (!referencedFiles || referencedFiles.length === 0) return scrubbed;
    return linkifyFileRefs(scrubbed, referencedFiles);
  }, [content, referencedFiles]);

  // Walk `displayContent` and splice intent dividers at their offsets.
  // Produces an ordered list of `text` slices + `intent` markers. A
  // trailing intent (offset == content length) renders as a final
  // divider with no following text, which is the desired behavior for
  // "model announced the next phase then the turn ended."
  //
  // Offsets are clamped to content length in the service write path,
  // so mis-ordered or out-of-range entries sort cleanly into "end of
  // message" dividers rather than throwing here.
  const bodySegments = useMemo(() => {
    const segs: Array<{ kind: 'text'; content: string } | { kind: 'intent'; label: string }> = [];
    if (!intents || intents.length === 0) {
      segs.push({ kind: 'text', content: displayContent });
      return segs;
    }
    const sorted = [...intents].sort((a, b) => a.afterChars - b.afterChars);
    let cursor = 0;
    for (const it of sorted) {
      if (!shouldDisplayIntent(it.label)) continue;
      const at = Math.max(cursor, Math.min(it.afterChars, displayContent.length));
      if (at > cursor) {
        segs.push({ kind: 'text', content: displayContent.slice(cursor, at) });
        cursor = at;
      }
      segs.push({ kind: 'intent', label: it.label });
    }
    if (cursor < displayContent.length) {
      segs.push({ kind: 'text', content: displayContent.slice(cursor) });
    }
    return segs;
  }, [displayContent, intents]);

  // Click delegate for the rendered body — intercepts `#artifact:` and
  // `#workspace:` links so they route to the References pane instead of
  // navigating.
  const handleBodyClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (!onFileReference) return;
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest('a');
      if (!anchor) return;
      const file = fileRefFromHref(anchor.getAttribute('href') ?? '');
      if (!file) return;
      e.preventDefault();
      onFileReference(file);
    },
    [onFileReference],
  );

  const hasFiles = referencedFiles && referencedFiles.length > 0;
  const hasTasks = referencedTasks && referencedTasks.length > 0;
  const chips =
    hasFiles || hasTasks ? (
      <div className="msg-refs">
        {hasFiles && (
          <>
            <span className="msg-refs-label">Files:</span>
            {referencedFiles!.map((file) => (
              <button
                key={`file-${file.kind}-${file.path}`}
                type="button"
                className="msg-ref-chip"
                onClick={() => onFileReference?.(file)}
                title={file.kind === 'workspace' ? `${file.path} — workspace` : file.path}
              >
                {file.path.split('/').pop() ?? file.path}
              </button>
            ))}
          </>
        )}
        {hasTasks && (
          <>
            <span className="msg-refs-label">Tasks:</span>
            {referencedTasks!.map((ref) => (
              <button
                key={`task-${ref}`}
                type="button"
                className="msg-ref-chip"
                onClick={() => onTaskReference?.(ref)}
                title={ref}
              >
                {ref}
              </button>
            ))}
          </>
        )}
      </div>
    ) : null;

  // The indexed-context sources this turn consulted — collapsed by default,
  // one row per citation, path rows deep-linking through the same
  // queue-then-dispatch nav actions as titlebar search results (E1-anchored).
  const retrievalHits = retrieval?.hits ?? [];
  const consultedSources =
    retrievalHits.length > 0 ? (
      <details className="msg-retrieval">
        <summary className="msg-retrieval-summary">
          Consulted {retrievalHits.length} indexed source{retrievalHits.length === 1 ? '' : 's'}
        </summary>
        <ul className="msg-retrieval-list">
          {retrievalHits.map((hit, i) => {
            const label = hit.path
              ? `${hit.path}${hit.line ? `:${hit.line}` : ''}`
              : 'remembered note';
            const key = `${hit.source}:${hit.path ?? 'memory'}:${hit.line ?? i}`;
            if (!hit.path) {
              return (
                <li key={key} className="msg-retrieval-item">
                  [{hit.source}] {label}
                </li>
              );
            }
            const open = () => {
              if (hit.source === 'shared') {
                runNavActions([openTabAction({ kind: 'document', path: hit.path! })]);
                return;
              }
              const targetProject = hit.projectId ?? projectId;
              if (!targetProject) return;
              const intent = {
                projectId: targetProject,
                path: hit.path!,
                source: (hit.source === 'artifacts' ? 'artifacts' : 'workspace') as
                  | 'artifacts'
                  | 'workspace',
                ...(hit.line ? { line: hit.line } : {}),
                ...(hit.lineEnd ? { lineEnd: hit.lineEnd } : {}),
              };
              runNavActions([
                { kind: 'open-file', intent },
                openTabAction({ kind: 'project', id: targetProject }),
                { kind: 'event', type: 'gezel:open-file', detail: intent },
              ]);
            };
            return (
              <li key={key} className="msg-retrieval-item">
                <button type="button" className="msg-ref-chip" onClick={open} title={hit.path}>
                  [{hit.source}] {label}
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    ) : null;

  // A referenced task that is a DRAFT renders as an inline plan card (the
  // card self-hides for non-draft refs, which keep their plain chip above).
  const planCards = hasTasks ? (
    <>
      {referencedTasks!.map((ref) => (
        <DraftPlanCard key={`plan-${ref}`} taskRef={ref} onOpenTask={onTaskReference} />
      ))}
    </>
  ) : null;

  const bodyStyle = bubbleBodyStyle(fontFamily, fontScale);

  // A task dispatch seed is machinery addressed to the model, not prose
  // addressed to the reader — it gets the hand-off card instead of the
  // paragraph. Every other system-authored turn falls through to the
  // plain System bubble below.
  const handoffNote = useMemo(
    () => (role === 'user' && origin === 'system' ? parseTaskHandoffNote(content) : null),
    [role, origin, content],
  );
  if (handoffNote) {
    return (
      <HandoffNoteCard
        note={handoffNote}
        receiver={receiverLabel ?? authorLabel}
        full={displayContent}
        dataMsgId={dataMsgId}
        dataSessionId={dataSessionId}
        {...(projectLabel ? { projectLabel } : {})}
        {...(timestampLabel ? { timestampLabel } : {})}
        {...(extraClass ? { extraClass } : {})}
        {...(onTaskReference ? { onTaskReference } : {})}
      />
    );
  }

  if (from) {
    const body = stripFromPrefix(displayContent, from.gezelName);
    const cls = `msg msg-from-gezel${extraClass ? ` ${extraClass}` : ''}`;
    return (
      <div className={cls} data-msg-id={dataMsgId} data-session-id={dataSessionId}>
        <div className="msg-role msg-role-handoff">
          <span className="msg-handoff-sender">{from.gezelName}</span>
          <span className="msg-handoff-arrow" aria-hidden>
            →
          </span>
          <span className="msg-handoff-receiver">{receiverLabel ?? authorLabel}</span>
          {projectLabel && <span className="msg-handoff-project">re: {projectLabel}</span>}
          {timestampLabel && <span className="msg-role-time">· {timestampLabel}</span>}
        </div>
        {/* Click delegate for rendered anchors — the anchors handle keyboard natively. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: event delegation to child <a> */}
        <div className="msg-body msg-body-rendered" onClick={handleBodyClick} style={bodyStyle}>
          <RenderedMarkdown markdown={body} mediaProvider={mediaProvider} fontFamily={fontFamily} />
        </div>
        {chips}
        {planCards}
        <MessageActions
          markdown={body}
          side="right"
          {...(debugMode && sessionId && role === 'assistant'
            ? { debug: { sessionId, ...(messageAt ? { messageAt } : {}) } }
            : {})}
        />
      </div>
    );
  }
  const isUser = role === 'user';
  // A machine-authored user turn (task dispatch, step handoff) keeps the
  // user role the provider needs but is never presented as the person's
  // own words — see `ChatMessage.origin`.
  const isSystem = isUser && origin === 'system';
  // Header suppression only applies to assistant bubbles — a user
  // bubble's "You" is its alignment anchor and always renders.
  const headerless = suppressHeader && !isUser;
  const cls = `msg msg-${role}${isSystem ? ' msg-system' : ''}${headerless ? ' msg-headerless' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  return (
    <div className={cls} data-msg-id={dataMsgId} data-session-id={dataSessionId}>
      {!headerless && (
        <div className="msg-role" title={!isUser ? authorTooltip : undefined}>
          {isUser ? (
            <>
              {isSystem ? 'System' : 'You'}
              {isSystem && (
                <span
                  className="msg-system-chip"
                  title="Sent by gezel itself to move the task along — you didn't write this"
                >
                  automatic
                </span>
              )}
              {nudge && (
                <span className="msg-nudge-chip" title="Sent while the previous turn was running">
                  nudged
                </span>
              )}
            </>
          ) : (
            <>
              <GezelIcon
                svg={authorIcon}
                poppetje={authorPoppetje}
                iconOverride={authorIconOverride}
                name={authorLabel}
                size={20}
              />
              <span>{authorLabel}</span>
              <RoleSuffix role={authorRole} />
              {driftLabel && <span className="msg-role-drift">{driftLabel}</span>}
            </>
          )}
          {projectLabel && <span className="msg-role-project muted">· in {projectLabel}</span>}
          {timestampLabel && <span className="msg-role-time">· {timestampLabel}</span>}
        </div>
      )}
      {!isUser && toolCalls && toolCalls.length > 0 && (
        <ToolHistoryExpando
          tools={toolCalls}
          projectId={projectId}
          onOpenReference={onOpenReference}
          onFocusTask={onFocusTask}
        />
      )}
      {!isUser && reasoning && reasoning.trim().length > 0 && (
        <ReasoningExpando reasoning={reasoning} durationMs={reasoningDurationMs} />
      )}
      {!isUser && attemptedToolCalls && attemptedToolCalls.length > 0 && (
        <AttemptedToolCallsExpando attempts={attemptedToolCalls} />
      )}
      {!isUser && content.trim().length === 0 ? (
        // Assistant turn finished with no visible text. Build the
        // bubble body from whatever signal we DO have so the user
        // never sees a generic "No response" placeholder when the
        // model was actually doing work:
        //   1. `recoveredInNextTurn` — continuation loop produced the
        //      follow-up; quiet stub.
        //   2. `attemptedToolCalls` — model tried to call a tool but
        //      the salvage layer dropped it; surface what they tried
        //      to do so the user sees intent, not "nothing happened."
        //   3. `reasoning` — model produced chain-of-thought but no
        //      visible reply; the ReasoningExpando above already
        //      renders the trace, so the body just acknowledges that.
        //   4. `toolCalls` — tools ran but no summary; explicit
        //      "tools ran, recap missing" copy.
        //   5. Genuine silence — last-resort copy.
        <div className="msg-body msg-body-empty muted">
          <em>
            {recoveredInNextTurn
              ? '(continued in the next turn)'
              : attemptedToolCalls && attemptedToolCalls.length > 0
                ? buildAttemptedCallSummary(attemptedToolCalls)
                : reasoning && reasoning.trim().length > 0
                  ? '(model produced reasoning but no visible reply — see Thinking above)'
                  : toolCalls && toolCalls.length > 0
                    ? `No written response — ${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'} ran but the model didn't produce a summary. Ask again or prompt for a recap.`
                    : 'No response — the model finished its turn without producing any text. This is usually a small local model timing out mid-thought; try resending, a larger model, or a shorter prompt.'}
          </em>
        </div>
      ) : (
        // biome-ignore lint/a11y/useKeyWithClickEvents: event delegation to child <a>
        <div
          className="msg-body msg-body-rendered"
          onClick={handleBodyClick}
          style={isUser ? undefined : bodyStyle}
        >
          {bodySegments.map((seg, i) =>
            seg.kind === 'intent' ? (
              <IntentDivider key={`intent-${i}-${seg.label}`} label={seg.label} />
            ) : (
              <RenderedMarkdown
                // biome-ignore lint/suspicious/noArrayIndexKey: streaming segments are append-only and keyed by position within a single bubble
                key={`text-${i}`}
                markdown={seg.content}
                mediaProvider={mediaProvider}
                fontFamily={fontFamily}
              />
            ),
          )}
        </div>
      )}
      {!isUser && question && (
        <PendingQuestionCard question={question} onAnswered={onQuestionAnswered} />
      )}
      {chips}
      {isUser && consultedSources}
      {planCards}
      <MessageActions
        markdown={content}
        side={isUser ? 'left' : 'right'}
        {...(debugMode && sessionId && !isUser
          ? { debug: { sessionId, ...(messageAt ? { messageAt } : {}) } }
          : {})}
      />
    </div>
  );
}

/**
 * Hover-reveal toolbar that floats in the gutter alongside a chat
 * bubble. Hidden by default; appears when the bubble (or the toolbar
 * itself, for keyboard nav) is hovered/focused. Side mirrors the
 * bubble's alignment — assistant bubbles get the toolbar on the right,
 * user bubbles on the left, both in the empty 8% gutter the bubble's
 * `max-width: 92%` leaves behind.
 *
 * Today the toolbar carries one button: copy the message body as raw
 * markdown to the clipboard. Useful for prompt debugging — what the
 * model actually emitted, sans client-side rewrites. Adding more
 * actions later is just appending more buttons to the same vertical
 * stack.
 */
function MessageActions({
  markdown,
  side,
  debug,
}: {
  markdown: string;
  side: 'left' | 'right';
  /**
   * When set, renders a second debug-only button below the regular
   * copy button. The button fetches the session's freshly-computed
   * system prompt + recent messages + model metadata and copies it
   * as a markdown bundle to the clipboard. Driven by `config.debugMode`
   * — only the engineer running with debug mode on sees it.
   */
  debug?: { sessionId: string; messageAt?: string };
}) {
  const [copied, setCopied] = useState(false);
  const [debugCopied, setDebugCopied] = useState<'idle' | 'copied' | 'error'>('idle');
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard API unavailable / permission denied — fail silently */
    }
  }, [markdown]);
  const handleDebugCopy = useCallback(async () => {
    if (!debug) return;
    try {
      const snapshot = await api.getChatSessionDebug(debug.sessionId, {
        ...(debug.messageAt ? { atTimestamp: debug.messageAt } : {}),
      });
      const bundle = formatDebugBundle({ snapshot, response: markdown });
      await navigator.clipboard.writeText(bundle);
      setDebugCopied('copied');
      window.setTimeout(() => setDebugCopied('idle'), 1500);
    } catch (err) {
      console.error('[debug-copy] failed:', err);
      setDebugCopied('error');
      window.setTimeout(() => setDebugCopied('idle'), 2500);
    }
  }, [debug, markdown]);
  // Two-element structure: an absolutely-positioned anchor that spans
  // the bubble's full height + an inner sticky toolbar. Sticky pins to
  // the chat-timeline scroll viewport so the buttons stay reachable
  // even when the bubble's top has scrolled offscreen, while the
  // anchor's height bounds keep the toolbar from ghosting past the
  // bubble's bottom.
  return (
    <div className={`msg-actions-anchor msg-actions-anchor-${side}`} aria-hidden={false}>
      <div
        className={`msg-actions msg-actions-${side}`}
        role="toolbar"
        aria-label="Message actions"
      >
        <button
          type="button"
          className="msg-action-button"
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy as markdown'}
          aria-label="Copy message as markdown"
        >
          {copied ? '✓' : '⧉'}
        </button>
        {debug && (
          <button
            type="button"
            className="msg-action-button msg-action-button-debug"
            onClick={handleDebugCopy}
            title={
              debugCopied === 'copied'
                ? 'Debug bundle copied!'
                : debugCopied === 'error'
                  ? 'Debug copy failed — see console'
                  : 'Copy debug bundle (system prompt + recent messages + model metadata)'
            }
            aria-label="Copy debug bundle"
          >
            {debugCopied === 'copied' ? '✓' : debugCopied === 'error' ? '!' : '🐛'}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Pick a fence string that's strictly longer than any backtick run
 * inside `content`, so a code block wrapping that content can't be
 * prematurely terminated by an inner fence. CommonMark says a fenced
 * block opened with N backticks closes only on a line of N or more
 * backticks; using more than the max-inner run is the safe shape.
 *
 * Without this the debug bundle's system-prompt section gets eaten by
 * its own contents — the system prompt has triple-backtick examples,
 * the bundle wraps it in triple-backticks, and the first inner ```
 * closes the outer fence. Everything after it renders as raw
 * markdown, which then mangles `_underscore_names_` into italics.
 */
function pickCodeFence(content: string): string {
  let maxRun = 0;
  let current = 0;
  for (const ch of content) {
    if (ch === '`') {
      current += 1;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

function pushFenced(lines: string[], content: string): void {
  const fence = pickCodeFence(content);
  lines.push(fence);
  lines.push(content);
  lines.push(fence);
}

/**
 * Format a debug snapshot into a markdown bundle suitable for pasting
 * into another chat or a bug report. Sections are heavy-headed so a
 * reader scanning the dump can find the system prompt, the response
 * being investigated, and the recent thread without searching. The
 * response is surfaced FIRST after the metadata so it's the first
 * thing the receiving conversation reads — the system prompt and
 * thread are context.
 */
export function formatDebugBundle(opts: {
  snapshot: import('@bendyline/gezel').SessionDebugSnapshot;
  response: string;
}): string {
  const s = opts.snapshot;
  const lines: string[] = [];
  lines.push('# Gezel debug bundle');
  lines.push('');
  lines.push(`Generated: ${s.generatedAt}`);
  lines.push('');
  lines.push('## Model + session');
  lines.push('');
  lines.push(`- Provider: \`${s.providerName}\``);
  if (s.model) lines.push(`- Model: \`${s.model}\``);
  lines.push(`- Tier: \`${s.modelTier}\``);
  if (s.parameterSize) lines.push(`- Parameter size: \`${s.parameterSize}\``);
  lines.push(`- Verbose family (leaks reasoning): \`${s.leaksUntaggedReasoning}\``);
  if (s.reasoningEffort) lines.push(`- Reasoning effort: \`${s.reasoningEffort}\``);
  if (s.numCtx) lines.push(`- num_ctx: \`${s.numCtx}\``);
  lines.push(`- Session: \`${s.sessionId}\``);
  lines.push(`- Turn status at export: \`${s.turnStatus}\``);
  if (s.externalConversation) {
    lines.push(
      `- Conversation owner: **${s.externalConversation.appName}** (caller-owned prompt and tool loop; Gezel is a read-only mirror)`,
    );
    if (s.externalConversation.workingDirectory) {
      lines.push(`- Caller working directory: \`${s.externalConversation.workingDirectory}\``);
    }
    if (s.externalConversation.request) {
      lines.push(`- Caller request captured: \`${s.externalConversation.request.capturedAt}\``);
    }
  }
  if (s.registeredTools.length > 0) {
    const scope =
      s.registeredToolsSource === 'persisted'
        ? ', last known'
        : s.registeredToolsSource === 'caller'
          ? `, supplied by ${s.externalConversation?.appName ?? 'caller'}`
          : '';
    lines.push(
      `- Registered tools (${s.registeredTools.length}${scope}): ${s.registeredTools.map((t) => `\`${t}\``).join(', ')}`,
    );
  } else if (s.registeredToolsSource === 'live') {
    lines.push('- Registered tools: **none** (live session reported an empty bridge)');
  } else if (s.registeredToolsSource === 'caller') {
    lines.push('- Registered tools: **none** (captured caller request supplied no functions)');
  } else {
    // Never assert "none" without having asked a live bridge. An empty
    // list from a cold session is missing evidence, not evidence of a
    // missing roster — and reading it as the latter cost one whole
    // investigation, on a bundle whose own prompt listed ~80 tools.
    // Older snapshots carry no source at all; they land here too.
    lines.push(
      '- Registered tools: **not recorded** (no live session at export — unknown, NOT an empty roster; read the "Tools available this turn" block in the prompt below)',
    );
  }
  if (s.registeredToolsSource === 'caller') {
    lines.push('- Tools listing source: caller-supplied OpenAI-compatible `tools[]`');
  } else if (s.customToolsMd) {
    lines.push(
      '- Tools listing source: **custom `tools.md`** (auto-injected listing fully replaced; gezel owner is responsible for accuracy)',
    );
  } else {
    lines.push('- Tools listing source: auto-injected from registered MCP bridge tools');
  }
  lines.push('');
  lines.push('## Response under investigation');
  lines.push('');
  const response = opts.response.trim();
  if (!response && s.turnStatus !== 'idle') {
    lines.push(
      `> This turn was still ${s.turnStatus} when the bundle was exported. An empty block below is not a completed empty model response.`,
    );
    lines.push('');
  }
  pushFenced(lines, response);
  lines.push('');
  lines.push(
    s.externalConversation
      ? s.externalConversation.request
        ? `## System prompt (captured from ${s.externalConversation.appName} request)`
        : '## System prompt (not captured for this older external mirror)'
      : '## System prompt (freshly computed)',
  );
  lines.push('');
  pushFenced(lines, s.systemPrompt.trim());
  lines.push('');
  if (s.volatileContext && s.volatileContext.trim().length > 0) {
    lines.push('## Volatile context (task/step layer, second system message)');
    lines.push('');
    pushFenced(lines, s.volatileContext.trim());
    lines.push('');
  }
  const externalRequest = s.externalConversation?.request;
  if (externalRequest) {
    lines.push(
      `## Caller-owned request transcript (${externalRequest.transcript.length} of ${externalRequest.messageCount} messages)`,
    );
    lines.push('');
    if (externalRequest.transcriptTruncated) {
      lines.push('> This diagnostic copy was bounded; the owning app remains authoritative.');
      lines.push('');
    }
    for (const message of externalRequest.transcript) {
      const id = message.toolCallId ? ` (tool_call_id: ${message.toolCallId})` : '';
      lines.push(`### ${message.role}${id}`);
      lines.push('');
      pushFenced(lines, message.content.trim());
      for (const call of message.toolCalls ?? []) {
        lines.push('');
        lines.push(`Tool call \`${call.name}\` (\`${call.id}\`) arguments:`);
        lines.push('');
        pushFenced(lines, call.arguments);
      }
      lines.push('');
    }
    if (externalRequest.actionLedger) {
      lines.push('## Action ledger injected into the completion');
      lines.push('');
      pushFenced(lines, externalRequest.actionLedger);
      lines.push('');
    }
  }
  lines.push(`## Recent messages (${s.recentMessages.length})`);
  lines.push('');
  for (const m of s.recentMessages) {
    const roleHeader = m.synthetic ? `${m.role} (synthetic: ${m.synthetic})` : m.role;
    lines.push(`### ${roleHeader}`);
    lines.push('');
    pushFenced(lines, m.content.trim());
    if (m.reasoning && m.reasoning.trim().length > 0) {
      lines.push('');
      lines.push('Reasoning (captured from `<|channel|>` / `<think>` blocks):');
      lines.push('');
      pushFenced(lines, m.reasoning.trim());
    }
    if (m.warnings && m.warnings.length > 0) {
      lines.push('');
      lines.push('Warnings:');
      for (const w of m.warnings) {
        lines.push(`- ${w}`);
      }
    }
    if (m.attemptedToolCalls && m.attemptedToolCalls.length > 0) {
      lines.push('');
      lines.push(
        'Attempted tool calls (salvage failed — these are the literal shapes the model emitted):',
      );
      for (const a of m.attemptedToolCalls) {
        if (a.reason) {
          lines.push(`- reason: ${a.reason.replace(/\n/g, ' ')}`);
        }
        lines.push('  body:');
        // Indented fenced block. `pickCodeFence` returns a backtick
        // run strictly longer than anything inside the body, so a
        // fabricated body containing triple-backticks can't terminate
        // the wrapping fence.
        const fence = pickCodeFence(a.body);
        lines.push(`  ${fence}`);
        for (const ln of a.body.split('\n')) lines.push(`  ${ln}`);
        lines.push(`  ${fence}`);
      }
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      lines.push('');
      lines.push('Tool calls:');
      for (const tc of m.toolCalls) {
        const args = tc.argsSummary ? ` ${tc.argsSummary}` : '';
        const status = tc.success ? 'ok' : 'failed';
        lines.push(`- \`${tc.name}\`${args} — ${status}`);
        if (!tc.success && tc.errorMessage) {
          const truncated =
            tc.errorMessage.length > 400 ? `${tc.errorMessage.slice(0, 400)}…` : tc.errorMessage;
          lines.push(`  - error: ${truncated.replace(/\n/g, ' ')}`);
        }
      }
    }
    lines.push('');
  }
  if (s.diagnostics) {
    const d = s.diagnostics;
    lines.push('## Where to dig deeper');
    lines.push('');
    lines.push(
      "When the bundle isn't enough, these on-disk sources have the full picture the bundle samples:",
    );
    lines.push('');
    lines.push(
      s.externalConversation
        ? `- **Gezel mirror record** (normalized completed turns; ${s.externalConversation.appName} owns the authoritative transcript and intermediate tool loop): \`${d.sessionRecordPath}\``
        : `- **Session transcript** (every turn, tool call, reasoning): \`${d.sessionRecordPath}\``,
    );
    lines.push(`- **Logs directory** (daemon + engine): \`${d.logsDir}\``);
    if (d.engineLogGlob) {
      lines.push(
        `- **Engine log** (model load, SSE lifecycle, crashes): \`${d.logsDir}/${d.engineLogGlob}\` (today's file by date)`,
      );
    }
    lines.push(
      `- **Grep the daemon log for this session:** \`grep ${s.sessionId.slice(0, 8)} ${d.logsDir}/*.log\``,
    );
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Strip the `[Message from {Name}]: ` sentinel the service prefixes onto
 * cross-gezel messages for the model's benefit. The header already shows
 * the sender, so the body reads cleaner without it.
 */
function stripFromPrefix(content: string, fromName: string): string {
  const prefix = `[Message from ${fromName}]:`;
  if (content.startsWith(prefix)) {
    return content.slice(prefix.length).trimStart();
  }
  return content;
}

/**
 * One unit of streaming activity. Re-exported here (mirrors the
 * shape in `ChatTimelineView`) so this module stays standalone.
 */
export type StreamingSegment =
  | { kind: 'text'; content: string }
  | { kind: 'tool'; tool: ToolActivity }
  | { kind: 'intent'; label: string };

/**
 * Horizontal-rule divider with a centered small-caps label, rendered
 * at phase-announcement boundaries in assistant bubbles. The label
 * comes from Copilot's `report_intent` tool; splicing it into the
 * bubble visually segments long multi-phase turns ("Building cart
 * checkout flow" ──── rest of the turn).
 */
export function IntentDivider({ label }: { label: string }) {
  if (!shouldDisplayIntent(label)) return null;
  return (
    <div className="msg-intent-divider" aria-label={label}>
      <span className="msg-intent-divider-label">{label}</span>
    </div>
  );
}

export interface StreamingBubbleProps {
  authorLabel: string;
  authorIcon: string | null;
  /** Author's persisted poppetje. Preferred over `authorIcon` for rendering. */
  authorPoppetje?: import('@bendyline/gezel').Poppetje | null;
  /** When true and the gezel has a custom icon.svg, show that instead of the poppetje. */
  authorIconOverride?: boolean;
  /** Optional gezel role suffix, rendered to the right of the name. */
  authorRole?: string;
  /** See {@link MessageBubbleProps.authorTooltip}. */
  authorTooltip?: string;
  /** See {@link MessageBubbleProps.driftLabel}. */
  driftLabel?: string;
  /**
   * Which locally-hosted engine backs this session, if any. Drives
   * the slow-banner's reassurance copy — Ollama sessions get the
   * probe button, llama-cpp sessions get "first cold-start is slow"
   * messaging, ds4 sessions get "streams a huge model from disk"
   * messaging. Unset / cloud providers fall through to generic copy.
   */
  localEngine?: 'ollama' | 'llama-cpp' | 'ds4';
  /**
   * Ordered timeline of text + tool segments — rendered inline so
   * the user reads "wrote A · then read B · then continues" instead
   * of all tools stacked at the top of the bubble. Adjacent text
   * segments coalesce upstream; consecutive tool segments collapse
   * into one `ToolActivityList` here.
   */
  segments: StreamingSegment[];
  /** Opens a successful file-tool path in the conversation's References viewer. */
  onOpenReference?: (reference: OpenChatReference) => void;
  /** See {@link MessageBubbleProps.onFocusTask} — the inline cards' rail-open verb. */
  onFocusTask?: (ref: string) => void;
  startedAt: number | null;
  /** Extra classes applied to the wrapper (e.g. timeline grouping). */
  extraClass?: string;
  /** Matches `MessageBubble.fontFamily` — session gezel's bubble font. */
  fontFamily?: string;
  /** Matches `MessageBubble.fontScale` — per-font size-adjustment factor. */
  fontScale?: number;
  /**
   * When set, the turn ended in error — render the partial content
   * with a failed banner instead of the live "thinking" indicator.
   * Cleared by the parent when the user sends a new message.
   */
  error?: string;
  /**
   * Machine-readable classification of {@link error}, when the daemon knew
   * one — the incident id, engine, and crash class the bug report needs.
   * Absent for older daemons and for failures with nothing structured to
   * say, so every consumer has to tolerate it being undefined.
   */
  errorDetail?: ChatTurnErrorDetail;
  /**
   * Contextual recovery controls supplied by the timeline (for example,
   * Retry + Acknowledge). When absent, the bubble keeps its standalone
   * report-error fallback used by tests and narrower embedding surfaces.
   */
  errorActions?: import('react').ReactNode;
  /**
   * When set, the turn is sitting in the provider queue — waiting for
   * other turns to finish before it can start. The "thinking" label
   * is replaced with its numbered place in the model queue so the user
   * knows the delay isn't a stall but backpressure. Cleared on the first
   * delta.
   */
  queueAhead?: number;
  /**
   * Wall-clock timestamp of the last observable signal for this turn
   * (a delta token or a completed tool call). Drives the "Still
   * working" reassurance banner: the banner only shows during *silent*
   * phases — a turn that's been actively firing tool calls doesn't
   * need reassurance about being slow, the tool calls ARE the progress
   * signal. Omit or pass equal-to-`startedAt` if no signals have
   * arrived yet.
   */
  lastActivityAt?: number;
  /** Whether this turn has emitted an actual provider/model progress signal. */
  hasProgress?: boolean;
  /**
   * When set, the slow banner gets a "Check Ollama" button that
   * fires this callback and renders the result inline. Lets the
   * user diagnose mid-turn silence on demand — answers "is Ollama
   * up + is the model still loaded?" in one click. Wired from the
   * timeline only when `providerName === 'ollama'` (no point on
   * Copilot / OpenAI sessions).
   */
  onProbeOllama?: () => Promise<OllamaProbeResult>;
  /**
   * When set, the silence banner's stalled tier (no signal for
   * {@link STALLED_AFTER_S}s) offers a "Stop and re-engage" button:
   * cancel the wedged turn, then send a continue nudge. Cancel-first
   * is deliberate — a queued nudge behind a genuinely wedged turn
   * would sit in the session queue forever.
   */
  onReEngage?: () => Promise<void>;
  /**
   * Count of "wire pulses" — bare framing chunks Ollama has sent
   * since the last visible delta / tool. Renders as accumulating
   * dots in the status line so the user can tell "the wire is
   * alive, the model is silently thinking" apart from "the
   * connection died." Capped at a UI-side max so a forever-pulsing
   * model doesn't grow the bubble unbounded.
   */
  wirePulseCount?: number;
  /**
   * Live private-reasoning text streaming on the model's think channel
   * (ds4). Rendered as a distinct dimmed "thinking" block above the
   * reply. Absent once the turn commits — the persisted message carries
   * the same trace on `reasoning`, shown behind the collapsed expander.
   */
  liveReasoning?: string;
  /**
   * Live tool-argument stream — the model is generating a structured
   * tool call (typically a long `write_file`) whose tokens never arrive
   * as visible deltas. Rendered as a dimmed "working" block at the
   * bottom of the bubble, near the streaming caret, showing the tool
   * verb, the target path when one is parseable from the args head,
   * a ticking char counter, and the streaming tail. Cleared by the
   * parent when the real `tool` event lands.
   */
  liveToolArgs?: { name: string; chars: number; head: string; tail: string };
  /**
   * Optional provider-side heartbeat label (e.g. "thinking"). When
   * set, the bubble's status line renders `{label}…` instead of the
   * generic "Thinking". Sourced from Copilot's `thinking_start`
   * events; absent for Ollama/OpenAI/Mock turns.
   */
  thinkingLabel?: string;
  /**
   * 0-1 progress for the current phase (chunked prefill batches).
   * When set, the status line renders a compact progress bar in
   * place of the verbose token count, and `thinkingDetail` carries
   * the original "X / Y tokens · Z tok/s" string into the tooltip.
   */
  thinkingProgress?: number;
  /**
   * Verbose detail to surface as the progress bar's tooltip. Ignored
   * unless `thinkingProgress` is also set.
   */
  thinkingDetail?: string;
  /**
   * Set while a `gpu_swap` event with `state: 'started'` is in
   * flight for this session — i.e. a non-LLM workload (today: local
   * image generation) currently owns the GPU. Drives a distinct
   * status label ("Generating image…") that replaces the misleading
   * "thinking" copy, and suppresses the silence-watchdog banner
   * since the watchdog only applies when the chat model itself is
   * the active tenant.
   */
  gpuSwapTask?: SessionGpuTask;
  /** Free-form detail attached to the active `gpu_swap` event. */
  gpuSwapDetail?: string;
  /**
   * Prompt the model passed to the image generator. When set, renders
   * as an italic caption under the status line so the user can see
   * *what* is being designed instead of staring at a generic
   * "Generating image" label for two minutes.
   */
  gpuSwapPrompt?: string;
  /**
   * 0-1 sampling progress through the current image-generation
   * request, parsed from sd-server's per-step stdout. When set,
   * renders the same progress bar the engine_phase events drive on
   * the chat side.
   */
  gpuSwapProgress?: number;
  /** Latest sampling step / total steps reported by sd-server. */
  gpuSwapStep?: number;
  gpuSwapTotalSteps?: number;
  /** Most recent per-step seconds reading; drives a coarse ETA tooltip. */
  gpuSwapSecondsPerStep?: number;
  /**
   * Set while an `awaiting_gezel` event with `state: 'started'` is in
   * flight — this turn is parked inside a synchronous `ask_gezel` /
   * `ask_specialist` consultation, idle and blocked on a reply from
   * the named gezel. Dims the bubble and replaces the active
   * "thinking" status with a passive "Waiting on <name>", and (like
   * `gpuSwapTask`) suppresses the silence-watchdog banner — the wait
   * is expected, not a stall.
   */
  awaitingGezelName?: string;
  /**
   * Provider-side warnings that arrived mid-turn. Rendered as
   * inline notices above the status line so the user doesn't have
   * to tail server logs to learn that the provider dropped into
   * degraded mode or hit a rate limit.
   */
  warnings?: WarningValue[];
  /**
   * Cancel the in-flight turn. When provided, a small × button
   * renders alongside the thinking-dots so the user can stop a
   * stuck or no-longer-wanted turn without waiting it out. Omit
   * (e.g. on the streaming sticky-header) to hide the button.
   */
  onCancel?: () => void | Promise<void>;
  /** See {@link MessageBubbleProps.dataMsgId}. */
  dataMsgId?: string;
  dataSessionId?: string;
  /**
   * When true, render the same gutter toolbar (copy markdown + copy
   * debug bundle) the persisted MessageBubble shows. Useful while a
   * turn is mid-flight or after it stopped — debugging a failed turn
   * is exactly the moment the bundle is most valuable, but until now
   * the buttons only appeared after the turn finished and the bubble
   * was replaced with a persisted MessageBubble. Driven by
   * `config.debugMode`; the plain copy button shows even without it.
   */
  debugMode?: boolean;
  /**
   * Session id for the debug-bundle fetch. Same value as
   * `dataSessionId` but typed for the toolbar callback (which can't
   * read DOM data attributes). Optional: when omitted, the debug
   * button hides — bundle requires a session id to slice context.
   */
  sessionId?: string;
  /**
   * Pending question raised mid-turn (npm-install / command /
   * tool-permission / image-generation approvals — and any
   * `ask_user_question` whose stamping happens at end-of-turn).
   * When set, the card renders inline below the streaming body so
   * the user can answer in chat instead of reaching for the
   * top-nav dropdown. Once the turn commits, the card transitions
   * to the persisted `MessageBubble` via `pendingQuestionId` and
   * stays visible after reload.
   */
  question?: Question;
  /** Called by the inline card after the user answers / skips. */
  onQuestionAnswered?: (q: Question) => void;
}

/** Mirror of `client.ollamaProbe()` return type — kept local so this
 *  presentational module doesn't reach into the client package. */
export type OllamaProbeResult =
  | {
      ok: true;
      baseUrl: string;
      elapsedMs: number;
      loaded: Array<{ name: string; sizeVram: number; expiresAt?: string }>;
    }
  | { ok: false; baseUrl: string; elapsedMs: number; error: string };

/**
 * In-flight assistant bubble. Shown while the provider is streaming —
 * unified signal so the user sees as much context as possible about
 * what the model is doing. Surfaces:
 *
 *   • An elapsed-time counter ("12s elapsed") so long silent phases
 *     (especially Ollama reasoning models that emit no tokens until
 *     they're done thinking) don't feel broken.
 *   • A running list of completed tool calls, each with name, duration,
 *     and success/fail glyph. Tool calls fire during the turn; this is
 *     the most informative breadcrumb we have for multi-step agents.
 *   • Partial assistant text rendered with Squisq's markdown renderer
 *     (same pipeline the completed response uses). Falls back to plain
 *     text when the partial markdown doesn't parse cleanly mid-stream.
 *   • A pulse of thinking dots shown whenever there's no visible text
 *     yet — tells the user "the model is in silent deliberation."
 *
 * On `complete`, the parent removes this component and pushes the final
 * message into its message list, where it's rendered by `MessageBubble`.
 */

/**
 * Renders the right-hand `THINKING · 12s · 3 tools · ····` status
 * line shown in the streaming-bubble header and re-used by the
 * sticky context header at the top of the chat viewport. Pure
 * presentational — every dynamic value is passed in by the caller
 * (which holds the live state).
 */
export function StreamingStatusLine({
  failed,
  queued,
  queueAhead,
  elapsedSeconds,
  toolCount,
  wirePulseCount,
  awaiting,
  thinkingLabel,
  thinkingProgress,
  thinkingDetail,
}: {
  failed: boolean;
  queued: boolean;
  queueAhead: number | undefined;
  elapsedSeconds: number | null;
  toolCount: number;
  wirePulseCount: number | undefined;
  /**
   * Turn is parked waiting on a peer gezel's reply (sync ask_gezel /
   * ask_specialist). Swaps the pulsing live dot for a static hourglass
   * so the bubble reads as passively waiting, not actively thinking.
   */
  awaiting?: boolean;
  thinkingLabel?: string | undefined;
  thinkingProgress?: number | undefined;
  thinkingDetail?: string | undefined;
}) {
  // Name both the queue and its contents: a bare "queued" can read like
  // the user's message has not been sent yet, while this state specifically
  // means the message reached Gezel and is waiting behind model work.
  const statusLabel = failed
    ? 'stopped'
    : queued
      ? queueAhead !== undefined && queueAhead > 0
        ? `model queue · position ${queueAhead + 1}`
        : 'model queue · next in line'
      : thinkingLabel && thinkingLabel.trim().length > 0
        ? thinkingLabel
        : 'thinking';
  const showProgress = !failed && !queued && typeof thinkingProgress === 'number';
  const progressPct = showProgress
    ? Math.max(0, Math.min(100, Math.round((thinkingProgress as number) * 100)))
    : 0;
  const progressTitle =
    thinkingDetail && thinkingDetail.trim().length > 0 ? thinkingDetail : statusLabel;
  const totalTokens = showProgress ? extractTotalTokenCount(thinkingDetail) : null;
  const statusPathSeparator = Math.max(statusLabel.lastIndexOf('/'), statusLabel.lastIndexOf('\\'));
  const statusPathParts =
    statusPathSeparator > 0 && statusPathSeparator < statusLabel.length - 1
      ? {
          prefix: statusLabel.slice(0, statusPathSeparator + 1),
          suffix: statusLabel.slice(statusPathSeparator + 1),
        }
      : undefined;
  return (
    <span className="msg-live-status">
      {!failed && !queued && awaiting && (
        // Static hourglass — the model is idle, parked on a peer's
        // reply. Distinct from the pulsing `msg-live-dot` so the bubble
        // reads as passively waiting rather than actively thinking.
        <svg
          className="msg-awaiting-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          role="img"
          aria-label="Waiting"
        >
          <title>Waiting</title>
          <path
            d="M3 1.5h6M3 10.5h6M3.5 1.5c0 2 5 2.5 5 4.5s-5 2.5-5 4.5M8.5 1.5c0 2-5 2.5-5 4.5s5 2.5 5 4.5"
            stroke="currentColor"
            strokeWidth="1"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {!failed && !queued && !awaiting && <span className="msg-live-dot" aria-hidden />}
      {queued && (
        <svg
          className="msg-queued-icon"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          role="img"
          aria-label="Model queue"
        >
          <title>Model queue</title>
          <circle cx="2" cy="2.5" r="0.8" fill="currentColor" />
          <circle cx="2" cy="6" r="0.8" fill="currentColor" />
          <circle cx="2" cy="9.5" r="0.8" fill="currentColor" />
          <path d="M4 2.5h6M4 6h6M4 9.5h6" stroke="currentColor" strokeLinecap="round" />
        </svg>
      )}
      {/* Wrapped in a span so the CSS container query can hide just
          the verbose label ("thinking", "Thinking it through",
          "queued — 3 ahead") on narrow chat panels — the live dot,
          progress bar, and token/tool counts on either side stay
          visible as the load-bearing signals. See `msg-live-status-label`
          rule in styles/chat.css. */}
      <span className="msg-live-status-label" title={statusLabel}>
        {statusPathParts ? (
          <>
            <span className="msg-live-status-label-prefix">{statusPathParts.prefix}</span>
            <span className="msg-live-status-label-suffix">{statusPathParts.suffix}</span>
          </>
        ) : (
          statusLabel
        )}
      </span>
      {showProgress && (
        // Radix tooltip surfaces `thinkingDetail` (e.g. "4,096 / 7,880
        // tokens · 298 tok/s") on hover. The native `title` attribute
        // technically works too, but Electron delays it ~1–2s so it
        // reads as broken; the Radix popper fires in ~200ms.
        <Tooltip.Hint text={progressTitle}>
          <span
            className="msg-live-progress"
            aria-label={progressTitle}
            role="progressbar"
            aria-valuenow={progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            tabIndex={-1}
          >
            <span className="msg-live-progress-fill" style={{ width: `${progressPct}%` }} />
          </span>
        </Tooltip.Hint>
      )}
      {showProgress && totalTokens !== null && (
        <span className="msg-live-tokens" aria-label={`${totalTokens} prompt tokens total`}>
          {COMPACT_TOKEN_FMT.format(totalTokens)}
        </span>
      )}
      {elapsedSeconds !== null && (
        // When the progress bar is rendered immediately above, the "·"
        // dot floats next to the bar with nothing on its left to anchor
        // it — drop it in that case and just lean on the bar's right
        // margin for separation. Other states (no progress bar) keep
        // the dot as the normal label-to-meta separator.
        <>
          {showProgress ? ' ' : ' · '}
          {formatElapsedClock(elapsedSeconds)}
        </>
      )}
      {toolCount > 0 && (
        <>
          {' '}
          · {toolCount} tool{toolCount === 1 ? '' : 's'}
        </>
      )}
      {!failed && !queued && wirePulseCount !== undefined && wirePulseCount > 0 && (
        <span
          className="msg-wire-pulse"
          title={`${wirePulseCount} wire pulse${wirePulseCount === 1 ? '' : 's'} since the last visible token — Ollama is alive but the model is silent`}
        >
          {' '}
          · {formatWirePulses(wirePulseCount)}
        </span>
      )}
    </span>
  );
}

function warningKey(warning: WarningValue): string {
  if (typeof warning === 'string') return warning;
  return `${warning.message}\0${warning.action?.kind ?? ''}\0${warning.action?.section ?? ''}`;
}

export function WarningBanner({ warnings }: { warnings: WarningValue[] }) {
  const unique = Array.from(
    new Map(warnings.map((warning) => [warningKey(warning), warning])).values(),
  );

  return (
    <div className="msg-warning-banner">
      {unique.map((value) => {
        const warning: InlineWarning =
          typeof value === 'string' ? { type: 'warning', message: value } : value;
        const action = warning.action;
        const settingsIndex = action ? warning.message.lastIndexOf('Settings') : -1;
        return (
          <div key={warningKey(warning)}>
            ⚠{' '}
            {action && settingsIndex >= 0 ? (
              <>
                {warning.message.slice(0, settingsIndex)}
                <button
                  type="button"
                  className="msg-warning-link"
                  onClick={() => {
                    requestSettingsSection(action.section);
                    window.dispatchEvent(
                      new CustomEvent('gezel:navigate', {
                        detail: {
                          view: 'settings',
                          section: action.section,
                        },
                      }),
                    );
                  }}
                >
                  Settings
                </button>
                {warning.message.slice(settingsIndex + 'Settings'.length)}
              </>
            ) : (
              warning.message
            )}
          </div>
        );
      })}
    </div>
  );
}

export function StreamingBubble({
  authorLabel,
  authorIcon,
  authorPoppetje,
  authorIconOverride,
  authorRole,
  authorTooltip,
  driftLabel,
  localEngine,
  segments,
  onOpenReference,
  onFocusTask,
  startedAt,
  extraClass,
  fontFamily,
  fontScale,
  error,
  errorDetail,
  errorActions,
  queueAhead,
  lastActivityAt,
  hasProgress,
  onProbeOllama,
  onReEngage,
  wirePulseCount,
  liveReasoning,
  liveToolArgs,
  thinkingLabel,
  thinkingProgress,
  thinkingDetail,
  gpuSwapTask,
  gpuSwapDetail,
  gpuSwapPrompt,
  gpuSwapProgress,
  gpuSwapStep,
  gpuSwapTotalSteps,
  gpuSwapSecondsPerStep,
  awaitingGezelName,
  warnings,
  onCancel,
  dataMsgId,
  dataSessionId,
  debugMode,
  sessionId,
  question,
  onQuestionAnswered,
}: StreamingBubbleProps) {
  // Disable the cancel button after the user clicks it — the cancel
  // request is in flight and the streaming bubble takes a moment to
  // tear down. Without this, an impatient double-click fires two
  // requests and the second logs an "already cancelled" warning.
  const [cancelling, setCancelling] = useState(false);
  const handleCancel = useCallback(async () => {
    if (!onCancel || cancelling) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      // Leave the disabled state on — the bubble is about to be
      // replaced by the (cancelled) error state. If for some reason
      // it isn't, a fresh user message will tear this component down.
    }
  }, [onCancel, cancelling]);
  // Same busy-guard pattern as cancel: the re-engage cancels the wedged
  // turn and sends a continue nudge; a double-click would cancel the
  // fresh turn it just started.
  const [reEngaging, setReEngaging] = useState(false);
  const handleReEngage = useCallback(async () => {
    if (!onReEngage || reEngaging) return;
    setReEngaging(true);
    try {
      await onReEngage();
    } finally {
      // Leave disabled — the bubble is about to be torn down and
      // replaced by the re-engaged turn's fresh streaming bubble.
    }
  }, [onReEngage, reEngaging]);
  // Derived counts for the status line. Cheap walks; the segments
  // array stays small (each tool / text-block is one entry).
  const toolCount = segments.reduce((n, s) => (s.kind === 'tool' ? n + 1 : n), 0);
  const textTotal = segments.reduce((n, s) => (s.kind === 'text' ? n + s.content.length : n), 0);
  const hasText = textTotal > 0;
  // Mid-stream tool-call detection. Verbose-family models (Qwen 3.6
  // 27B, etc.) emit Hermes-style markup as text deltas — the
  // service-side salvage layer promotes these to real tool calls
  // AFTER the iteration completes, but during the in-flight window
  // the user sees a blinking cursor with no signal that something is
  // queueing. Parse the streaming text and surface each detected
  // `<function=NAME>` block as a "queued" row so the bubble doesn't
  // look stalled. Replaced by the real ToolActivity rows once the
  // iteration ends and the actual tool fires.
  //
  // Concatenate text segments only — tool segments are already
  // shown as their own rows further down. We're scanning ONLY the
  // raw model output for markup we're about to promote.
  const streamedText = segments
    .filter((s): s is { kind: 'text'; content: string } => s.kind === 'text')
    .map((s) => s.content)
    .join('');
  // Fast-reject — only invoke the parser when the stream has at
  // least one shape's anchor character. Saves a few regex scans on
  // every render for plain-prose responses.
  const mayHaveMarkup =
    streamedText.includes('<function=') ||
    streamedText.includes('<invoke ') ||
    /<[a-z][a-z0-9_]*_/.test(streamedText) ||
    streamedText.includes('"tool"') ||
    streamedText.includes('"function"') ||
    (streamedText.includes('"name"') && streamedText.includes('"arguments"'));
  // Salvage promotes complete markup blocks to real `tool` segments in
  // markup-source order. The streamed text still carries the markup
  // afterward (we only `stripVisibleToolCallMarkup` for display), so
  // re-parsing would surface stale "queued" rows on top of the real
  // ones. `dropExecutedPending` slices the leading N completes that
  // have already fired.
  const pendingToolCalls: PendingToolCall[] = mayHaveMarkup
    ? dropExecutedPending(parsePendingToolCalls(streamedText), toolCount)
    : [];
  // Group consecutive tool segments into one `ToolActivityList`
  // render so adjacent tool entries share a single visual frame
  // (matches how the post-completion ToolHistoryExpando renders).
  //
  // NOT memoized: `segments` is the live mutable array from
  // `ChatTimelineView`'s `liveRef` slot — pushes happen in place,
  // so the array reference stays the same across re-renders.
  // `useMemo([segments])` would freeze the first computation and
  // miss every subsequent mutation, which surfaced as
  // "thinking-dots show but text never appears while streaming"
  // until the user tabbed away and back (forcing a remount).
  // The collapse loop is O(segments.length) and segments stay
  // small (one entry per text-burst or tool-group), so
  // recomputing each render is cheap.
  const renderedSegments: Array<
    | { kind: 'text'; content: string }
    | { kind: 'tools'; tools: ToolActivity[] }
    | { kind: 'intent'; label: string }
  > = [];
  for (const s of segments) {
    const tail = renderedSegments[renderedSegments.length - 1];
    if (s.kind === 'tool') {
      if (tail?.kind === 'tools') tail.tools.push(s.tool);
      else renderedSegments.push({ kind: 'tools', tools: [s.tool] });
    } else if (s.kind === 'intent') {
      if (shouldDisplayIntent(s.label)) {
        renderedSegments.push({ kind: 'intent', label: s.label });
      }
    } else if (s.content.length > 0) {
      // Skip text segments that render to nothing once tool-call
      // markup and `<think>`/channel reasoning are stripped — e.g.
      // a `<tool_call>{…}</tool_call>\n` blob between two real tool
      // firings collapses to `\n`. Without this guard each empty
      // segment still produces its own `.msg-stream-segment` div,
      // and the `+ .msg-stream-segment` dashed border-top renders
      // as a stack of "ghost" separator lines between consecutive
      // tool rows. Same strip the renderer below applies.
      const visible = promoteBareChannelNames(
        stripVisibleToolCallMarkup(s.content, { hideMidStreamOpener: true }),
      );
      if (visible.trim().length > 0) {
        renderedSegments.push({ kind: 'text', content: s.content });
      }
    }
  }
  const elapsed = useElapsedSeconds(startedAt);
  // Seconds since the last delta / tool event. Falls back to total
  // elapsed when the parent didn't supply a lastActivityAt — keeps
  // the old "show after 30s" behavior for any caller that hasn't
  // been updated.
  const silentFor = useElapsedSeconds(lastActivityAt ?? startedAt);
  // Has the turn produced ANY signal yet (a delta, a tool event)? Before
  // the first token, `silentFor` counts from turn start — so a legitimately
  // slow COLD start (a 284B DeepSeek model streaming experts from disk takes
  // ~3 min to first token) would trip the "stalled/wedged" tier even though
  // the model is prefilling, not wedged.
  // A turn can only be "wedged mid-turn" if it was mid-turn — i.e. it
  // streamed something and THEN went quiet. Until then, the reassuring
  // "still working / first load is slow" copy is the honest signal.
  const stalledSilence = isStalledSilence(silentFor, hasProgress === true);
  // Inline diagnostic state for the slow-banner's "Check Ollama"
  // button. `null` = idle (haven't probed); object = result of last
  // probe. Re-clicking the button re-probes and overwrites.
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<OllamaProbeResult | null>(null);
  const runProbe = useCallback(async () => {
    if (!onProbeOllama) return;
    setProbeBusy(true);
    try {
      setProbeResult(await onProbeOllama());
    } catch (err) {
      setProbeResult({
        ok: false,
        baseUrl: '',
        elapsedMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProbeBusy(false);
    }
  }, [onProbeOllama]);
  const failed = Boolean(error);
  const queued = queueAhead !== undefined && !hasText && !failed;
  // Parked inside a synchronous ask_gezel/ask_specialist consultation:
  // the model is idle, blocked on a peer's reply. Only honor it while
  // the turn hasn't failed — an errored turn's banner takes precedence.
  const awaiting = !failed && !!awaitingGezelName;
  const showThinkingDots =
    !failed &&
    !queued &&
    !awaiting &&
    !liveToolArgs &&
    (renderedSegments.length === 0 ||
      renderedSegments[renderedSegments.length - 1]?.kind === 'tools');
  const inlineWirePulse =
    !failed && !queued && !awaiting && wirePulseCount !== undefined && wirePulseCount > 0 ? (
      <span
        className="msg-live-inline-activity"
        title={`${wirePulseCount} wire pulse${wirePulseCount === 1 ? '' : 's'} since the last visible token — the engine is alive and generating`}
      >
        {formatWirePulses(wirePulseCount)}
      </span>
    ) : null;
  const stateCls = failed
    ? 'msg-failed'
    : queued
      ? 'msg-queued'
      : hasText
        ? 'msg-streaming'
        : 'msg-thinking';
  // `msg-awaiting` dims the whole bubble so the active specialist
  // visually dominates the column while this gezel just waits.
  const cls = `msg msg-assistant ${stateCls}${awaiting ? ' msg-awaiting' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  return (
    <div className={cls} data-msg-id={dataMsgId} data-session-id={dataSessionId}>
      <div className="msg-role" title={authorTooltip}>
        <GezelIcon
          svg={authorIcon}
          poppetje={authorPoppetje}
          iconOverride={authorIconOverride}
          name={authorLabel}
          size={20}
        />
        <span>{authorLabel}</span>
        <RoleSuffix role={authorRole} />
        {driftLabel && <span className="msg-role-drift">{driftLabel}</span>}
        <StreamingStatusLine
          failed={failed}
          queued={queued}
          queueAhead={queueAhead}
          elapsedSeconds={elapsed}
          toolCount={toolCount}
          wirePulseCount={awaiting ? 0 : wirePulseCount}
          awaiting={awaiting}
          thinkingLabel={
            awaiting
              ? `Waiting on ${awaitingGezelName}`
              : gpuSwapTask
                ? formatImageGenLabel(gpuSwapStep, gpuSwapTotalSteps, gpuSwapTask, gpuSwapDetail)
                : thinkingLabel
          }
          thinkingProgress={awaiting ? undefined : gpuSwapTask ? gpuSwapProgress : thinkingProgress}
          thinkingDetail={
            awaiting
              ? undefined
              : gpuSwapTask
                ? formatImageGenProgressDetail({
                    step: gpuSwapStep,
                    totalSteps: gpuSwapTotalSteps,
                    secondsPerStep: gpuSwapSecondsPerStep,
                    fallback: gpuSwapDetail,
                  })
                : thinkingDetail
          }
        />
        {/* Persistent cancel — visible for the entire live turn (not
            just during thinking-dot phases). Suppressed for failed and
            queued turns: failed has nothing to cancel, queued has its
            own cancel affordance via the GhostQueuedBubble below. */}
        {onCancel && !failed && !queued && (
          <button
            type="button"
            className="msg-role-cancel"
            onClick={handleCancel}
            disabled={cancelling}
            title={cancelling ? 'Cancelling…' : 'Cancel this turn'}
            aria-label="Cancel this turn"
          >
            {/* Geometric SVG cross rather than a "×" glyph — the text glyph
                sits on the font's math axis and reads as slightly high/off
                inside the circle; this is perfectly centered. */}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M6 6 L18 18 M18 6 L6 18"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        )}
      </div>
      <div className="msg-body msg-body-rendered" style={bubbleBodyStyle(fontFamily, fontScale)}>
        {/* Body branches:
              - `queued` with no segments yet → render the queued
                pill alone. Distinct visual treatment for "the
                model hasn't been given a slot."
              - Otherwise → render the segments in arrival order
                (prose · tool · prose · tool …). Adjacent tool
                segments collapse into one `ToolActivityList`
                frame so consecutive tools group visually.
              - If we're between segments (no text yet OR last
                segment was a tool), append thinking-dots so the
                bubble doesn't look idle while we wait for the
                next chunk. Suppressed for failed turns. */}
        {queued && renderedSegments.length === 0 ? (
          <output
            className="queued-pill"
            aria-live="polite"
            aria-label={
              queueAhead && queueAhead > 0
                ? `Waiting in the model queue, position ${queueAhead + 1} in line, ${queueAhead} prompt${queueAhead === 1 ? '' : 's'} ahead`
                : 'Waiting in the model queue, next in line'
            }
          >
            <QueuePositionVisual ahead={queueAhead ?? 0} />
            <span className="queued-pill-copy">
              <span className="queued-pill-label">
                {queueAhead && queueAhead > 0
                  ? `Position ${queueAhead + 1} in line`
                  : 'Next in line'}
              </span>
              <span className="queued-pill-detail">
                {queueAhead && queueAhead > 0
                  ? `${queueAhead} prompt${queueAhead === 1 ? '' : 's'} ahead`
                  : 'Waiting for a model slot'}
              </span>
            </span>
          </output>
        ) : (
          <>
            {!failed && liveReasoning && liveReasoning.trim().length > 0 && (
              // Live think-phase stream (ds4). A dimmed block above the
              // reply that grows token-by-token while the model reasons,
              // then vanishes on commit — the persisted message re-renders
              // the same trace behind the collapsed "Thinking" expander.
              <LiveReasoning text={liveReasoning} />
            )}
            {renderedSegments.map((seg, i) => {
              // Stable-ish key using kind + first tool-name (or
              // text-prefix). Index-only would re-mount nodes when
              // the tool/text alternation pattern shifts. Adjacent
              // collisions are extremely unlikely in practice.
              const key =
                seg.kind === 'tools'
                  ? `tools-${i}-${seg.tools[0]?.name ?? ''}`
                  : seg.kind === 'intent'
                    ? `intent-${i}-${seg.label}`
                    : `text-${i}-${seg.content.length}`;
              // Wrap each segment so CSS can space subsequent
              // segments apart from the previous one — gives
              // visible paragraph breaks when a long thinking
              // pause splits the model's output into bursts.
              return (
                <div className="msg-stream-segment" key={key}>
                  {seg.kind === 'tools' ? (
                    <ToolActivityList
                      tools={seg.tools}
                      onOpenReference={onOpenReference}
                      onFocusTask={onFocusTask}
                    />
                  ) : seg.kind === 'intent' ? (
                    <IntentDivider label={seg.label} />
                  ) : (
                    // Same display-only tool-call markup scrub the
                    // persisted MessageBubble runs (see
                    // strip-tool-call-markup.ts), with
                    // `hideMidStreamOpener: true` so an in-progress
                    // `<tool_call>` opener doesn't grow visibly
                    // token-by-token before the close arrives.
                    //
                    // ALSO promote bare channel-name leaks to mode
                    // indicators (`thought\n` → `_Thinking…_`) so the
                    // user never sees the raw lowercase word in the
                    // streaming bubble. Same transform the persisted
                    // bubble runs at commit time via
                    // `reasoning.strip-channel-tags`; doing it here too
                    // keeps the streaming view in sync with the final
                    // committed view, instead of bleeding the leaked
                    // word for the entire turn duration.
                    <RenderedMarkdown
                      markdown={promoteBareChannelNames(
                        stripVisibleToolCallMarkup(seg.content, {
                          hideMidStreamOpener: true,
                        }),
                      )}
                      fontFamily={fontFamily}
                    />
                  )}
                </div>
              );
            })}
            {!failed && !queued && pendingToolCalls.length > 0 && (
              <PendingToolCallsList tools={pendingToolCalls} />
            )}
            {!failed && !queued && liveToolArgs && (
              // The model is streaming a structured tool call — show
              // what it's generating (tool verb + target + ticking char
              // count + live tail) right where the user is watching the
              // caret. Replaced by the real tool row when the call fires.
              <LiveToolArgs args={liveToolArgs} />
            )}
            {!failed && !queued && gpuSwapTask === 'image_generation' && gpuSwapPrompt && (
              // Show the prompt the model passed to `generate_image`
              // while sd-server is doing the work. Without this the
              // bubble would just show "Generating image" with a
              // ticker for two minutes and no clue *what* is being
              // generated. Multi-line, italic, slightly muted —
              // visually distinct from the model's own prose.
              <div className="msg-image-gen-narrative" aria-live="polite">
                <span className="msg-image-gen-narrative-label">Prompt:</span>
                <span className="msg-image-gen-narrative-prompt">{gpuSwapPrompt}</span>
              </div>
            )}
            {showThinkingDots && (
              <div className="msg-thinking-activity">
                {/* Suppressed while `awaiting`: the model is idle on a
                    peer's reply, so pulsing "thinking" dots would be a
                    lie — the dimmed bubble + "Waiting on <name>" status
                    carry the signal instead. Also suppressed while the
                    live tool-args block is up: that block IS the activity
                    signal, and dots under it would read as a second,
                    contradictory "waiting" state. */}
                <div className="thinking-dots" aria-label="Thinking…">
                  <span />
                  <span />
                  <span />
                </div>
                {inlineWirePulse}
              </div>
            )}
            {/* When visible text or tool arguments replace the thinking
                dots, keep the activity count at the live edge of the body. */}
            {!showThinkingDots && inlineWirePulse}
          </>
        )}
        {!failed && warnings && warnings.length > 0 && (
          // Provider-side warnings (Copilot rate-limits, degraded
          // mode, context pressure). Rendered unconditionally — unlike
          // the silence banner these signal something the user should
          // see immediately, not a "might be slow" reassurance.
          // Dedup so a chatty provider doesn't pile duplicate lines.
          <WarningBanner warnings={warnings} />
        )}
        {!failed &&
          !queued &&
          !gpuSwapTask &&
          !awaiting &&
          silentFor !== null &&
          silentFor >= SILENCE_BANNER_AFTER_S && (
            // Gate on **silent time**, not total elapsed. A turn that's
            // been actively firing tool calls doesn't need a "slow
            // local models" reassurance — the tool entries ARE the
            // progress signal. We only want this banner when the
            // gezel has gone genuinely quiet for a stretch (no deltas,
            // no tool events in the last 30s). Also suppressed for
            // `queued` — the model isn't running yet, so "silent" and
            // "slow" don't apply; the queued-pill above already tells
            // the user what's happening — and for `gpuSwapTask`, since
            // the silence is from another engine holding the GPU
            // rather than from the chat model itself stalling. The
            // status line's "Generating image…" label is the right
            // signal in that window; the slow-banner copy would be
            // doubly wrong (silent ≠ slow ≠ contended).
            <div className="msg-slow-banner">
              <div>
                {stalledSilence ? (
                  <>
                    This turn looks stalled — no signal for {formatElapsedLong(silentFor)}. The
                    model may have wedged mid-turn; you can stop it and ask it to pick up where it
                    left off.
                  </>
                ) : (
                  <>
                    Still working — silent for {formatElapsedLong(silentFor)}.
                    {localEngine === 'llama-cpp'
                      ? ' First model load is slow; subsequent turns are much faster. On-device models also take a while on long reasoning or large tool outputs.'
                      : localEngine === 'ds4'
                        ? ' DwarfStar streams a very large model from disk — reading a long conversation can take a few minutes before the reply starts.'
                        : onProbeOllama
                          ? ' Slow local models can take a few minutes, especially for the first message, or when deep thinking is needed.'
                          : ' Long reasoning chains or large tool outputs can take a while; the turn is still running.'}
                  </>
                )}
              </div>
              {stalledSilence && onReEngage && (
                <div className="msg-slow-banner-probe">
                  <button
                    type="button"
                    className="msg-slow-banner-probe-btn"
                    onClick={handleReEngage}
                    disabled={reEngaging}
                  >
                    {reEngaging ? 'Re-engaging…' : 'Stop and re-engage'}
                  </button>
                </div>
              )}
              {onProbeOllama && (
                <div className="msg-slow-banner-probe">
                  <button
                    type="button"
                    className="msg-slow-banner-probe-btn"
                    onClick={runProbe}
                    disabled={probeBusy}
                  >
                    {probeBusy ? 'Checking…' : probeResult ? 'Re-check Ollama' : 'Check Ollama'}
                  </button>
                  {probeResult && (
                    <span className="msg-slow-banner-probe-result">
                      {probeResult.ok ? (
                        probeResult.loaded.length === 0 ? (
                          <>
                            Ollama responsive in {probeResult.elapsedMs}ms — but{' '}
                            <strong>no models loaded</strong>. Likely evicted mid-turn.
                          </>
                        ) : (
                          <>
                            Ollama responsive in {probeResult.elapsedMs}ms — loaded:{' '}
                            {probeResult.loaded
                              .map((m) => `${m.name} (${formatVramSize(m.sizeVram)})`)
                              .join(', ')}
                            . Model is alive; the silence is on the generation side (likely silent
                            reasoning or GPU pressure).
                          </>
                        )
                      ) : (
                        <>
                          <strong>Ollama unhealthy:</strong> {probeResult.error} (probe took{' '}
                          {probeResult.elapsedMs}ms)
                        </>
                      )}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        {failed && (
          <div className="msg-failed-banner">
            <div>✗ Turn stopped before finishing. {error}</div>
            {errorActions ??
              (!isUserCancelledTurnError(error) && (
                <ReportErrorLink
                  report={{ surface: 'chat-turn', message: error ?? '', detail: errorDetail }}
                />
              ))}
          </div>
        )}
      </div>
      {question && <PendingQuestionCard question={question} onAnswered={onQuestionAnswered} />}
      {/* Gutter toolbar — copy markdown (always) + copy debug bundle
          (when debugMode + sessionId are set). Same component the
          persisted MessageBubble uses; the body it copies is the
          concatenated text segments emitted so far, which on a
          stopped turn matches what the user is staring at. The
          debug bundle fetch reads the live session state; no
          messageAt because we want "what would the model see right
          now," not a slice into history.

          Apply `stripVisibleToolCallMarkup` so the copied markdown
          AND the debug bundle's "Response under investigation"
          section reflect the cleaned view the user is looking at,
          not the raw model output. Without this scrub the bundle
          shows `<|channel>thought ... <channel|>` shells that the
          server-side salvage already strips at commit time —
          confusing for a debug pass aimed at "why does this look
          weird in my bubble?". */}
      <MessageActions
        markdown={stripVisibleToolCallMarkup(
          renderedSegments
            .filter((s): s is { kind: 'text'; content: string } => s.kind === 'text')
            .map((s) => s.content)
            .join(''),
        )}
        side="right"
        {...(debugMode && sessionId ? { debug: { sessionId } } : {})}
      />
    </div>
  );
}

/**
 * Compact line diagram for a queued prompt. The numbered square is this
 * prompt's exact position; the dots between it and the arrow are the work
 * ahead. Cap the drawn dots so a busy queue stays compact while the number
 * and adjacent copy continue to carry the exact position.
 */
function QueuePositionVisual({ ahead }: { ahead: number }) {
  const visibleAhead = Math.min(ahead, 3);
  return (
    <span className="queue-position-visual" aria-hidden="true">
      <span className="queue-position-you">{ahead + 1}</span>
      {ahead > 3 && <span className="queue-position-overflow">…</span>}
      {Array.from({ length: visibleAhead }, (_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative queue slots
        <span className="queue-position-ahead" key={index} />
      ))}
      <svg className="queue-position-arrow" width="9" height="10" viewBox="0 0 9 10" fill="none">
        <title>Queue direction</title>
        <path d="M1 5h6M5 2.5 7.5 5 5 7.5" stroke="currentColor" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface GhostQueuedBubbleProps {
  sessionId: string;
  queueId: string;
  preview: string;
  enqueuedAt: string;
  /** Resolves pasted attachment refs while the message is still waiting. */
  mediaProvider?: MediaProvider | null;
  /** Queued as a mid-turn nudge — the label reads "nudge" instead of "queued". */
  nudge?: boolean;
  /** Drop this queued message from the session's queue without running it. */
  onDiscard: () => void | Promise<void>;
  /** Cancel the session's currently-running turn so this one runs sooner. */
  onCancelCurrent: () => void | Promise<void>;
  /**
   * Fetch the entry's FULL text for inline rendering and editing (the event
   * preview is truncated at 160 chars). Resolve `null` when the entry is
   * gone — already started or discarded — in which case edit mode never
   * opens (the `queue_removed` event clears this bubble moments later).
   */
  onLoadText?: () => Promise<string | null>;
  /**
   * Persist an edit. Resolve `true` on success, `false` when the entry
   * vanished mid-edit (the moment passed — edit mode exits silently).
   * Reject for real failures, surfaced as an inline error.
   */
  onSaveEdit?: (text: string) => Promise<boolean>;
  extraClass?: string;
}

/**
 * Ghost bubble shown for a message that's waiting in the per-session
 * queue. Rendered under the session's streaming bubble in the
 * timeline, dimmed to signal "this hasn't been sent to the model
 * yet." Actions: edit it in place, drop it, or cancel the current
 * turn so the queue drains faster.
 */
export function GhostQueuedBubble({
  preview,
  enqueuedAt,
  nudge,
  mediaProvider,
  onDiscard,
  onCancelCurrent,
  onLoadText,
  onSaveEdit,
  extraClass,
}: GhostQueuedBubbleProps) {
  const waited = useWaitedSeconds(enqueuedAt);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [displayText, setDisplayText] = useState(preview);
  const loadTextRef = useRef(onLoadText);
  const editable = onLoadText !== undefined && onSaveEdit !== undefined;

  useEffect(() => {
    loadTextRef.current = onLoadText;
  }, [onLoadText]);

  // Queue SSE events intentionally carry only a 160-character preview.
  // Load the complete body once so an attachment whose markdown ref falls
  // after that boundary (or is cut by it) still renders as an image. Keep
  // the preview as the immediate fallback while that small request runs.
  useEffect(() => {
    let cancelled = false;
    setDisplayText(preview);
    const loadText = loadTextRef.current;
    if (!loadText) return;
    void loadText().then(
      (text) => {
        if (!cancelled && text !== null) setDisplayText(text);
      },
      () => {
        // The queue entry may have started between the SSE event and this
        // read. Its ghost bubble will disappear on queue_removed; until then
        // the event preview remains the safest display value.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [preview]);

  const beginEdit = async () => {
    if (!onLoadText) return;
    setEditError(null);
    const text = await onLoadText().catch(() => null);
    if (text === null) return;
    setEditDraft(text);
    setEditing(true);
  };

  const saveEdit = async () => {
    if (!onSaveEdit) return;
    const text = editDraft.trim();
    if (!text) return;
    setSaving(true);
    setEditError(null);
    try {
      await onSaveEdit(text);
      // `false` means the entry vanished mid-edit — the bubble is about
      // to disappear via `queue_removed`, so exit either way.
      setEditing(false);
    } catch (err) {
      setEditError((err as Error).message ?? String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={`msg msg-user msg-ghost-queued${extraClass ? ` ${extraClass}` : ''}`}>
      <div className="msg-role">
        <span className="msg-ghost-queued-label">{nudge ? '⋯ nudge' : '⋯ queued'}</span>
        {waited !== null && <span className="muted small"> · {formatElapsedClock(waited)}</span>}
      </div>
      {editing ? (
        <div className="msg-ghost-queued-edit">
          <textarea
            className="msg-ghost-queued-editor"
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            disabled={saving}
            // biome-ignore lint/a11y/noAutofocus: the user just clicked Edit — focus follows their intent.
            autoFocus
          />
          {editError && <div className="msg-ghost-queued-edit-error">{editError}</div>}
        </div>
      ) : (
        <div className="msg-body msg-body-rendered">
          <RenderedMarkdown markdown={displayText} mediaProvider={mediaProvider} />
        </div>
      )}
      <div className="msg-ghost-queued-actions">
        {editing ? (
          <>
            <button
              type="button"
              className="msg-ghost-queued-btn"
              onClick={() => void saveEdit()}
              disabled={saving || editDraft.trim().length === 0}
              title="Save the edited message — it stays at its place in the queue."
            >
              Save
            </button>
            <button
              type="button"
              className="msg-ghost-queued-btn"
              onClick={() => setEditing(false)}
              disabled={saving}
              title="Discard the edit and keep the original text."
            >
              Cancel
            </button>
          </>
        ) : (
          <>
            {editable && (
              <button
                type="button"
                className="msg-ghost-queued-btn"
                onClick={() => void beginEdit()}
                title="Edit this message before it's sent."
              >
                Edit
              </button>
            )}
            <button
              type="button"
              className="msg-ghost-queued-btn"
              onClick={() => void onDiscard()}
              title="Remove this message from the queue — it won't be sent."
            >
              Discard
            </button>
            <button
              type="button"
              className="msg-ghost-queued-btn"
              onClick={() => void onCancelCurrent()}
              title="Stop the current turn so this queued message runs sooner."
            >
              Cancel current turn
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Live-updating "waiting N seconds" counter. Counterpart to
 * {@link useElapsedSeconds} but takes an ISO timestamp — the service
 * publishes `enqueuedAt` as ISO, so we don't need to track start-
 * wall-clock ourselves.
 */
function useWaitedSeconds(enqueuedAtIso: string): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(interval);
  }, []);
  const parsed = Date.parse(enqueuedAtIso);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

/**
 * Shared renderer for a list of tool invocations. Used both by the live
 * streaming bubble (while tools run) and by the post-stream collapsible
 * "tools that ran" expando on completed messages. Centralizes the
 * humanized name + args preview + duration formatting so the two
 * surfaces don't drift.
 */
/**
 * Mid-stream "queued tool calls" list. Shown in the streaming bubble
 * when the model has emitted Hermes-style `<function=NAME>` markup
 * that the salvage layer hasn't yet promoted (salvage runs at the
 * end of each iteration, not mid-stream — there's a 5-30s gap on
 * verbose-family local models where the user otherwise sees only a
 * blinking cursor). Each row gets a spinner glyph + the tool name
 * + a normalized arg preview, so the user knows what's about to
 * fire instead of staring at a blank cursor. Replaced by real
 * `ToolActivityList` rows once the iteration ends.
 */
function PendingToolCallsList({ tools }: { tools: PendingToolCall[] }) {
  return (
    <ul className="thinking-tools thinking-tools-pending" aria-label="Tool calls queueing up">
      {tools.map((t, i) => {
        const preview = formatPendingArgsPreview(t.params);
        return (
          <li
            key={`pending-${i}-${t.name}`}
            className={`thinking-tool thinking-tool-pending${t.complete ? ' thinking-tool-pending-ready' : ''}`}
            title={
              t.complete ? 'Queued — will run when the model finishes this turn' : 'Streaming…'
            }
          >
            <span className="thinking-tool-row">
              <span className="thinking-tool-icon thinking-tool-spinner" aria-hidden>
                <svg viewBox="0 0 16 16" fill="none" focusable="false" aria-hidden="true">
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeDasharray="28"
                    strokeDashoffset="9"
                  />
                </svg>
              </span>
              <span className="thinking-tool-name">{toolDisplayName(t.name)}</span>
              {preview && <span className="thinking-tool-args">{preview}</span>}
              <span className="thinking-tool-duration muted small">
                {t.complete ? 'queued' : 'streaming…'}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sub-2s tool calls are fast enough that their elapsed time is noise — a
 * "442ms" / "84ms" tag on every row clutters the list without telling the
 * user anything actionable. Only surface a per-row duration once it
 * crosses this threshold (slow enough to be worth noticing).
 */
const TOOL_DURATION_VISIBLE_MS = 2000;

/** Silent seconds before the reassurance ("still working") banner shows. */
const SILENCE_BANNER_AFTER_S = 30;
/**
 * Silent seconds before the banner escalates to the stalled tier (copy
 * shifts to "looks stalled" + the Stop-and-re-engage action). UI-side
 * threshold for now; a server-side stall signal can replace it later.
 */
const STALLED_AFTER_S = 120;

/** The stalled tier is valid only after this turn has made observable progress. */
export function isStalledSilence(silentFor: number | null, hasProgress: boolean): boolean {
  return silentFor !== null && silentFor >= STALLED_AFTER_S && hasProgress;
}

/** Gap between the "details" toggle and its floating hover preview. */
const TOOL_PREVIEW_GAP_PX = 6;

/**
 * The hover peek for a tool call's "details" toggle.
 *
 * Portaled to `document.body` and positioned in VIEWPORT coordinates
 * rather than rendered next to the toggle. An absolutely-positioned
 * preview still counts toward the scroll container's overflow, so
 * showing it grew the chat timeline's `scrollHeight` — which the
 * stick-to-bottom effect in ChatTimelineView reads as "content grew"
 * and answers by scrolling to the bottom. That yanked the toggle out
 * from under the cursor, mouse-out hid the preview, the height shrank
 * back, and the pointer landed on the toggle again: a hover/scroll
 * feedback loop that flickered several times a second. Out of the
 * scrolling subtree, the preview cannot move the content it describes.
 */
function ToolDetailPreview({
  anchorRef,
  text,
}: {
  anchorRef: RefObject<HTMLButtonElement | null>;
  text: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Layout effect: measure and place before paint, so the first frame
  // the user sees is already at the anchor (no top-left flash).
  useLayoutEffect(() => {
    const place = () => {
      const anchor = anchorRef.current;
      const el = ref.current;
      if (!anchor || !el) return;
      const a = anchor.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const below = window.innerHeight - a.bottom - TOOL_PREVIEW_GAP_PX;
      const above = a.top - TOOL_PREVIEW_GAP_PX;
      // Prefer below the toggle; flip above only when the panel doesn't
      // fit below AND there is more room up there (the common case for
      // a tool call sitting near the bottom of the timeline).
      const top =
        box.height <= below || below >= above
          ? a.bottom + TOOL_PREVIEW_GAP_PX
          : Math.max(4, a.top - TOOL_PREVIEW_GAP_PX - box.height);
      const left = Math.max(4, Math.min(a.left, window.innerWidth - box.width - 4));
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    };
    place();
    // Capture phase: the anchor moves when its own scroll container
    // scrolls, which never bubbles to window.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    // Re-place when the panel itself resizes (a streaming tool result
    // can grow the preview under the cursor), which also covers the
    // flip decision changing as the height crosses the space below.
    const ro =
      typeof ResizeObserver === 'undefined' || !ref.current ? null : new ResizeObserver(place);
    ro?.observe(ref.current as Element);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      ro?.disconnect();
    };
  }, [anchorRef]);

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      ref={ref}
      className="thinking-tool-detail-preview"
      role="tooltip"
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: 0, visibility: 'hidden' }}
    >
      <pre>{text}</pre>
    </div>,
    document.body,
  );
}

/**
 * Per-tool-call "details" disclosure: the full, untruncated arguments
 * (what `argsSummary` abbreviates) plus the returned response when the
 * provider exposes it. Long responses arrive as bounded summaries.
 * Click-to-expand rather than a hover tooltip on purpose — you can't put
 * a working copy button inside something that vanishes on mouse-out, and
 * the whole point here is to grab the exact handoff/edit content (e.g.
 * verify a `message_gezel` actually carried the file body).
 */
function ToolDetailsBlock({
  argsFull,
  resultText,
  resultTruncated = false,
}: {
  argsFull?: string;
  resultText?: string;
  resultTruncated?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const copy = async () => {
    try {
      const sections = [
        ...(argsFull ? [`Request\n${argsFull}`] : []),
        ...(resultText
          ? [`${resultTruncated ? 'Response summary' : 'Response'}\n${resultText}`]
          : []),
      ];
      await navigator.clipboard.writeText(sections.join('\n\n'));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (no focus / permissions) — leave the label as-is
    }
  };
  // Hover preview: a quick peek at the top of the blob without committing
  // to the full expand. Capped so a 100 KB handoff doesn't paint a giant
  // floating panel; click "details" for the whole thing + copy.
  const previewSource = [
    ...(argsFull ? [`Request\n${argsFull}`] : []),
    ...(resultText ? [`${resultTruncated ? 'Response summary' : 'Response'}\n${resultText}`] : []),
  ].join('\n\n');
  const preview = previewSource.length > 700 ? `${previewSource.slice(0, 700)}\n…` : previewSource;
  return (
    <div className="thinking-tool-detail">
      <button
        ref={toggleRef}
        type="button"
        className="thinking-tool-detail-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        {open ? 'hide details' : 'details'}
      </button>
      {hovered && !open && preview.length > 0 && (
        <ToolDetailPreview anchorRef={toggleRef} text={preview} />
      )}
      {open && (
        <div className="thinking-tool-detail-body">
          <button type="button" className="thinking-tool-detail-copy" onClick={copy}>
            {copied ? 'Copied ✓' : 'Copy'}
          </button>
          {argsFull && (
            <section className="thinking-tool-detail-section">
              <div className="thinking-tool-detail-label">Request</div>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this overflow viewport must be keyboard-scrollable. */}
              <pre tabIndex={0}>{argsFull}</pre>
            </section>
          )}
          {resultText && (
            <section className="thinking-tool-detail-section">
              <div className="thinking-tool-detail-label">
                {resultTruncated ? 'Response summary' : 'Response'}
              </div>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: this overflow viewport must be keyboard-scrollable. */}
              <pre tabIndex={0}>{resultText}</pre>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function ToolActivityList({
  tools,
  suppressMedia = false,
  suppressCards = false,
  onOpenReference,
  onFocusTask,
}: {
  tools: ToolActivity[];
  /** Skip inline image/video rows — used when a parent renders them in a
   *  visible strip above the (collapsed) step list to avoid duplication. */
  suppressMedia?: boolean;
  /** Same contract for rich inline cards — the expando promotes them above the collapse. */
  suppressCards?: boolean;
  onOpenReference?: (reference: OpenChatReference) => void;
  /** Opens a task beside the chat (rail Task pane) from an inline card. */
  onFocusTask?: (ref: string) => void;
}) {
  return (
    <ul className="thinking-tools">
      {tools.map((t, i) => (
        <li
          key={`${t.name}-${i}`}
          className={`thinking-tool${t.success ? '' : ' thinking-tool-failed'}`}
          title={t.errorMessage}
        >
          <span className="thinking-tool-row">
            <span className="thinking-tool-icon">{t.success ? '✓' : '✗'}</span>
            <span className="thinking-tool-name">{toolDisplayName(t.name)}</span>
            <ToolArgsSummary tool={t} onOpenReference={onOpenReference} />
            {t.durationMs >= TOOL_DURATION_VISIBLE_MS && (
              <span className="thinking-tool-duration">{formatDurationShort(t.durationMs)}</span>
            )}
          </span>
          {!t.success && t.errorMessage && (
            <div className="thinking-tool-error">{toolErrorSummary(t.errorMessage)}</div>
          )}
          {!suppressCards && t.card && (
            <ToolCraftbookCard card={t.card} onFocusTask={onFocusTask} />
          )}
          {!suppressMedia &&
            (t.videos && t.videos.length > 0 && t.projectId ? (
              // A generated video supersedes its poster: render only the
              // player (the poster also rides in `images` for vision models,
              // but a duplicate thumbnail under the player is just noise).
              <ToolVideoRow projectId={t.projectId} videos={t.videos} />
            ) : (
              t.images &&
              t.images.length > 0 &&
              t.projectId && <ToolImageRow projectId={t.projectId} images={t.images} />
            ))}
          {t.audios && t.audios.length > 0 && t.projectId && (
            <ToolAudioRow projectId={t.projectId} audios={t.audios} />
          )}
          {t.diff && (
            <ToolDiffBlock
              diff={t.diff}
              {...(t.addedLines !== undefined ? { addedLines: t.addedLines } : {})}
              {...(t.removedLines !== undefined ? { removedLines: t.removedLines } : {})}
            />
          )}
          {(t.argsFull || t.resultText) && (
            <ToolDetailsBlock
              {...(t.argsFull ? { argsFull: t.argsFull } : {})}
              {...(t.resultText ? { resultText: t.resultText } : {})}
              {...(t.resultTruncated ? { resultTruncated: true } : {})}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Inline playback rows for audio artifacts a tool returned
 * (synthesize_speech narrations). Renders one AudioPlayer per audio,
 * stacked. Each player loads its blob via the authenticated API
 * client — same auth fence as ToolImageRow.
 */
function ToolAudioRow({
  projectId,
  audios,
}: {
  projectId: string;
  audios: ToolCallAudio[];
}) {
  return (
    <ul className="thinking-tool-audios">
      {audios.map((a, i) => (
        <li key={`${a.path}-${i}`} className="thinking-tool-audio-cell">
          <AudioPlayer
            projectId={projectId}
            path={a.path}
            {...(a.durationSeconds !== undefined ? { durationSeconds: a.durationSeconds } : {})}
            {...(a.voice ? { voice: a.voice } : {})}
          />
        </li>
      ))}
    </ul>
  );
}

/**
 * Thumbnails for image artifacts a tool returned (Playwright screenshots
 * etc.). Each thumbnail loads its blob via the authenticated API client
 * (an `<img src="/api/...">` URL would fail because it can't carry a
 * bearer token) and opens a full-screen ImagePreview on click. Lives
 * inside the `<li>` so its margin-left aligns with the tool row's text.
 */
function ToolImageRow({ projectId, images }: { projectId: string; images: ToolCallImage[] }) {
  const [previewIdx, setPreviewIdx] = useState<number | null>(null);
  // Streaming turns re-render this row whenever new text/tool events land.
  // Keep the callback stable so ToolImagePreviewLoader does not treat an
  // unrelated parent update as a new load, revoke the live blob URL, and
  // leave the dialog's image pointing at that revoked URL while it refetches.
  const closePreview = useCallback(() => setPreviewIdx(null), []);
  return (
    <>
      <ul className="thinking-tool-images">
        {images.map((img, i) => (
          <li key={`${img.path}-${i}`} className="thinking-tool-image-cell">
            <button
              type="button"
              className="thinking-tool-image"
              onClick={() => setPreviewIdx(i)}
              title={img.path}
              aria-label={`Open screenshot ${i + 1}`}
            >
              <ToolImageThumbnail projectId={projectId} path={img.path} />
            </button>
            <ImageActionsMenu projectId={projectId} path={img.path} />
          </li>
        ))}
      </ul>
      {previewIdx !== null && images[previewIdx] && (
        <ToolImagePreviewLoader
          projectId={projectId}
          image={images[previewIdx]}
          onClose={closePreview}
        />
      )}
    </>
  );
}

/**
 * Inline `<video>` player(s) under a tool row — the video sibling of
 * {@link ToolImageRow}. Used by `generate_video`: the mp4 is an artifact
 * (never base64 in the transcript), streamed from the artifact-blob
 * endpoint. Same auth fence as images — the blob is fetched with the
 * bearer token and handed to the element as an object URL.
 */
function ToolVideoRow({ projectId, videos }: { projectId: string; videos: ToolCallVideo[] }) {
  return (
    <ul className="thinking-tool-videos">
      {videos.map((vid, i) => (
        <li key={`${vid.path}-${i}`} className="thinking-tool-video-cell">
          <ToolVideoPlayer projectId={projectId} video={vid} />
        </li>
      ))}
    </ul>
  );
}

function ToolVideoPlayer({ projectId, video }: { projectId: string; video: ToolCallVideo }) {
  const [src, setSrc] = useState<string | null>(null);
  const [posterSrc, setPosterSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let revoked = false;
    const urls: string[] = [];
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, video.path);
        if (revoked) return;
        const url = URL.createObjectURL(blob);
        urls.push(url);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-video] load failed', { path: video.path, err });
        if (!revoked) setFailed(true);
      }
      if (video.posterPath) {
        try {
          const poster = await api.fetchProjectArtifactBlob(projectId, video.posterPath);
          if (revoked) return;
          const purl = URL.createObjectURL(poster);
          urls.push(purl);
          setPosterSrc(purl);
        } catch {
          /* poster is optional */
        }
      }
    })();
    return () => {
      revoked = true;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, [projectId, video.path, video.posterPath]);
  if (failed) {
    return <span className="thinking-tool-video-error">Couldn't load video ({video.path})</span>;
  }
  if (!src) return <span className="thinking-tool-video-loading" aria-hidden />;
  return (
    <video
      className="thinking-tool-video"
      src={src}
      {...(posterSrc ? { poster: posterSrc } : {})}
      controls
      preload="metadata"
      playsInline
    />
  );
}

/**
 * Trigger downloading an artifact image via a synthetic `<a download>`
 * click. The artifact tree is bearer-token-gated, so we can't just put
 * the URL on the link directly — fetch the blob through the
 * authenticated client first and serve it via a one-shot
 * `URL.createObjectURL` reference. The object URL is revoked on a
 * short delay so the browser has time to start the download before
 * the source goes away (revoking synchronously cancels the download
 * on Chromium-based engines).
 */
async function downloadProjectArtifact(projectId: string, path: string): Promise<void> {
  const blob = await api.fetchProjectArtifactBlob(projectId, path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Pull the trailing filename out of the path so the user gets
  // `image-2026-…-42.png` rather than `generated_image-2026-…-42.png`
  // or some browser-default name.
  a.download = path.split(/[/\\]/).pop() ?? 'image';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Three-dot menu pinned to the corner of an image thumbnail. Hidden
 * until hover or until the menu opens — same pattern as the cancel
 * button on a streaming bubble. Today the menu offers Download and
 * Copy path; future entries (regenerate, send to gezel, etc.) plug
 * in here without touching the thumbnail layout.
 */
function ImageActionsMenu({ projectId, path }: { projectId: string; path: string }) {
  const [open, setOpen] = useState(false);
  const handleDownload = async () => {
    try {
      await downloadProjectArtifact(projectId, path);
    } catch (err) {
      console.warn('[tool-image] download failed', { path, err });
    }
  };
  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(`artifacts/${path.replace(/^artifacts\//, '')}`);
    } catch (err) {
      console.warn('[tool-image] copy path failed', { path, err });
    }
  };
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className={`thinking-tool-image-menu-btn${open ? ' open' : ''}`}
          aria-label="Image actions"
          title="More"
          onClick={(e) => e.stopPropagation()}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Image actions"
          >
            <title>Image actions</title>
            <circle cx="3" cy="8" r="1.4" />
            <circle cx="8" cy="8" r="1.4" />
            <circle cx="13" cy="8" r="1.4" />
          </svg>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
          <DropdownMenu.Item
            className="app-nav-menu-item"
            onSelect={() => {
              void handleDownload();
            }}
          >
            <span>Download</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className="app-nav-menu-item"
            onSelect={() => {
              void handleCopyPath();
            }}
          >
            <span>Copy artifact path</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/**
 * Per-thumbnail image loader. Fetches the artifact blob via the
 * authenticated client, renders an `<img>` against a `blob:` URL.
 * Revokes the URL on unmount so we don't leak per-render.
 */
function ToolImageThumbnail({ projectId, path }: { projectId: string; path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, path);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-image] thumbnail load failed', { path, err });
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);
  if (!src) return <span className="thinking-tool-image-loading" aria-hidden />;
  return <img src={src} alt="" />;
}

/**
 * Loads the full-resolution blob for the preview overlay. Separate from
 * the thumbnail loader so the modal opens instantly with whatever's in
 * the cache (the same path is fetched again — browser cache short-
 * circuits the second request) and the user can re-click the X without
 * re-downloading.
 */
function ToolImagePreviewLoader({
  projectId,
  image,
  onClose,
}: {
  projectId: string;
  image: ToolCallImage;
  onClose: () => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, image.path);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch (err) {
        console.warn('[tool-image] preview load failed', { path: image.path, err });
        // If load failed, close the preview rather than show a blank overlay.
        onClose();
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, image.path, onClose]);
  if (!src) return null;
  return (
    <ImagePreview
      src={src}
      alt="Tool screenshot"
      caption={image.path}
      onClose={onClose}
      downloadFilename={image.path.split(/[/\\]/).pop() ?? 'image'}
    />
  );
}

/** Most failures a reader needs to see at once. Beyond this the expando
 *  is the right surface — the notice is a headline, not a log. */
const VISIBLE_TOOL_FAILURES = 2;

/**
 * Failures the turn never recovered from, newest last.
 *
 * A failure superseded by a later success of the same tool is resolved —
 * the model corrected its arguments and moved on, and surfacing it would
 * make a self-healed turn read as broken. What survives is the case that
 * actually cost the user something: a completion gate that rejected the
 * work, a tool that never came back. Mirrors the service's
 * `unresolvedFailedToolCalls`, which builds the model's recovery nudge
 * from the same rule.
 */
export function unresolvedToolFailures(
  tools: ReadonlyArray<Pick<ChatMessageToolCall, 'name' | 'success' | 'errorMessage'>>,
): Array<{ name: string; reason: string }> {
  return tools
    .filter(
      (t, i) =>
        !t.success && !tools.slice(i + 1).some((later) => later.name === t.name && later.success),
    )
    .map((t) => ({ name: t.name, reason: t.errorMessage ? toolErrorSummary(t.errorMessage) : '' }))
    .filter((f) => f.reason.length > 0);
}

/**
 * Collapsible "tools that ran during this turn" expando, rendered at the
 * top of a completed assistant bubble. Defaults to closed — most readers
 * don't want to see the tool breadcrumbs on every message, but the
 * header line still conveys a useful summary ("3 steps · 1.2s total").
 *
 * Unrecovered failures break that default: "· 1 failed" behind a closed
 * disclosure is how a rejected completion gate became invisible, leaving
 * the user watching a task loop with no idea what the gate wanted. Those
 * reasons render above the summary, in the thread, unprompted.
 */
export function ToolHistoryExpando({
  tools,
  projectId,
  onOpenReference,
  onFocusTask,
}: {
  tools: ChatMessageToolCall[];
  projectId?: string;
  onOpenReference?: (reference: OpenChatReference) => void;
  /** Opens a task beside the chat (rail Task pane) from a promoted inline card. */
  onFocusTask?: (ref: string) => void;
}) {
  if (tools.length === 0) return null;
  const total = tools.reduce((acc, t) => acc + t.durationMs, 0);
  const failed = tools.filter((t) => !t.success).length;
  // Map persisted ChatMessageToolCall → ToolActivity, stamping the
  // session's projectId on each so the thumbnail loader can build
  // artifact URLs. (Saved records don't carry projectId themselves —
  // the project is implied by the enclosing session.)
  const activities: ToolActivity[] = tools.map((t) => ({
    ...t,
    ...(projectId ? { projectId } : {}),
  }));
  // Generated media (images from generate_image, video from generate_video)
  // shouldn't hide behind the collapsed step list — surface it in a
  // visible strip above the disclosure. The step breakdown stays collapsed.
  const mediaActivities = activities.filter(
    (t) => t.projectId && ((t.images && t.images.length > 0) || (t.videos && t.videos.length > 0)),
  );
  // Rich inline cards (craftbook start / step advance) get the same
  // promotion as generated media: visible above the collapsed step list,
  // suppressed inside it so the plain row still counts in "N steps" and
  // keeps the args/result provenance.
  const cardActivities = activities.filter((t) => t.card);
  const failures = unresolvedToolFailures(tools).slice(-VISIBLE_TOOL_FAILURES);
  return (
    <>
      {cardActivities.map((t, i) =>
        t.card ? (
          <div className="msg-tool-card-promoted" key={`card-${t.name}-${i}`}>
            <ToolCraftbookCard card={t.card} onFocusTask={onFocusTask} />
          </div>
        ) : null,
      )}
      {mediaActivities.map((t, i) => (
        <div className="msg-tool-media" key={`media-${t.name}-${i}`}>
          {t.videos && t.videos.length > 0 && t.projectId ? (
            <ToolVideoRow projectId={t.projectId} videos={t.videos} />
          ) : t.images && t.images.length > 0 && t.projectId ? (
            <ToolImageRow projectId={t.projectId} images={t.images} />
          ) : null}
        </div>
      ))}
      {failures.map((f, i) => (
        <div className="msg-tool-failure" key={`fail-${f.name}-${i}`}>
          <span className="msg-tool-failure-icon" aria-hidden="true">
            ✗
          </span>
          <span className="msg-tool-failure-body">
            <span className="msg-tool-failure-tool">{toolDisplayName(f.name)}</span>
            {f.reason}
          </span>
        </div>
      ))}
      <details className="msg-tool-history">
        <summary>
          <span className="msg-tool-history-count">
            {tools.length} {tools.length === 1 ? 'step' : 'steps'}
          </span>
          <span className="msg-tool-history-total muted">· {formatDurationShort(total)} total</span>
          {failed > 0 && <span className="msg-tool-history-failed">· {failed} failed</span>}
        </summary>
        <ToolActivityList
          tools={activities}
          suppressMedia
          suppressCards
          onOpenReference={onOpenReference}
        />
      </details>
    </>
  );
}

/**
 * Collapsible "Thinking" disclosure for the chain-of-thought captured
 * from `<think>` / `<reasoning>` tags by the local providers. Default
 * collapsed — the visible reply is the headline; this is here for
 * users who want to re-read the deliberation that led to the answer
 * (e.g. small-model debugging, "why did Ada decide to do X?"). Plain-
 * text rendering on purpose: the trace often has unbalanced markdown
 * (half-quoted code, dangling lists, partial fences from a turn that
 * got cut short) and we don't want a rendering pass to swallow it.
 */
export function countReasoningWords(reasoning: string): number {
  const trimmed = reasoning.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

function ReasoningExpando({
  reasoning,
  durationMs,
}: {
  reasoning: string;
  durationMs?: number;
}) {
  const trimmed = reasoning.trim();
  if (!trimmed) return null;
  const wordCount = countReasoningWords(trimmed);
  const duration =
    durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0
      ? formatDurationShort(Math.round(durationMs))
      : null;
  return (
    <details className="msg-reasoning">
      <summary>
        <span className="msg-reasoning-label">Thinking</span>
        <span className="msg-reasoning-meta">
          · {wordCount} {wordCount === 1 ? 'word' : 'words'}
          {duration ? ` · ${duration}` : ''}
        </span>
      </summary>
      <pre className="msg-reasoning-body">{trimmed}</pre>
    </details>
  );
}

/**
 * Live counterpart to {@link ReasoningExpando}: renders the think phase
 * as it streams (ds4's `reasoning_content` channel), always-open and
 * dimmed, above the reply. Auto-scrolls to the tail so the newest
 * reasoning stays in view inside the capped-height body. Replaced by the
 * collapsed expander once the turn commits and the slot is torn down.
 * Plain-text on purpose — same reasoning-as-raw-trace rationale as the
 * expander (a mid-stream trace has unbalanced markdown we don't want a
 * render pass to swallow).
 */
function LiveReasoning({ text }: { text: string }) {
  const bodyRef = useRef<HTMLPreElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to autoscroll as reasoning text streams in
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div className="msg-stream-reasoning" aria-label="Thinking" aria-live="polite">
      <span className="msg-stream-reasoning-label">Thinking</span>
      <pre className="msg-stream-reasoning-body" ref={bodyRef}>
        {text}
      </pre>
    </div>
  );
}

/** Friendly verb for the live tool-args block's label. */
function toolArgsVerb(name: string): string {
  switch (name) {
    case 'write_file':
    case 'write_artifact':
    case 'write_document':
      return 'Writing';
    case 'replace_in_file':
    case 'apply_patch':
    case 'insert_at_marker':
      return 'Editing';
    case '':
      return 'Working';
    default:
      return 'Calling';
  }
}

/**
 * Pull a target path out of the head of a streaming tool-args JSON
 * fragment ("Writing index.html" beats "Writing — write_file"). The
 * head is captured before the tail cap scrolls the opening away; a
 * mid-stream fragment is not valid JSON, so this is a regex sniff,
 * not a parse.
 */
function extractToolArgsPath(head: string): string | null {
  const m = head.match(/"(?:path|file_path|filename|name)"\s*:\s*"([^"\\]+)"/);
  return m ? m[1]! : null;
}

/**
 * Live view of a structured tool call being generated — the "what are
 * those tokens?" answer for the long silent stretch of a streamed
 * `write_file`, where argument tokens never appear as visible deltas
 * and the only other signal is the climbing wire-pulse counter.
 * Same dimmed-live-block pattern as {@link LiveReasoning}: always
 * open, auto-scrolled to the tail, torn down when the real tool row
 * replaces it. The tail is decoded out of its JSON encoding first
 * (see renderToolArgsFragment) so the user reads the file being
 * written rather than `PASS\\n- Criterion 2: FAIL`. Still plain text,
 * not markdown — a mid-stream fragment is routinely unbalanced.
 */
function LiveToolArgs({
  args,
}: {
  args: { name: string; chars: number; head: string; tail: string };
}) {
  const bodyRef = useRef<HTMLPreElement>(null);
  const body = renderToolArgsFragment(args.tail);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to autoscroll as args stream in
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [body]);
  const verb = toolArgsVerb(args.name);
  const path = extractToolArgsPath(args.head);
  const target = path ?? (args.name.length > 0 ? args.name : null);
  return (
    <div className="msg-stream-toolargs" aria-live="polite">
      <span className="msg-stream-toolargs-label">
        {verb}
        {target && (
          <>
            {' '}
            <code className="msg-stream-toolargs-target">{target}</code>
          </>
        )}
        <span className="msg-stream-toolargs-count">
          {' '}
          · {COMPACT_TOKEN_FMT.format(args.chars)} chars
        </span>
      </span>
      <pre className="msg-stream-toolargs-body" ref={bodyRef}>
        {body}
      </pre>
    </div>
  );
}

/**
 * Heuristic: pull the function name out of a salvage-failed tool-call
 * body so the empty-bubble summary can show what the model was *trying*
 * to do instead of a generic "no response." Same shapes as
 * `extractWantedToolName` on the service side — kept in lockstep so
 * the UI doesn't have to round-trip through the service to derive
 * a summary it could compute locally.
 */
function extractAttemptedCallName(body: string): string | null {
  const cleaned = body.replace(/<\|"\|>/g, '"').replace(/\*\//g, '"');
  const envelope = cleaned.match(/^\s*(?:call\s*:\s*)?([a-zA-Z_][a-zA-Z0-9_-]*)\s*[({]/);
  if (envelope) return envelope[1]!;
  const jsonName = cleaned.match(/"(?:tool|name|function)"\s*:\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/);
  if (jsonName) return jsonName[1]!;
  return null;
}

/**
 * Build the "model tried to call X but the call shape didn't parse"
 * summary text for an empty assistant bubble whose only signal is a
 * salvage-failed tool-call body. Surfacing the wanted tool name turns
 * "No response" into "Tried to call `start_project` (call shape didn't
 * parse — see attempts above)" — exactly the diagnostic the user needs
 * to decide whether to retry, switch models, or report a salvage gap.
 */
function buildAttemptedCallSummary(
  attempts: ReadonlyArray<{ body: string; reason?: string }>,
): string {
  const names = new Set<string>();
  for (const a of attempts) {
    const n = extractAttemptedCallName(a.body);
    if (n) names.add(n);
  }
  const namesArr = Array.from(names);
  if (namesArr.length === 1) {
    return `Tried to call \`${namesArr[0]}\` ${attempts.length} time${attempts.length === 1 ? '' : 's'} — the call shape didn't parse. See "Attempted call" above for what was emitted.`;
  }
  if (namesArr.length > 1) {
    return `Tried to call ${namesArr.map((n) => `\`${n}\``).join(', ')} but none of the call shapes parsed. See "Attempted calls" above.`;
  }
  return `Model emitted ${attempts.length} tool-call attempt${attempts.length === 1 ? '' : 's'} that the runtime couldn't parse. See "Attempted call${attempts.length === 1 ? '' : 's'}" above for the literal shapes.`;
}

function AttemptedToolCallsExpando({
  attempts,
}: {
  attempts: ReadonlyArray<{ body: string; reason?: string }>;
}) {
  if (attempts.length === 0) return null;
  return (
    <details className="msg-reasoning">
      <summary>
        <span className="msg-reasoning-label">
          Attempted call{attempts.length === 1 ? '' : 's'} ({attempts.length})
        </span>
      </summary>
      <div className="msg-reasoning-body">
        {attempts.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: bubble-local fixed list
          <div key={i} style={{ marginBottom: '0.75rem' }}>
            {a.reason && (
              <div style={{ fontSize: '0.85em', opacity: 0.75, marginBottom: '0.25rem' }}>
                {a.reason}
              </div>
            )}
            <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{a.body}</pre>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * Re-renders the caller every second as long as `startedAt` is set.
 * Returns the integer number of seconds since `startedAt` (or null when
 * not streaming). Uses a single shared interval so adding the counter to
 * a bubble doesn't spin up multiple timers.
 */
export function useElapsedSeconds(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  if (startedAt === null) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

/**
 * Human-readable elapsed string for the "still working" banner. Same
 * math as `formatElapsedClock`, but we spell out the units so a user
 * skimming the bubble gets "2 min 15 sec" instead of parsing "2m 15s".
 */
function formatElapsedLong(s: number): string {
  if (s < 60) return `${s} seconds in`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (r === 0) return `${m} min in`;
  return `${m} min ${r} sec in`;
}

/**
 * Render a "wire pulse" count as a bare numeric tally. We used to draw
 * one dot per pulse (capped, then collapsed to "···· (207)"), but the
 * accumulating dots added visual noise without conveying more than the
 * number itself — so just show the count.
 */
function formatWirePulses(count: number): string {
  return `(${count})`;
}

/* `thinkingDetail` from the engine parsers comes pre-formatted as e.g.
   "4,096 / 7,880 tokens · 298 tok/s" (MLX prefill) or
   "Processing prompt (15% · 2,048 tokens)" (llama.cpp). Pull the
   total token count out — when an "X / Y tokens" pair is present the
   second number is the prefill target; when only one number is present
   (llama.cpp's single running figure) we fall back to it. The progress
   bar already conveys "how far along"; the chip's job is to anchor
   the magnitude of the prompt being prefilled. */
function extractTotalTokenCount(detail: string | undefined): number | null {
  if (!detail) return null;
  const m = detail.match(/(\d[\d,]*)\s*(?:\/\s*(\d[\d,]*)\s*)?tokens/i);
  if (!m) return null;
  const raw = (m[2] ?? m[1] ?? '').replace(/,/g, '');
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const COMPACT_TOKEN_FMT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/**
 * Status-line label for an in-flight `gpu_swap` of `image_generation`.
 * Plain "Generating image" before the first sd-server progress line
 * arrives; "Generating image — step 7 / 20" once the engine starts
 * reporting per-step ticks. The label is the load-bearing signal in
 * the bubble's status row, so we keep it short and let the progress
 * bar itself carry the percentage.
 */
function formatImageGenLabel(
  step: number | undefined,
  totalSteps: number | undefined,
  task: SessionGpuTask = 'image_generation',
  detail?: string,
): string {
  // Recognition is a single decode with no per-step ticks, so it never has
  // counters to show — and a fabricated bar would read worse than a spinner.
  if (task === 'image_recognition') {
    return detail?.trim() ? detail.trim() : 'Reading your image';
  }
  const noun = task === 'video_generation' ? 'video' : 'image';
  if (step === undefined || totalSteps === undefined) {
    // No sampling steps yet. Video has long pre-generation phases
    // (provisioning the Python env, loading model weights) that the
    // engine reports as `detail` — surface them as the label so the
    // bubble isn't a silent spinner. Image cold-start is short, so it
    // keeps the generic label.
    if (task === 'video_generation' && detail?.trim()) return detail.trim();
    return `Generating ${noun}`;
  }
  return `Generating ${noun} — step ${step} / ${totalSteps}`;
}

/**
 * Tooltip detail for the gpu-swap progress bar — verbose by design,
 * since this is the place a curious user can confirm the engine is
 * still making progress and roughly how long is left. Includes
 * `Xs / step` and a coarse remaining-time ETA when the engine has
 * reported a per-step duration. Falls back to the raw `gpu_swap`
 * `detail` when no step counters have arrived yet (cold start window
 * before sd-server emits its first sampling line).
 */
function formatImageGenProgressDetail(opts: {
  step: number | undefined;
  totalSteps: number | undefined;
  secondsPerStep: number | undefined;
  fallback: string | undefined;
}): string | undefined {
  const { step, totalSteps, secondsPerStep, fallback } = opts;
  if (step === undefined || totalSteps === undefined) return fallback;
  const parts = [`step ${step} / ${totalSteps}`];
  if (secondsPerStep !== undefined && Number.isFinite(secondsPerStep)) {
    parts.push(`${secondsPerStep.toFixed(1)}s/step`);
    const remaining = Math.max(0, totalSteps - step);
    if (remaining > 0) {
      const eta = remaining * secondsPerStep;
      parts.push(`~${formatEtaSeconds(eta)} left`);
    }
  }
  return parts.join(' · ');
}

function formatEtaSeconds(s: number): string {
  if (s < 60) return `${Math.round(s)}s`;
  const min = Math.floor(s / 60);
  const sec = Math.round(s - min * 60);
  return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
}

/** Render an Ollama `size_vram` byte count as a friendly GiB string. */
function formatVramSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB VRAM`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB VRAM`;
}

// A gezel sometimes emits a whole HTML document inline (an index.html it
// "wrote", say). Rendered as markdown that lands as a hollow page —
// styles and scripts stripped by squisq's sanitizer, bare structure left
// over — which is noise, not signal. When a message is *mostly* raw HTML
// we show its source as a code block instead: honest about what the model
// produced, far easier to read, and immune to the global-style leak that
// raw <style> blocks used to cause.

/** Full-page / styling / scripting markers — their presence in a raw-HTML
 *  node is a strong "this is a document, not chat prose" signal. */
const RAW_HTML_PAGE_MARKER_RE = /<\s*(?:!doctype|html|head|body|style|script)\b/i;

/** Below this many raw-HTML characters we leave the message alone — small
 *  inline HTML (a stray <br>, <sub>…) renders fine as-is. */
const RAW_HTML_DUMP_MIN_CHARS = 120;

/** Minimal structural view of a parsed-markdown node for the raw-HTML scan. */
type MarkdownWalkNode = { type?: string; rawHtml?: string; children?: MarkdownWalkNode[] };

/** Sum raw-HTML characters across a parsed-markdown tree and flag whether
 *  any raw-HTML node carries page markers. Fenced code parses as `code`
 *  (not `htmlBlock`), so HTML the model already fenced is left untouched. */
function scanRawHtml(nodes: readonly MarkdownWalkNode[]): { chars: number; pageMarkers: boolean } {
  let chars = 0;
  let pageMarkers = false;
  const visit = (node: MarkdownWalkNode): void => {
    if (node.type === 'htmlBlock' || node.type === 'htmlInline') {
      const raw = node.rawHtml ?? '';
      chars += raw.length;
      if (!pageMarkers && RAW_HTML_PAGE_MARKER_RE.test(raw)) pageMarkers = true;
    }
    if (node.children) for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return { chars, pageMarkers };
}

/** True when a chat message reads as a raw HTML document/fragment rather
 *  than prose: substantial raw HTML that either dominates the message or
 *  carries page markers. Such messages render better as source. */
export function isRawHtmlDump(nodes: readonly MarkdownWalkNode[], source: string): boolean {
  const { chars, pageMarkers } = scanRawHtml(nodes);
  if (chars < RAW_HTML_DUMP_MIN_CHARS) return false;
  const total = source.trim().length || 1;
  return pageMarkers || chars / total >= 0.5;
}

/** Wrap a message in an ```html fence sized longer than any backtick run
 *  inside it, so arbitrary content can't terminate the block early. */
export function toHtmlCodeFence(source: string): string {
  let longestRun = 0;
  for (const match of source.matchAll(/`+/g)) longestRun = Math.max(longestRun, match[0].length);
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}html\n${source}\n${fence}`;
}

export function RenderedMarkdown({
  markdown,
  mediaProvider,
  fontFamily,
}: {
  markdown: string;
  mediaProvider?: MediaProvider | null;
  /**
   * Per-gezel chat-bubble font (a CSS `font-family` value). Squisq's
   * LinearDocView sets its own `bodyFont` from the theme's typography and
   * applies it inline — overriding anything inherited from `.msg-body`.
   * So to honour the gezel's font we fold it into the theme we hand the
   * view rather than relying on CSS inheritance.
   */
  fontFamily?: string;
}) {
  const doc = useMemo(() => {
    try {
      const mdDoc = parseMarkdown(markdown);
      // Mostly-raw-HTML messages render as source rather than a hollow
      // sanitized page — see isRawHtmlDump / toHtmlCodeFence above.
      const source = isRawHtmlDump(
        (mdDoc.children ?? []) as unknown as MarkdownWalkNode[],
        markdown,
      )
        ? parseMarkdown(toHtmlCodeFence(markdown))
        : mdDoc;
      return markdownToDoc(source, { articleId: 'gezel-chat' });
    } catch {
      return null;
    }
  }, [markdown]);
  // Override the squisq theme's body + title fonts with the gezel's font
  // when one is set. `resolveFontFamily` passes a string family through
  // verbatim, so the GEZEL_CHAT_FONTS family value drops straight in.
  const theme = useMemo<Theme>(() => {
    if (!fontFamily) return gezelChatTheme;
    // GEZEL_CHAT_FONTS families are ready-to-use CSS strings (e.g.
    // `'JetBrains Mono'`). `resolveFontFamily` passes a raw string family
    // through verbatim, which is exactly the CSS we want — but the
    // `FontFamily` type only models the structured `{stackId}` / `{custom}`
    // variants (the `{custom}` path would re-quote our already-quoted name).
    // Cast to keep the simple, correct string path.
    const font = fontFamily as unknown as FontFamily;
    return {
      ...gezelChatTheme,
      typography: { ...gezelChatTheme.typography, bodyFont: font, titleFont: font },
    };
  }, [fontFamily]);
  const effective = useEffectiveTheme();
  // Theme + font choices live in [chat-theme.ts](./chat-theme.ts) so
  // bubble bodies and the attachment previewer in
  // [ChatReferences.tsx](./ChatReferences.tsx) stay in lockstep.
  //
  // In light mode we overlay the shared pale-brown reading surface. Its
  // color matches the `--chat-bubble-bg` token used by the outer bubble,
  // so the result appears seamlessly tinted. In dark mode we skip the
  // surface overlay so the theme's own warm-tinted canvas comes through.
  const surface = effective === 'light' ? CHAT_BUBBLE_LIGHT_SURFACE : undefined;
  if (!doc) return <>{markdown}</>;
  // Chat history uses Squisq's thumbnail image mode so a pasted screenshot
  // doesn't steamroll the bubble — the user can click to open full-size
  // if needed (future follow-up).
  const view = (
    <LinearDocView
      doc={doc}
      theme={theme}
      surface={surface}
      thinMargins
      imageDisplayMode="thumbnail"
    />
  );
  if (!mediaProvider) return view;
  // The view's image layer reads from `MediaContext` to resolve
  // `<img src="images/abc.png">` into blob URLs via our auth'd client.
  return <MediaContext.Provider value={mediaProvider}>{view}</MediaContext.Provider>;
}
