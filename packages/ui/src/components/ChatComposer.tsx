import { EditorShell, type MentionCandidate } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import { parseTaskRef } from '@bendyline/gezel';
import { streamChatEvents } from '@bendyline/gezel-client';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useEffectiveTheme } from '../theme.js';
import { GezelIcon } from './GezelIcon.js';
import { createGezelMediaProvider } from './GezelMediaProvider.js';
import type { ToolActivity } from './chat-bubbles.js';
import { publishOptimisticUserMessage } from './chat-optimistic-events.js';
import { type MentionToken, extractMentionTokens, extractMentions } from './mention-parse.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';

export type ComposerTurnState = 'idle' | 'streaming' | 'queued' | 'error';

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
  const editorTheme = useEffectiveTheme();
  const roleBasedNameOnlyMode = useRoleBasedNameOnlyMode();
  const [streaming, setStreaming] = useState(false);
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
  const editorKeyRef = useRef(0);
  // initialMarkdown piped into the EditorShell. Becomes non-empty
  // only when another view dropped a prefill into the module queue
  // (see `queueComposerPrefill`). We don't reuse `draftRef` for this
  // — EditorShell reads `initialMarkdown` once at mount, so populating
  // the draft alone doesn't appear in the editor. A key bump forces
  // a remount with the new initial content.
  const [initialMarkdown, setInitialMarkdown] = useState<string>('');
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
    setInitialMarkdown(merged);
    editorKeyRef.current += 1;
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
  const streamRef = useRef<AbortController | null>(null);
  // Live session id — initialized from the prop and updated the first time
  // we lazy-create a session (from either a paste or a Send click). Shared
  // between the media provider and the send path so they can't disagree.
  const liveSessionIdRef = useRef<string | null>(sessionId ?? null);
  useEffect(() => {
    liveSessionIdRef.current = sessionId ?? null;
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
            onSessionCreated?.(existing.id);
            return existing.id;
          }
        }
      } else {
        const res = await api.listChatSessions({ gezelId, projectId });
        const existing = res.sessions.find((s) => !s.archived);
        if (existing) {
          liveSessionIdRef.current = existing.id;
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
      streamRef.current?.abort();
      streamRef.current = null;
      mediaProvider.dispose();
    };
  }, [mediaProvider]);

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
        : streaming
          ? 'streaming'
          : 'idle';
    onTurnStateChange?.(state, error ?? undefined);
  }, [streaming, queuedAhead, error, onTurnStateChange]);

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
    if (!gezelId || !userText || streaming) return;
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
    editorKeyRef.current += 1;
    setInitialMarkdown('');
    setMentioned([]);
    setError(null);
    setQueuedAhead(null);

    let activeSessionId: string;
    try {
      activeSessionId = await ensureSessionId();
    } catch (err) {
      setError((err as Error).message);
      return;
    }

    setStreaming(true);

    const ctrl = new AbortController();
    streamRef.current = ctrl;
    const streamPromise = (async () => {
      try {
        for await (const event of streamChatEvents({
          url: api.sessionEventsUrl(activeSessionId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          if (event.type === 'tool') {
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
            setStreaming(false);
            setQueuedAhead(null);
          } else if (event.type === 'done') {
            setStreaming(false);
            setQueuedAhead(null);
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
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          setStreaming(false);
          return;
        }
        setError(humanizeChatError((err as Error).message));
        setStreaming(false);
      }
    })();

    try {
      // Pull any `@[Name](gezel:id)` mentions out of the draft so the
      // service can fan out to each mentioned gezel's own session. The
      // primary recipient (`gezelId`) is excluded server-side — no
      // double-delivery if the user @-mentioned the current chat target.
      const mentionIds = extractMentions(userText);
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
        setError(humanizeChatError(raw));
      }
      setStreaming(false);
    }
    await streamPromise;
  }, [
    gezelId,
    projectId,
    streaming,
    engagementOff,
    ensureSessionId,
    onToolActivity,
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

  return (
    <div className="chat-composer" data-testid="chat-composer">
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
        {mentioned
          .filter((m) => m.id !== gezelId || m.projectId !== undefined)
          .map((m) => (
            <span
              key={m.rawId}
              className="chat-composer-to-mention"
              title={m.projectId ? `@${m.label} re: ${m.projectId}` : `@${m.label}`}
            >
              @{m.label}
            </span>
          ))}
      </div>
      {belowAddressLine}
      <div className="chat-editor-wrap">
        <EditorShell
          key={editorKeyRef.current}
          initialMarkdown={initialMarkdown}
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
          submitOnEnter={() => void send()}
          toolbarSlotRight={
            streaming ? (
              <button
                type="button"
                className="chat-stop-btn"
                onClick={() => {
                  // Tell the server to actually halt the in-flight
                  // turn — without this, only the local SSE consumer
                  // disconnects and the provider keeps generating in
                  // the background (especially noticeable on MLX
                  // where prefill + generation are minutes-long
                  // operations the user wants to bail out of). Best-
                  // effort: a 404/500 here just means the turn is
                  // already done, in which case the local abort
                  // below is enough on its own.
                  const sid = liveSessionIdRef.current;
                  if (sid) {
                    void api.cancelChatSessionTurn(sid).catch(() => {
                      /* server-side cancel is best-effort; the local
                       * abort still flips the UI back to idle */
                    });
                  }
                  streamRef.current?.abort();
                }}
                title="Stop generating (Escape)"
              >
                ■ Stop
              </button>
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
                    : 'Enter to send, ⌘⏎ for newline'
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
