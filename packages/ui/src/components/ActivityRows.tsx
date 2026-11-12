import type {
  GezelSummary,
  ProjectReferencedFile,
  Question,
  ReferencedFile,
  RequestTrack,
} from '@bendyline/gezel';
import type { QueueStatusResponse } from '@bendyline/gezel-client';
import type { ReactNode } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { FileTypeIcon } from './FileTypeIcon.js';
import { GezelIcon } from './GezelIcon.js';
import { useStopActiveChat } from './QueueMeter.js';
import { RequestTracker } from './RequestTracker.js';
import { openProjectFileActions, openTabAction, runNavActions } from './nav-actions.js';
import { requestOutputPaneFullWindow } from './output-pane-maximize.js';
import { useQuestionDraft } from './question-drafts.js';

/**
 * The rows of the Activity panel. Every piece of work reads the same way:
 * a mark (who, or what kind of file), the work in bold, one quiet line of
 * who, where and what is happening, and at most one key. Only a decision
 * opens into a card. The panel used to stack four-line entries and full
 * cards at one weight, three screens deep for sixteen things.
 */

const baseName = (path: string) => path.split('/').pop() || path;

/** Who is on the work: their figure, or a plain dot when there is none to show. */
export function ActivityMark({
  gezel,
  name,
  plain,
  pulsing,
  size = 24,
}: {
  gezel?: GezelSummary | undefined;
  name?: string | undefined;
  /** Names-only mode: no figures anywhere. */
  plain?: boolean;
  pulsing?: boolean;
  size?: number;
}) {
  return (
    <span className="activity-row-mark" aria-hidden="true">
      {gezel && !plain ? (
        <GezelIcon
          svg={gezel.icon ?? null}
          poppetje={gezel.poppetje}
          iconOverride={gezel.iconOverride}
          name={name ?? gezel.name}
          size={size}
          variant="icon"
          pulsing={pulsing ?? false}
        />
      ) : (
        <span className="activity-row-dot" />
      )}
    </span>
  );
}

/** The quiet line: each piece its own span, separated in CSS. */
export function ActivitySub({ parts }: { parts: ReadonlyArray<ReactNode | undefined> }) {
  const shown = parts.filter((part) => part !== undefined && part !== '' && part !== null);
  if (!shown.length) return null;
  return (
    <span className="activity-row-sub">
      {shown.map((part, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of labels
        <span key={index}>{part}</span>
      ))}
    </span>
  );
}

export function ActivityRow({
  mark,
  title,
  sub,
  when,
  whenTitle,
  onOpen,
  openLabel,
  actions,
  children,
  className,
}: {
  mark: ReactNode;
  title: string;
  sub: ReadonlyArray<ReactNode | undefined>;
  /** A short fact set against the right edge: a time, a count. */
  when?: string | undefined;
  whenTitle?: string | undefined;
  /** Makes the whole row one target; `openLabel` says where it goes. */
  onOpen?: (() => void) | undefined;
  openLabel?: string | undefined;
  actions?: ReactNode;
  /** Set under the row's text: a tracker, a step to act on, extra links. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <article className={`activity-row${className ? ` ${className}` : ''}`}>
      {onOpen && (
        <button
          type="button"
          className="activity-row-open"
          aria-label={openLabel}
          title={openLabel}
          onClick={onOpen}
        />
      )}
      {mark}
      <div className="activity-row-text">
        <strong className="activity-row-title">{title}</strong>
        <ActivitySub parts={sub} />
      </div>
      {when && (
        <span className="activity-row-when" title={whenTitle}>
          {when}
        </span>
      )}
      {actions && <span className="activity-row-actions">{actions}</span>}
      {onOpen && !actions && (
        <span className="activity-row-chevron" aria-hidden="true">
          ›
        </span>
      )}
      {children && <div className="activity-row-body">{children}</div>}
    </article>
  );
}

/**
 * A section's long tail on one line: tonight's schedule under Next, what was
 * finished and put away under Ready. Six nightly jobs once stood, four lines
 * each, between the person and the results beneath them.
 */
export function ActivityFold({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count: number;
  hint?: string | undefined;
  children: ReactNode;
}) {
  return (
    <details className="activity-fold">
      <summary>
        <span className="activity-fold-caret" aria-hidden="true" />
        <span className="activity-fold-label">{label}</span>
        <span className="activity-count">{count}</span>
        {hint && <span className="activity-fold-hint">{hint}</span>}
      </summary>
      <div className="activity-fold-body">{children}</div>
    </details>
  );
}

/** "**Autumn flyer** is finished." → "Autumn flyer": what the service called the work. */
function resultName(prompt: string): string | undefined {
  return /^\*\*(.+?)\*\* is /.exec(prompt.trim())?.[1];
}

/** The files a finished-work card lists, in its order. */
function resultFiles(question: Question): Array<{ path: string; file?: ProjectReferencedFile }> {
  // `\x60` is a backtick: the card lists each file as a code span.
  const named = [...question.prompt.matchAll(/^- \*{0,2}\x60([^\x60]+)\x60\*{0,2}\s*$/gm)].map(
    (match) => match[1]!,
  );
  return named.map((path) => {
    const file = question.referencedFiles?.find((candidate) => candidate.path === path);
    return file ? { path, file } : { path };
  });
}

/**
 * Finished work, as one row: what was made, the files, and Open. Putting it
 * away moves it under "Finished earlier" rather than out of the panel. The
 * same card used to stand 210px tall to say a flyer was done.
 */
export function ActivityResultRow({
  question,
  title,
  project,
  onAnswered,
  onOpenInChat,
  onNavigate,
}: {
  question: Question;
  /** The task's own title, used when the card does not name the work. */
  title: string;
  project?: string | undefined;
  onAnswered: (question: Question) => void;
  onOpenInChat: (question: Question) => void;
  onNavigate: () => void;
}) {
  const [submitting, setSubmitting] = useQuestionDraft(question.id, 'submitting', () => false);
  const [error, setError] = useQuestionDraft<string | null>(question.id, 'error', () => null);
  const name = resultName(question.prompt) ?? title;
  const files = resultFiles(question);
  const openable = files.find((entry) => entry.file)?.file;
  const openFile = (file: ProjectReferencedFile) => {
    runNavActions(
      openProjectFileActions({
        projectId: file.projectId ?? question.projectId,
        path: file.path,
        source: file.kind === 'workspace' ? 'workspace' : 'artifacts',
        fromQuestion: true,
      }),
    );
    onNavigate();
  };
  const dismiss = async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onAnswered(await api.answerQuestion(question.id, { selectedChoices: [0] }));
    } catch (err) {
      setError(apiErrorMessage(err));
      setSubmitting(false);
    }
  };
  // With a file to open, the row itself leads to the conversation that
  // delivered it, like every other row; without one, that is the row's key.
  const toChat = Boolean(question.sessionId);
  return (
    <ActivityRow
      className="activity-result"
      mark={
        <span className="activity-row-mark activity-row-mark-file" aria-hidden="true">
          {files[0] ? <FileTypeIcon name={files[0].path} /> : <span className="activity-row-dot" />}
        </span>
      }
      title={name}
      sub={[
        files[0] ? baseName(files[0].path) : undefined,
        files.length > 1 ? `+${files.length - 1} more` : undefined,
        project,
        formatRelativeTime(question.createdAt),
      ]}
      onOpen={openable && toChat ? () => onOpenInChat(question) : undefined}
      openLabel={`Open the chat for ${name}`}
      actions={
        <>
          {openable ? (
            <button type="button" className="btn secondary" onClick={() => openFile(openable)}>
              Open
            </button>
          ) : (
            question.sessionId && (
              <button
                type="button"
                className="btn secondary"
                disabled={submitting}
                onClick={() => onOpenInChat(question)}
              >
                Open in chat
              </button>
            )
          )}
          <button
            type="button"
            className="activity-row-dismiss"
            aria-label={`Dismiss ${name}`}
            title="Put away. It stays under Finished earlier."
            disabled={submitting}
            onClick={() => void dismiss()}
          >
            ×
          </button>
        </>
      }
    >
      {error && (
        <p className="activity-row-error" role="alert">
          {error}
        </p>
      )}
    </ActivityRow>
  );
}

/** A request that finished and was put away: the record of what was made. */
export function ActivityEarlierRow({
  track,
  project,
  onOpenChat,
  onNavigate,
}: {
  track: RequestTrack;
  project?: string | undefined;
  onOpenChat: (sessionId: string) => void;
  onNavigate: () => void;
}) {
  const name = track.title ?? track.summary;
  const deliverable = track.deliverable;
  const at = deliverable?.modifiedAt ?? track.at;
  const open = () => {
    if (!deliverable) {
      onOpenChat(track.sessionId);
      return;
    }
    const home = deliverable.projectId ?? track.projectId;
    if (deliverable.view === 'output-page') {
      requestOutputPaneFullWindow(home);
      runNavActions([openTabAction({ kind: 'project', id: home })]);
    } else {
      const file: ReferencedFile = deliverable;
      runNavActions(
        openProjectFileActions({
          projectId: home,
          path: file.path,
          source: file.kind === 'artifact' ? 'artifacts' : 'workspace',
        }),
      );
    }
    onNavigate();
  };
  return (
    <ActivityRow
      className="activity-earlier"
      mark={
        <span className="activity-row-mark activity-row-mark-file" aria-hidden="true">
          {deliverable && deliverable.view !== 'output-page' ? (
            <FileTypeIcon name={deliverable.path} />
          ) : (
            <span className="activity-row-dot" />
          )}
        </span>
      }
      title={name}
      sub={[
        deliverable && deliverable.view !== 'output-page' ? baseName(deliverable.path) : undefined,
        project,
      ]}
      when={formatRelativeTime(at)}
      whenTitle={formatAbsoluteTime(at)}
      onOpen={open}
      openLabel={deliverable ? `Open ${name}` : `Open the chat for ${name}`}
    />
  );
}

/**
 * A person's request under way: their words, the tracker, and Stop. It
 * stands for every session working on it, so the engine's own rows for
 * those sessions are left out (see `selectQueueRows`): one request used to
 * read twice in Working, once as "Toan · Developer" and once as the lead.
 */
export function ActivityRequestRow({
  track,
  title,
  project,
  gezels,
  queues,
  namesOnly,
  onOpenChat,
  onChanged,
}: {
  track: RequestTrack;
  title: string;
  project?: string | undefined;
  gezels: Map<string, GezelSummary>;
  queues: QueueStatusResponse;
  namesOnly: boolean;
  onOpenChat?: (() => void) | undefined;
  onChanged: () => void;
}) {
  const { stopping, stop } = useStopActiveChat(onChanged);
  const live = new Set(track.liveSessionIds);
  const running = Object.values(queues.providers).flatMap((provider) =>
    (provider?.active ?? []).flatMap((row) =>
      row.sessionId && live.has(row.sessionId) && !row.sessionId.startsWith('dev:')
        ? [row.sessionId]
        : [],
    ),
  );
  const isStopping = running.some((sessionId) => stopping.has(sessionId));
  const lead = track.leadGezelId ? gezels.get(track.leadGezelId) : undefined;
  return (
    <ActivityRow
      className="activity-request"
      mark={
        <ActivityMark
          gezel={lead}
          plain={namesOnly}
          pulsing={track.state === 'working' && running.length > 0}
        />
      }
      title={title}
      sub={[project]}
      actions={
        <>
          {running.length > 0 && (
            <button
              type="button"
              className="queue-meter-panel-action queue-meter-panel-action-stop"
              aria-label={`Stop work on ${title}`}
              disabled={isStopping}
              onClick={() => {
                for (const sessionId of running) void stop(sessionId);
              }}
            >
              {isStopping ? 'Stopping…' : '■ Stop'}
            </button>
          )}
          {onOpenChat && (
            <button type="button" className="btn secondary" onClick={onOpenChat}>
              Open chat
            </button>
          )}
        </>
      }
    >
      <RequestTracker
        track={track}
        gezels={gezels}
        variant="compact"
        roleBasedNameOnlyMode={namesOnly}
      />
    </ActivityRow>
  );
}
