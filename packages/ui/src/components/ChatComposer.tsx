import { EditorShell, type MentionCandidate } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { type GezelSummary, displayName, parseTaskRef } from '@bendyline/gezel';
import { streamChatEvents } from '@bendyline/gezel-client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useEffectiveTheme } from '../theme.js';
import { ChatRecipientPicker } from './ChatRecipientPicker.js';
import { GezelIcon } from './GezelIcon.js';
import { createGezelMediaProvider } from './GezelMediaProvider.js';
import type { ToolActivity } from './chat-bubbles.js';
import { publishOptimisticUserMessage } from './chat-optimistic-events.js';
import { type MentionToken, extractMentionTokens, extractMentions } from './mention-parse.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

export type ComposerTurnState = 'idle' | 'streaming' | 'queued' | 'error';

interface LocalTurnStream {
  id: number;
  sessionId: string;
  controller: AbortController;
  accepted: boolean;
}

/**
 * Module-level queue for prefill payloads. A view elsewhere in the
 * app (e.g. the "Complain about this" preview-error button) calls
 * `queueComposerPrefill(projectId, markdown)` BEFORE navigating to
 * the chat tab; the next ChatComposer that mounts for the matching
 * project consumes the entry, drops the markdown into its editor,
 * and leaves the user to review + hit Send themselves. Keyed by
 * projectId so prefills for a different project than the one the
 * user ends up on don't accidentally clobber an unrelated draft.
 *
 * The alternative — a custom `window` event — lost the payload when
 * dispatched before the listener mounted.
 */
const pendingPrefills = new Map<string, string>();

/**
 * Fired right after a prefill is queued so a composer that's ALREADY
 * mounted for the matching project drains it immediately. Without this,
 * delivery relied solely on a remount: the consume effect is keyed on
 * `projectId`, so when the queue is filled while a same-project composer
 * is already on screen (e.g. the Output pane's camera "debug frame"
 * button while the Chat tab is already active beside it), nothing ever
 * picked the entry up and the screenshot silently vanished.
 */
const PREFILL_EVENT = 'gezel:composer-prefill';

function newlineShortcutLabel(): string {
  const platform =
    window.__GEZEL__?.platform ??
    (typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent);
  return platform === 'darwin' || /Mac/i.test(platform) ? '⌘⏎' : 'Ctrl+Enter';
}

export function queueComposerPrefill(projectId: string, markdown: string): void {
  pendingPrefills.set(projectId, markdown);
  // Harmless when no composer is mounted yet — the mount-time drain in
  // ChatComposer covers the navigate-then-mount case.
  window.dispatchEvent(new CustomEvent(PREFILL_EVENT, { detail: { projectId } }));
}

export interface ChatComposerProps {
  gezelId: string;
  /** The primary recipient's display name — rendered in the "To:" pill. */
  gezelName: string;
  /** The primary recipient's sanitized SVG icon. */
  gezelIcon?: string | null;
  /** The primary recipient's persisted poppetje. */
  gezelPoppetje?: import('@bendyline/gezel').Poppetje | null;
  /** When true and a custom icon.svg exists, render that instead of the poppetje. */
  gezelIconOverride?: boolean;
  /** Increment to move keyboard focus into the live Squisq editor. */
  focusRequestKey?: number;
  /**
   * When provided with `onPrimaryRecipientChange`, renders the address-book
   * `+` on the To line. Name/face clicks replace the primary recipient; each
   * row's smaller `+` adds that gezel to this composer's fan-out list.
   */
  recipientGezels?: GezelSummary[];
  onPrimaryRecipientChange?: (gezelId: string) => void;
  projectId: string;
  /**
   * Active session id. When undefined, the composer lazy-creates a session
   * on first send and emits the new id via `onSessionCreated` so the
   * parent (and any session switcher) can update.
   */
  sessionId: string | undefined;
  onSessionCreated?: (sessionId: string) => void;
  /**
   * Tool activities observed during the composer's own send turn. The
   * timeline gets its own copy via the project SSE stream — this callback
   * is for any caller that wants a session-scoped subset (e.g. the
   * References pane scoped to the active turn).
   */
  onToolActivity?: (tool: ToolActivity) => void;
  /**
   * Called when a turn starts/ends. The parent uses this to render
   * inline status (e.g. an error banner) outside the composer.
   */
  onTurnStateChange?: (state: ComposerTurnState, error?: string) => void;
  /**
   * Editor placeholder shown while the draft is empty. Callers pass a
   * pre-picked prompt (see `chat-placeholder.ts`) so the phrasing can
   * reflect the recipient's role (meester vs. voorman vs. other). Omit
   * to fall back to Squisq's generic rotating prompts.
   */
  placeholder?: string;
  /**
   * When set, any session created lazily on first send is scoped to this
   * task (and phase). Also narrows the "reuse an existing session" probe
   * so we don't pick up a non-task session for the same (gezel, project).
   */
  taskRef?: string;
  stepId?: string;
  /** Craftbook template this composer's session edits (the editor's AI assist). */
  craftbookRef?: string;
  /**
   * Optional content rendered between the "To:" line and the editor —
   * SessionSwitcher slots in here so the session picker reads as part
   * of the composer instead of floating above it.
   */
  belowAddressLine?: ReactNode;
  /**
   * Project-chat pivot hook. Fires the first time a draft picks up
   * an `@<otherGezel>` mention (other than the current primary) so
   * the parent can switch the active gezel chip + the SessionSwitcher
   * over to the @-mentioned recipient. After the pivot the composer's
   * `gezelId` becomes the @-mentioned id, the TO line shows just that
   * gezel (the old primary chip auto-filters out via the existing
   * primary-dedup check), and the SessionSwitcher refreshes to the
   * mentioned gezel's session list.
   *
   * When the project has a voorman that the user is pivoting away
   * from, that voorman's id gets passed alongside so the parent /
   * server can wire a passive `notifyUserMessage` CC — keeping the
   * voorman's transcript aware of the conversation without engaging
   * them. Optional — surfaces only need to wire this when they have
   * the (project, voorman) context to pivot inside; the meester chat
   * leaves it undefined and falls back to fan-out semantics.
   */
  onPivotToMention?: (mentionedGezelId: string) => void;
  /**
   * Gezel ids to passively CC on the next send — appended to the
   * server request as `passiveCcGezelIds`. Each cc'd gezel's session
   * in this project gets `notifyUserMessage` appended (transcript-
   * only, no provider call). Used by ProjectChat after a pivot fires
   * so the previous primary (typically the voorman) still sees the
   * message land in their queue. The composer reads this on every
   * send and clears via `onPassiveCcConsumed` afterward — passive CC
   * doesn't persist across sends.
   */
  passiveCcGezelIds?: string[];
  /**
   * Fired once `passiveCcGezelIds` has been folded into a send so the
   * parent can clear it. Subsequent messages that don't pivot
   * shouldn't carry forward a stale CC list.
   */
  onPassiveCcConsumed?: () => void;
  /**
   * Fired when the user starts a fresh draft with `> ` (markdown
   * blockquote, also the terminal prompt sigil). The parent can use
   * this as a signal to flip the compose surface into terminal mode
   * and seed the terminal input with whatever the user has already
   * typed after the `> ` marker — so typing `> ls<enter>` in chat
   * lands as `ls` in the terminal without losing the keystrokes
   * during the handoff.
   *
   * Only fires on the FIRST transition out of an essentially-empty
   * draft (prev length ≤ 2). Pasting a long chat message that
   * happens to start with `> ` will not trigger this. Surfaces
   * without terminal mode (Meester, per-gezel chat) leave this
   * undefined and the chat composer never escapes.
   */
  onTerminalEscape?: (initialInput: string) => void;
}

/**
 * Bottom-of-chat message composer. Owns:
 *
 *   - The Squisq rich-markdown editor + Send/Stop buttons
 *   - Lazy session creation on first send
 *   - POSTing the message to the session
 *   - A session-scoped SSE subscription used purely to detect `done` /
 *     `error` so the Stop button can flip back to Send. The actual message
 *     content lands in the parent timeline via its own (project- or
 *     global-scoped) SSE stream — no duplicate state here.
 */
export function ChatComposer({
  gezelId,
  gezelName,
  gezelIcon,
  gezelPoppetje,
  gezelIconOverride,
  focusRequestKey,
  recipientGezels,
  onPrimaryRecipientChange,
  projectId,
  sessionId,
  onSessionCreated,
  onToolActivity,
  craftbookRef,
  onTurnStateChange,
  placeholder,
  taskRef,
  stepId,
  belowAddressLine,
  onPivotToMention,
  passiveCcGezelIds,
  onPassiveCcConsumed,
  onTerminalEscape,
}: ChatComposerProps) {
  const composerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusRequestKey) return;
    const frame = window.requestAnimationFrame(() => {
      composerRef.current
        ?.querySelector<HTMLElement>('.squisq-wysiwyg-editor')
        ?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequestKey]);
  const editorTheme = useEffectiveTheme();
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [streaming, setStreaming] = useState(false);
  // The local SSE is only one view of a turn. Navigation, remounts, and a
  // renderer reconnect can drop it while the service keeps generating.
  // Track the service's authoritative in-flight state separately so the
  // composer never regresses to a misleading Send button.
  const [serverInflight, setServerInflight] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * How many turns are ahead of this one on the provider queue, when
   * we're in the `queued` state. The service only emits the `queued`
   * event if the wait exceeds 200ms, so under the common empty-queue
   * happy path this stays null and the composer shows "thinking."
   */
  const [queuedAhead, setQueuedAhead] = useState<number | null>(null);
  /**
   * Details of a previous turn that's still running on this session.
   * Populated when the service returns the "already in flight" 400 —
   * surfaces as a banner with a cancel button so the user can break
   * out of a wedged turn instead of being silently blocked.
   */
  const [wedged, setWedged] = useState<{
    userText: string;
    elapsedMs: number;
    sessionId: string;
  } | null>(null);
  const draftRef = useRef<string>('');
  // Render-triggering shadow of `draftRef.current.trim().length > 0`.
  // The ref alone never re-renders, and the mid-turn button row (Nudge /
  // Interrupt appear only when there's text) needs to react to typing.
  const [draftNonEmpty, setDraftNonEmpty] = useState(false);
  // EditorShell reads initialMarkdown and configures its placeholder only
  // when it mounts. Bump this revision whenever the host needs to seed or
  // clear the editor; draftRef supplies the content for the fresh mount.
  const [editorRevision, setEditorRevision] = useState(0);
  // Drain a queued prefill into the editor. Runs on mount (covers the
  // navigate-to-chat-then-mount case) AND on `PREFILL_EVENT` (covers an
  // already-mounted composer — the Output pane camera button while the
  // Chat tab is already active beside it). The key bump forces an
  // EditorShell remount so the new initial content shows.
  const consumePrefill = useCallback(() => {
    const queued = pendingPrefills.get(projectId);
    if (!queued) return;
    pendingPrefills.delete(projectId);
    // Don't clobber an in-progress draft. The editor is a published
    // black-box (`@bendyline/squisq-editor-react`) with no host-facing
    // "insert at caret" handle, so we can't drop the payload at the
    // user's actual insertion point. The next-best, non-destructive
    // behavior: when the composer already has text, append the payload
    // below it (blank-line separated); when it's empty, the payload
    // becomes the whole draft.
    const existing = draftRef.current.trim();
    const merged = existing ? `${existing}\n\n${queued}` : queued;
    draftRef.current = merged;
    setDraftNonEmpty(merged.trim().length > 0);
    setEditorRevision((revision) => revision + 1);
  }, [projectId]);
  useEffect(() => {
    consumePrefill();
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent).detail as { projectId?: string } | undefined;
      if (detail?.projectId === projectId) consumePrefill();
    };
    window.addEventListener(PREFILL_EVENT, onPrefill);
    return () => window.removeEventListener(PREFILL_EVENT, onPrefill);
  }, [consumePrefill, projectId]);
  // Gezels @-mentioned in the current draft. Rendered as extra chips in
  // the "To:" row so the user sees who the fan-out will reach before they
  // hit Send — previously the row was static on the primary and users had
  // no feedback that mentions were even being parsed.
  const [mentioned, setMentioned] = useState<MentionToken[]>([]);
  // Recipients chosen from the To-line picker are independent of inline
  // @-mentions. They use the same server fan-out field at send time, but stay
  // visible across turns until the user removes one or replaces the primary.
  const [additionalRecipientIds, setAdditionalRecipientIds] = useState<string[]>([]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active (gezel, project) address is the deliberate reset trigger.
  useEffect(() => {
    setAdditionalRecipientIds([]);
  }, [gezelId, projectId]);
  const additionalRecipients = useMemo(() => {
    const byId = new Map((recipientGezels ?? []).map((gezel) => [gezel.id, gezel]));
    return additionalRecipientIds.flatMap((id) => {
      const gezel = byId.get(id);
      return gezel ? [gezel] : [];
    });
  }, [additionalRecipientIds, recipientGezels]);
  const [engagementMode, setEngagementMode] = useState<
    'proactive' | 'scheduled' | 'reactive' | 'off'
  >('proactive');
  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => setEngagementMode(cfg.aiEngagementMode ?? 'proactive'))
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { aiEngagementMode?: string } | undefined;
      if (detail?.aiEngagementMode) {
        setEngagementMode(
          detail.aiEngagementMode as 'proactive' | 'scheduled' | 'reactive' | 'off',
        );
      }
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => window.removeEventListener('gezel:config-updated', onConfigUpdated);
  }, []);
  const engagementOff = engagementMode === 'off';
  const localTurnRef = useRef<LocalTurnStream | null>(null);
  const localTurnSequenceRef = useRef(0);
  // Live session id — initialized from the prop and updated the first time
  // we lazy-create a session (from either a paste or a Send click). Shared
  // between the media provider and the send path so they can't disagree.
  const liveSessionIdRef = useRef<string | null>(sessionId ?? null);
  const [liveSessionId, setLiveSessionId] = useState<string | null>(sessionId ?? null);
  useEffect(() => {
    liveSessionIdRef.current = sessionId ?? null;
    setLiveSessionId(sessionId ?? null);
  }, [sessionId]);

  const ensureSessionId = useCallback(async (): Promise<string> => {
    if (liveSessionIdRef.current) return liveSessionIdRef.current;
    // Look for an existing unarchived session before creating a fresh
    // one. The user-facing bug this protects: if the user navigates
    // (Home → back to Chat) and types fast enough that the
    // SessionSwitcher's auto-pick effect hasn't populated `sessionId`
    // yet, this path used to unconditionally create a NEW session —
    // splitting one user-perceived conversation across two records.
    //
    // When task-scoped, scope the reuse probe to this task's sessions
    // so we don't grab an unrelated (gezel, project) session.
    try {
      if (taskRef) {
        const parsed = parseTaskRef(taskRef);
        if (parsed) {
          const res = await api.listTaskSessions(parsed.projectId, parsed.num);
          const existing = res.sessions.find((s) => !s.archived && s.gezelId === gezelId);
          if (existing) {
            liveSessionIdRef.current = existing.id;
            setLiveSessionId(existing.id);
            onSessionCreated?.(existing.id);
            return existing.id;
          }
        }
      } else {
        const res = await api.listChatSessions({ gezelId, projectId });
        // Ordinary chat must never reuse a task/craftbook handoff session.
        // The SessionSwitcher applies the same boundary, but this fallback
        // also has to enforce it for the fast-type race before auto-pick.
        const existing = res.sessions.find((s) => !s.archived && !s.taskRef);
        if (existing) {
          liveSessionIdRef.current = existing.id;
          setLiveSessionId(existing.id);
          onSessionCreated?.(existing.id);
          return existing.id;
        }
      }
    } catch {
      /* fall through to create */
    }
    const body = {
      gezelId,
      projectId,
      ...(taskRef ? { taskRef } : {}),
      ...(stepId ? { stepId } : {}),
      ...(craftbookRef ? { craftbookRef } : {}),
    };
    const created = await api.createChatSession(body);
    liveSessionIdRef.current = created.id;
    setLiveSessionId(created.id);
    onSessionCreated?.(created.id);
    return created.id;
  }, [gezelId, projectId, taskRef, stepId, craftbookRef, onSessionCreated]);

  // Media provider is now project-scoped — paste in any session and
  // the file lands in `artifacts/attachments/`, browseable in the
  // Artifacts tab and usable in every chat in the project. No session
  // creation needed up front: the attachment exists independent of
  // whether the user ever hits Send.
  const mediaProvider = useMemo(() => createGezelMediaProvider({ projectId }), [projectId]);

  // Abort any in-flight SSE stream when this composer unmounts. Without
  // this, the held connection counts against Chromium's 6-per-origin
  // limit and a few stuck streams will lock up other requests. Also
  // revoke any cached blob URLs the media provider handed out.
  useEffect(() => {
    return () => {
      localTurnRef.current?.controller.abort();
      localTurnRef.current = null;
      mediaProvider.dispose();
    };
  }, [mediaProvider]);

  const settleLocalTurn = useCallback(
    (turnId: number, opts: { abort?: boolean; serverIdle?: boolean } = {}) => {
      const localTurn = localTurnRef.current;
      if (!localTurn || localTurn.id !== turnId) return;
      localTurnRef.current = null;
      if (opts.abort) localTurn.controller.abort();
      setStreaming(false);
      setQueuedAhead(null);
      if (opts.serverIdle) setServerInflight(false);
    },
    [],
  );

  const syncInflight = useCallback(
    async (targetSessionId: string, shouldApply?: () => boolean): Promise<void> => {
      // Only an authoritative read that STARTED after this local send was
      // accepted may reconcile a missed terminal SSE event. An older idle
      // request can otherwise return late and clear a newer turn.
      const localAtStart = localTurnRef.current;
      const acceptedTurnId =
        localAtStart?.sessionId === targetSessionId && localAtStart.accepted
          ? localAtStart.id
          : null;
      const result = await api.getChatSessionInflight(targetSessionId);
      if (shouldApply && !shouldApply()) return;
      if (liveSessionIdRef.current !== targetSessionId) return;

      // Ignore a result tied to a local turn that completed or was replaced
      // while the request was in flight. Its state is already stale.
      if (acceptedTurnId !== null && localTurnRef.current?.id !== acceptedTurnId) {
        return;
      }

      const inflight = result.inflight !== null;
      setServerInflight(inflight);
      if (!inflight && acceptedTurnId !== null) {
        // The service has finished, but the finite session SSE missed `done`.
        // Abort that reader so it releases its Chromium connection slot too.
        settleLocalTurn(acceptedTurnId, { abort: true, serverIdle: true });
      }
    },
    [settleLocalTurn],
  );

  // Reconcile with the service even when this component did not initiate
  // the turn. A short poll is intentionally scoped to the active session;
  // it also heals missed SSE `done` events after a renderer reconnect.
  useEffect(() => {
    if (!liveSessionId) {
      setServerInflight(false);
      return;
    }
    let disposed = false;
    const sync = async () => {
      try {
        if (!disposed) await syncInflight(liveSessionId, () => !disposed);
      } catch {
        // A transient status-read failure must not clear a known running
        // turn and expose Send while the server may still be busy.
      }
    };
    void sync();
    const timer = window.setInterval(() => void sync(), 2_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [liveSessionId, syncInflight]);

  const turnActive = streaming || serverInflight;
  // Keep Escape handling live for the composer's whole lifetime. Installing
  // the listener only after `turnActive` flips true leaves a commit-to-effect
  // gap where the Stop button is already visible but Escape does nothing.
  const turnActiveRef = useRef(turnActive);
  turnActiveRef.current = turnActive;

  /**
   * Mention provider — backs both the WYSIWYG `@` popover and the Raw
   * Monaco completion. Project chats pass their projectId so the roster
   * gets grouped (voorman → assignees → team); the Meester chat passes
   * `"default"` and effectively gets the full team roster.
   */
  const mentionProvider = useCallback(
    async (query: string): Promise<MentionCandidate[]> => {
      try {
        const res = await api.listMentionCandidates({ projectId, query });
        return res.candidates.map((c) => ({
          id: c.id,
          // In boring mode the chip + inserted mention label use the
          // role-based name; the underlying id (gezel:<id>) is
          // unchanged so existing fan-out / parsing keeps working.
          label: roleBasedNameOnlyMode && c.roleBasedName ? c.roleBasedName : c.label,
          // Every gezel mention namespaces as `gezel` — the only kind of
          // mention we surface today. When we add issue/task mentions,
          // have the server tag each candidate and pass `c.scheme`
          // through instead of hard-coding.
          scheme: 'gezel',
          ...(c.description ? { description: c.description } : {}),
          ...(c.group ? { group: c.group } : {}),
        }));
      } catch {
        return [];
      }
    },
    [projectId, roleBasedNameOnlyMode],
  );

  useEffect(() => {
    const state: ComposerTurnState = error
      ? 'error'
      : queuedAhead !== null
        ? 'queued'
        : turnActive
          ? 'streaming'
          : 'idle';
    onTurnStateChange?.(state, error ?? undefined);
  }, [turnActive, queuedAhead, error, onTurnStateChange]);

  // Tracks the length of the previous draft so we can detect "the
  // user just started typing a new draft" — the signal for the
  // terminal escape. Only the first transition out of an essentially-
  // empty draft (≤ 2 chars: empty, or a lone `>`) is a candidate.
  // After that, the user is mid-composition and a `> ` later in the
  // text is just a blockquote.
  const prevDraftLenRef = useRef(0);
  // Stable identity so Squisq's [markdownSource, onChange] effect doesn't
  // re-fire every render. Refs aren't sufficient on their own (the parent
  // still re-renders) — the useState bail-out via the functional updater
  // prevents a cascade when the mention list hasn't changed.
  const handleDraftChange = useCallback(
    (source: string) => {
      const prevLen = prevDraftLenRef.current;
      prevDraftLenRef.current = source.length;
      draftRef.current = source;
      setDraftNonEmpty(source.trim().length > 0);
      // Terminal escape: user typed `> ` (markdown blockquote / shell
      // sigil) as the very start of a fresh draft. Hand the rest off
      // to the parent which will flip the compose surface into
      // terminal mode and seed the input with `seed`. We don't update
      // `mentioned` here — the ChatComposer is about to unmount.
      if (onTerminalEscape && prevLen <= 2) {
        const trimmed = source.trimStart();
        const m = trimmed.match(/^>\s+([^\n]*)/);
        if (m) {
          onTerminalEscape((m[1] ?? '').trim());
          return;
        }
      }
      const next = extractMentionTokens(source);
      setMentioned((prev) => (sameMentionTokens(prev, next) ? prev : next));
    },
    [onTerminalEscape],
  );

  // Project-chat pivot. When the draft picks up an @-mention for a gezel
  // OTHER than the current primary, fire `onPivotToMention(firstOther.id)`
  // so the parent can switch the active chip + session switcher to the
  // mentioned gezel. After the parent reacts, `gezelId` (this primary)
  // becomes the mentioned id; on the next render the mention dedup filter
  // in the TO line hides the chip automatically, so we don't fire the
  // pivot a second time. Strict equality on the (gezelId, mentioned)
  // pair so a stable draft with a single @-mention doesn't keep firing.
  // Surfaces without `onPivotToMention` wired (the meester chat) keep
  // the existing fan-out semantics.
  const lastPivotedToRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onPivotToMention) {
      lastPivotedToRef.current = null;
      return;
    }
    const firstOther = mentioned.find(
      (m) => m.id !== gezelId && (!m.projectId || m.projectId === projectId),
    );
    if (!firstOther) {
      lastPivotedToRef.current = null;
      return;
    }
    if (lastPivotedToRef.current === firstOther.id) return;
    lastPivotedToRef.current = firstOther.id;
    onPivotToMention(firstOther.id);
  }, [mentioned, gezelId, projectId, onPivotToMention]);

  const send = useCallback(async () => {
    const userText = draftRef.current.trim();
    if (!gezelId || !userText || turnActive) return;
    if (engagementOff) return;
    // Sticky @-mentions tried to reconstitute `@[Label](gezel:id)`
    // markdown as the next composer's `initialMarkdown` so the chip
    // would persist across sends. It doesn't work because the squisq
    // bridge's HTML writes `<span data-mention="true">` while Tiptap's
    // mention extension parses `span[data-type="mention"]` — different
    // attribute names, so the chip silently degrades to plain text on
    // re-mount, the TO row loses the mention, and the next send
    // doesn't fan out to the mentioned gezel. Until squisq grows an
    // imperative `insertMention` API (or we patch the parseHTML
    // mismatch), the only honest behavior is to clear the editor and
    // make the user re-pick on the next turn — exactly the original
    // pre-feature flow. Re-introduce sticky behavior when there's a
    // way to insert a Tiptap mention node directly post-mount.
    draftRef.current = '';
    setDraftNonEmpty(false);
    setEditorRevision((revision) => revision + 1);
    setMentioned([]);
    setError(null);
    setQueuedAhead(null);

    let activeSessionId: string;
    try {
      activeSessionId = await ensureSessionId();
    } catch (err) {
      setError(humanizeTransportError((err as Error).message));
      return;
    }

    setStreaming(true);

    const localTurnId = ++localTurnSequenceRef.current;
    const ctrl = new AbortController();
    localTurnRef.current = {
      id: localTurnId,
      sessionId: activeSessionId,
      controller: ctrl,
      accepted: false,
    };
    const streamPromise = (async () => {
      // Reconnect-with-backoff. A transient socket break mid-turn (daemon
      // restart, dropped h2 connection — every SSE stream in the renderer
      // multiplexes over one connection, so one GOAWAY kills them all)
      // used to surface Chromium's raw `TypeError: network error` in the
      // composer with no retry, even though the turn usually completes
      // fine server-side. The event bus replays the in-flight turn's
      // history on resubscribe, so reconnecting is lossless; `toolsSeen`
      // dedupes the replayed prefix so onToolActivity doesn't re-fire.
      // The 10s keepalive (server pings at 1Hz) catches silently-dead
      // sockets the same way the timeline envelope streams do. If the
      // turn finished while we were disconnected the replay history is
      // already cleared and no `done` will arrive — the 2s syncInflight
      // poll settles the turn and aborts this reader.
      const maxReconnects = 5;
      let reconnects = 0;
      let toolsSeen = 0;
      while (true) {
        let toolsThisConnection = 0;
        try {
          for await (const event of streamChatEvents({
            url: api.sessionEventsUrl(activeSessionId),
            headers: api.authHeader(),
            signal: ctrl.signal,
            fetch: api.getFetch(),
            keepaliveTimeoutMs: 10_000,
          })) {
            if (localTurnRef.current?.id !== localTurnId) return;
            if (event.type === 'tool') {
              toolsThisConnection += 1;
              if (toolsThisConnection <= toolsSeen) continue;
              toolsSeen = toolsThisConnection;
              const tool: ToolActivity = {
                name: event.name,
                durationMs: event.durationMs,
                success: event.success,
                ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
                ...(event.path ? { path: event.path } : {}),
                ...(event.argsSummary ? { argsSummary: event.argsSummary } : {}),
                ...(event.argsFull ? { argsFull: event.argsFull } : {}),
                ...(event.diff !== undefined ? { diff: event.diff } : {}),
                ...(event.addedLines !== undefined ? { addedLines: event.addedLines } : {}),
                ...(event.removedLines !== undefined ? { removedLines: event.removedLines } : {}),
                projectId,
              };
              onToolActivity?.(tool);
            } else if (event.type === 'error') {
              setError(humanizeChatError(event.error));
              setQueuedAhead(null);
            } else if (event.type === 'done') {
              settleLocalTurn(localTurnId, { serverIdle: true });
              return;
            } else if (event.type === 'queued') {
              // Service only fires this after a >200ms wait, so no
              // debouncing needed here — flip to queued immediately.
              setQueuedAhead(event.aheadOf);
            } else if (event.type === 'delta') {
              // First delta means the provider actually started this
              // turn — clear the queued indicator. setState with null
              // when already null is a no-op, so we can fire
              // unconditionally and keep the closure simple.
              setQueuedAhead(null);
            }
            // complete is rendered by the parent timeline via its
            // project/global SSE stream — we don't need to handle it here.
          }
          return;
        } catch (err) {
          if ((err as Error).name === 'AbortError') {
            settleLocalTurn(localTurnId);
            return;
          }
          if (localTurnRef.current?.id !== localTurnId) return;
          reconnects += 1;
          if (reconnects > maxReconnects) {
            console.warn('[ChatComposer] chat event stream lost, giving up:', err);
            setError(humanizeTransportError((err as Error).message));
            settleLocalTurn(localTurnId);
            return;
          }
          const backoffMs = Math.min(500 * 2 ** (reconnects - 1), 5_000);
          console.warn(
            `[ChatComposer] chat event stream lost (reconnect ${reconnects}/${maxReconnects} in ${backoffMs}ms):`,
            err,
          );
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
          if (ctrl.signal.aborted || localTurnRef.current?.id !== localTurnId) return;
        }
      }
    })();

    try {
      // Pull any `@[Name](gezel:id)` mentions out of the draft so the
      // service can fan out to each mentioned gezel's own session. The
      // primary recipient (`gezelId`) is excluded server-side — no
      // double-delivery if the user @-mentioned the current chat target.
      const mentionIds = [
        ...new Set([...extractMentions(userText), ...additionalRecipientIds]),
      ].filter((id) => id !== gezelId);
      // Passive CC bundle (project-chat voorman-CC after a pivot).
      // Filter out the primary just in case the parent passed it
      // through stale state — sending a CC to yourself is a no-op
      // server-side but a confusing transcript ghost client-side.
      const ccIds = (passiveCcGezelIds ?? []).filter((id) => id && id !== gezelId);
      const body: { message: string; mentions?: string[]; passiveCcGezelIds?: string[] } = {
        message: userText,
      };
      if (mentionIds.length > 0) body.mentions = mentionIds;
      if (ccIds.length > 0) body.passiveCcGezelIds = ccIds;
      await api.sendToChatSession(activeSessionId, body);
      const acceptedTurn = localTurnRef.current;
      if (acceptedTurn?.id === localTurnId) {
        acceptedTurn.accepted = true;
        // Fast mock/local turns can finish before their `done` frame reaches
        // this renderer. Reconcile immediately instead of waiting 2s for the
        // periodic poll.
        void syncInflight(activeSessionId).catch(() => {
          /* the periodic poll remains the recovery path */
        });
      }
      publishOptimisticUserMessage({
        sessionId: activeSessionId,
        gezelId,
        projectId,
        content: userText,
        at: new Date().toISOString(),
      });
      // CC fires once per pivot; tell the parent to drop the list so
      // the next non-pivoting message doesn't carry it forward.
      if (ccIds.length > 0) onPassiveCcConsumed?.();
    } catch (err) {
      ctrl.abort();
      settleLocalTurn(localTurnId);
      const raw = (err as Error).message ?? String(err);
      if (/already in flight/i.test(raw)) {
        // A previous turn is stuck. Pull the details so we can show the
        // user what they're actually waiting on + offer a cancel button.
        try {
          const { inflight } = await api.getChatSessionInflight(activeSessionId);
          if (inflight) {
            setWedged({
              userText: inflight.userText,
              elapsedMs: inflight.elapsedMs,
              sessionId: activeSessionId,
            });
            setError(null);
          } else {
            setError(humanizeChatError(raw));
          }
        } catch {
          setError(humanizeChatError(raw));
        }
      } else {
        // The send POST failing is a renderer↔service transport problem
        // (or an HTTP error the client already labeled) — same treatment
        // as a broken event stream.
        setError(humanizeTransportError(raw));
      }
    }
    await streamPromise;
  }, [
    gezelId,
    projectId,
    turnActive,
    engagementOff,
    ensureSessionId,
    settleLocalTurn,
    syncInflight,
    onToolActivity,
    additionalRecipientIds,
    // Both are read at send-time on every invocation — without them
    // a pivot that updates `passiveCcGezelIds` after the composer
    // first mounted would still send with the stale (empty) list,
    // and `onPassiveCcConsumed` would call a frozen reference if
    // the parent ever swapped it out. The cb is fired only when
    // ccIds is non-empty, so adding it here can't trigger an extra
    // run on idle pivots.
    passiveCcGezelIds,
    onPassiveCcConsumed,
  ]);

  const cancelWedged = useCallback(async () => {
    if (!wedged) return;
    try {
      await api.cancelChatSessionTurn(wedged.sessionId);
    } catch (err) {
      setError(`Cancel failed: ${(err as Error).message}`);
      return;
    }
    setWedged(null);
    setError(null);
  }, [wedged]);

  const stopActiveTurn = useCallback(async () => {
    const sid = liveSessionIdRef.current;
    const localTurn = localTurnRef.current;
    if (localTurn) {
      localTurn.controller.abort();
      settleLocalTurn(localTurn.id);
    } else {
      setStreaming(false);
      setQueuedAhead(null);
    }
    if (!sid) {
      setServerInflight(false);
      return;
    }
    try {
      await api.cancelChatSessionTurn(sid);
      setServerInflight(false);
      setError(null);
    } catch (err) {
      // Keep the authoritative busy state visible when cancellation did not
      // reach the service; the poll will clear it if the turn already ended.
      setError(`Cancel failed: ${(err as Error).message}`);
    }
  }, [settleLocalTurn]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!turnActiveRef.current || event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      void stopActiveTurn();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [stopActiveTurn]);

  /**
   * Mid-turn Nudge: queue the draft behind the running turn. The
   * service holds it as a pending-queue entry (ghost bubble in the
   * timeline, editable + discardable there) and merges contiguous
   * nudges into ONE follow-up turn when the current turn ends. No
   * local SSE or optimistic publish — the server's `queue_enqueued`
   * event reaches the timeline immediately, and this composer stays
   * "busy" through the merged turn via the inflight poll.
   */
  const queueNudge = useCallback(async () => {
    const userText = draftRef.current.trim();
    const sid = liveSessionIdRef.current;
    if (!gezelId || !userText || !sid || engagementOff) return;
    draftRef.current = '';
    setDraftNonEmpty(false);
    setEditorRevision((revision) => revision + 1);
    setMentioned([]);
    setError(null);
    try {
      await api.sendToChatSession(sid, { message: userText, nudge: true });
    } catch (err) {
      // Restore the draft so the user's text isn't lost.
      draftRef.current = userText;
      setDraftNonEmpty(true);
      setEditorRevision((revision) => revision + 1);
      setError(humanizeChatError((err as Error).message ?? String(err)));
    }
  }, [gezelId, engagementOff]);

  /**
   * Interrupt: stop the running turn (partial reply is salvaged, same
   * as Stop) and send the draft immediately, ahead of any queued
   * nudges. Optimistically keep the composer busy — the old turn's
   * `cancelled`/`done` settles the local stream, and without the flag
   * the Send button could flash for up to 2s until the poll sees the
   * replacement turn.
   */
  const interruptWithDraft = useCallback(async () => {
    const userText = draftRef.current.trim();
    const sid = liveSessionIdRef.current;
    if (!gezelId || !userText || !sid || engagementOff) return;
    draftRef.current = '';
    setDraftNonEmpty(false);
    setEditorRevision((revision) => revision + 1);
    setMentioned([]);
    setError(null);
    setServerInflight(true);
    try {
      await api.interruptChatSession(sid, { message: userText });
      void syncInflight(sid).catch(() => {
        /* the periodic poll remains the recovery path */
      });
    } catch (err) {
      draftRef.current = userText;
      setDraftNonEmpty(true);
      setEditorRevision((revision) => revision + 1);
      setError(humanizeChatError((err as Error).message ?? String(err)));
    }
  }, [gezelId, engagementOff, syncInflight]);

  // Enter routing. Squisq reads `submitOnEnter` when the editor mounts;
  // the mid-turn/idle decision must be made at keypress time, not
  // capture time, so the stable closure dereferences this ref. Mid-turn
  // Enter queues a nudge — previously it silently did nothing.
  const submitRef = useRef<() => void>(() => {});
  submitRef.current = turnActive ? () => void queueNudge() : () => void send();

  return (
    <div ref={composerRef} className="chat-composer" data-testid="chat-composer">
      {engagementOff && (
        <div className="chat-composer-disabled-banner" role="alert">
          <span>AI disabled in Settings → General. Chat is paused.</span>
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('gezel:navigate', { detail: { view: 'settings' } }),
              )
            }
          >
            Open Settings
          </button>
        </div>
      )}
      {wedged && (
        <div className="chat-composer-wedged">
          <div className="chat-composer-wedged-head">
            <strong>Previous turn still running</strong>
            <span className="muted"> · {formatElapsed(wedged.elapsedMs)}</span>
          </div>
          <div className="chat-composer-wedged-preview">
            {wedged.userText.length > 180 ? `${wedged.userText.slice(0, 177)}…` : wedged.userText}
          </div>
          <div className="chat-composer-wedged-actions">
            <button type="button" onClick={() => void cancelWedged()}>
              Cancel stuck turn
            </button>
            <button type="button" className="subtle" onClick={() => setWedged(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
      {error && <p className="error chat-composer-error">{error}</p>}
      <div className="chat-composer-to">
        <span className="chat-composer-to-label muted">To:</span>
        <GezelIcon
          svg={gezelIcon ?? null}
          poppetje={gezelPoppetje}
          iconOverride={gezelIconOverride}
          name={gezelName}
          size={18}
        />
        <span className="chat-composer-to-name">{gezelName}</span>
        {additionalRecipients.map((recipient) => {
          const rendered = displayName(
            { name: recipient.name, roleBasedName: recipient.roleBasedName },
            roleBasedNameOnlyMode,
          );
          return (
            <span key={recipient.id} className="chat-composer-to-recipient">
              <GezelIcon
                svg={recipient.icon ?? null}
                poppetje={recipient.poppetje}
                iconOverride={recipient.iconOverride}
                name={rendered}
                size={18}
              />
              <span className="chat-composer-to-name">{rendered}</span>
              <button
                type="button"
                className="chat-composer-recipient-remove"
                aria-label={`Remove ${rendered} from recipients`}
                title={`Remove ${rendered}`}
                onClick={() =>
                  setAdditionalRecipientIds((current) =>
                    current.filter((recipientId) => recipientId !== recipient.id),
                  )
                }
              >
                ×
              </button>
            </span>
          );
        })}
        {mentioned
          .filter(
            (m) =>
              (m.id !== gezelId || m.projectId !== undefined) &&
              !additionalRecipientIds.includes(m.id),
          )
          .map((m) => (
            <span
              key={m.rawId}
              className="chat-composer-to-mention"
              title={m.projectId ? `@${m.label} re: ${m.projectId}` : `@${m.label}`}
            >
              @{m.label}
            </span>
          ))}
        {recipientGezels && onPrimaryRecipientChange && recipientGezels.length > 0 && (
          <ChatRecipientPicker
            gezels={recipientGezels}
            primaryGezelId={gezelId}
            additionalRecipientIds={additionalRecipientIds}
            roleBasedNameOnlyMode={roleBasedNameOnlyMode}
            onSelectPrimary={(nextGezelId) => {
              setAdditionalRecipientIds([]);
              onPrimaryRecipientChange(nextGezelId);
            }}
            onAddRecipient={(nextGezelId) =>
              setAdditionalRecipientIds((current) =>
                nextGezelId === gezelId || current.includes(nextGezelId)
                  ? current
                  : [...current, nextGezelId],
              )
            }
          />
        )}
      </div>
      {belowAddressLine}
      <div className="chat-editor-wrap">
        <EditorShell
          // Squisq installs its Tiptap placeholder extension on mount. Include
          // the active recipient and prompt in the key so changing the To line
          // refreshes that extension. Seed the remount from draftRef so a
          // recipient switch never discards text the user already entered.
          key={`${editorRevision}:${gezelId}:${placeholder ?? ''}`}
          initialMarkdown={draftRef.current}
          // Chat is a single-surface compose flow. Squisq's host mode keeps
          // it in Write and removes the document-oriented view tabs while
          // leaving one semantic hook for future chat-toolbar trimming.
          hostMode="chat"
          mediaProvider={mediaProvider}
          mentionProvider={mentionProvider}
          {...(placeholder ? { placeholder } : {})}
          imageDisplayMode="thumbnail"
          onChange={handleDraftChange}
          minHeight="120px"
          maxHeight="50vh"
          colorScheme={editorTheme}
          uxFont="var(--font-ui)"
          showPlayTab={false}
          showStatusBar={false}
          // Hide the Files-panel toggle — in the chat composer, the
          // "attach a file" affordance is meant to land the image in
          // the message body, not a separate side library. Paste
          // (⌘V), drag-drop into the editor, and the Toolbar's 🖼
          // image button all already insert an image node directly
          // via the MediaProvider.
          showFilesToggle={false}
          fullWidth
          thinMargins
          submitOnEnter={() => submitRef.current()}
          toolbarSlotRight={
            turnActive ? (
              <>
                {draftNonEmpty && !engagementOff && (
                  <>
                    <button
                      type="button"
                      className="chat-send-btn chat-nudge-btn"
                      data-testid="chat-nudge"
                      onClick={() => void queueNudge()}
                      title="Queue for after this turn (Enter)"
                    >
                      Nudge
                    </button>
                    <button
                      type="button"
                      className="chat-interrupt-btn"
                      data-testid="chat-interrupt"
                      onClick={() => void interruptWithDraft()}
                      title="Stop this turn and send now"
                    >
                      Interrupt
                    </button>
                  </>
                )}
                <button
                  type="button"
                  className="chat-stop-btn"
                  onClick={() => void stopActiveTurn()}
                  title="Stop generating (Escape)"
                >
                  ■ Stop
                </button>
              </>
            ) : (
              <button
                type="button"
                className="chat-send-btn"
                data-testid="chat-send"
                onClick={send}
                disabled={!gezelId || engagementOff}
                title={
                  engagementOff
                    ? 'AI is disabled in Settings → General'
                    : `Enter to send, ${newlineShortcutLabel()} for newline`
                }
              >
                Send
              </button>
            )
          }
        />
      </div>
    </div>
  );
}

function sameMentionTokens(a: MentionToken[], b: MentionToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (!left || !right) return false;
    // Compare on `rawId` — the full id including any `?project=…`
    // suffix — so swapping a "@Mira re: A" mention for "@Mira re: B"
    // counts as a change rather than collapsing through the
    // gezel-only id.
    if (left.rawId !== right.rawId || left.label !== right.label) return false;
  }
  return true;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s elapsed`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s elapsed`;
}

/**
 * Translate raw provider errors into something a user can act on. The
 * Copilot SDK surfaces `session.idle` timeouts as a ~60-character
 * technical string; when that fires after the model streamed nothing,
 * the most helpful thing we can say is "retry." Other errors pass
 * through untouched so bugs stay visible.
 */
function humanizeChatError(raw: string): string {
  if (!raw) return raw;
  if (/Timeout\s+after\s+\d+ms\s+waiting\s+for\s+session\.idle/i.test(raw)) {
    return (
      'Copilot stalled without streaming a reply — this usually means ' +
      'the SDK lost its connection. Your message is saved; try Send ' +
      'again, or pick a different model in Settings → Defaults.'
    );
  }
  if (/timed out after \d+s/i.test(raw)) {
    return "The model didn't respond in time. Your message is saved — try " + 'Send again.';
  }
  return raw;
}

/**
 * Translate renderer-side transport failures (the per-turn SSE reader
 * threw, as opposed to the service reporting a turn error) into one
 * actionable sentence. The raw shapes are browser- and layer-specific:
 * Chromium's mid-body break is the bare `network error`, its
 * request-time failure is `Failed to fetch` (Firefox/Safari have their
 * own spellings), and the SSE helper contributes stale-stream /
 * premature-EOF messages. None of them mean anything to a user, and by
 * the time this fires we already retried the connection several times.
 * Only used for errors thrown by the local stream reader — server-sent
 * `error` events go through {@link humanizeChatError} untouched, since
 * a provider-side "fetch failed" points at the model host, not at us.
 */
function humanizeTransportError(raw: string): string {
  const transportShaped =
    /network\s?error/i.test(raw) ||
    /failed to fetch/i.test(raw) ||
    /load failed/i.test(raw) ||
    /transport unavailable/i.test(raw) ||
    /SSE stream (stale|failed)/i.test(raw) ||
    /ended before a terminal event/i.test(raw);
  if (transportShaped) {
    return (
      'Lost the connection to the gezel service and could not reconnect. ' +
      'Your message is saved — if no reply appears, check that the ' +
      'service is running and try Send again.'
    );
  }
  return humanizeChatError(raw);
}
