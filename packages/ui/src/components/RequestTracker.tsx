import {
  type GezelSummary,
  type ReferencedFile,
  type RequestStop,
  type RequestTrack,
  displayName,
  parseTaskRef,
  plainRoleTitle,
  taskPausedReasonText,
} from '@bendyline/gezel';
import { useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { CrewMemberCard } from './CrewMemberCard.js';
import { DeliverableCard } from './DeliverableCard.js';
import { GezelIcon } from './GezelIcon.js';
import {
  navigateToTab,
  openProjectFileActions,
  openTabAction,
  runNavActions,
} from './nav-actions.js';
import { requestOutputPaneFullWindow } from './output-pane-maximize.js';
import '../styles/request-tracker.css';

const STOPS: ReadonlyArray<{ stop: RequestStop; label: string }> = [
  { stop: 'got-it', label: 'Got it' },
  { stop: 'making', label: 'Making it' },
  { stop: 'checking', label: 'Checking it' },
  { stop: 'ready', label: 'Ready' },
];

function stopStatus(track: RequestTrack, index: number): 'done' | 'active' | 'pending' {
  const at = STOPS.findIndex((s) => s.stop === track.stop);
  if (index < at || (index === at && track.stop === 'ready')) return 'done';
  return index === at ? 'active' : 'pending';
}

/**
 * Who joined the crew for this request, in the lead's words: "Ngoc brought
 * Elettra (Researcher) and Shanti (Copywriter) onto your crew for this."
 * Their introductions fold into the tracker, so without this line a new crew
 * member arrived unannounced.
 */
function joinedSentence(names: readonly string[], leadName: string | undefined) {
  if (names.length === 0) return undefined;
  const list =
    names.length === 1
      ? names[0]!
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return leadName
    ? `${leadName} brought ${list} onto your crew for this.`
    : `${list} joined your crew for this.`;
}

/**
 * One person message and everything working on it, as one card in the
 * thread: four fixed stops (Got it → Making it → Checking it → Ready), one
 * plain line in the lead's voice, an honest estimate, and at Ready the file
 * they asked for. The crew is one click away under "Who's helping?". The
 * lead speaks for the crew here; debug mode adds who is really on which
 * step. Replaced, for one invoice, three craftbook cards, five
 * introductions, a silence banner and a task id.
 *
 * `compact` is the Activity row: the stops and the line, nothing to open.
 */
export function RequestTracker({
  track,
  gezels,
  debugMode = false,
  roleBasedNameOnlyMode = false,
  variant = 'full',
  onOpenFile,
  projectName,
}: {
  track: RequestTrack;
  gezels: ReadonlyMap<string, GezelSummary>;
  debugMode?: boolean;
  roleBasedNameOnlyMode?: boolean;
  variant?: 'full' | 'compact';
  /** Opens a file in the thread's own project; other projects open in their own view. */
  onOpenFile?: (file: ReferencedFile) => void;
  /** The name of the project the finished work lives in; a board's card leads with it. */
  projectName?: string;
}) {
  const [kept, setKept] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  const nameOf = (id: string | undefined) => {
    const gezel = id ? gezels.get(id) : undefined;
    return gezel
      ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
      : undefined;
  };
  const lead = track.leadGezelId ? gezels.get(track.leadGezelId) : undefined;
  const leadName = nameOf(track.leadGezelId) ?? 'Gezel';
  const ready = track.state === 'ready';
  const overdue = track.eta?.overdue === true && !kept;
  const compact = variant === 'compact';
  // The lead hands over the work; debug mode credits who really made it.
  const makerId = debugMode && track.makerGezelId ? track.makerGezelId : track.leadGezelId;
  const maker = makerId ? gezels.get(makerId) : undefined;
  const deliverable = track.deliverable;
  const home = deliverable?.projectId ?? track.projectId;
  const joined = joinedSentence(
    (track.joined ?? []).flatMap((id) => {
      const name = nameOf(id);
      if (!name) return [];
      const role = gezels.get(id)?.role?.trim();
      return [role && !roleBasedNameOnlyMode ? `${name} (${plainRoleTitle(role)})` : name];
    }),
    lead ? leadName : undefined,
  );

  const openDeliverable = (file: ReferencedFile) => {
    if (deliverable?.view === 'output-page') {
      requestOutputPaneFullWindow(home);
      runNavActions([openTabAction({ kind: 'project', id: home })]);
      return;
    }
    if (home === track.projectId && onOpenFile) {
      onOpenFile(file);
      return;
    }
    runNavActions(
      openProjectFileActions({
        projectId: home,
        path: file.path,
        source: file.kind === 'artifact' ? 'artifacts' : 'workspace',
      }),
    );
  };

  // The runtime closes its own pause card once the task leaves paused, so
  // restarting the task is the whole of "Try again".
  const tryAgain = async () => {
    const parsed = track.paused ? parseTaskRef(track.paused.taskRef) : null;
    if (!parsed || retrying) return;
    setRetrying(true);
    setRetryNote(null);
    try {
      const result = await api.retryTask(parsed.projectId, parsed.num);
      if (!result.dispatched && result.reason && result.reason !== 'not-paused') {
        setRetryNote(
          "It's set to go again, but nothing could pick it up. Open the task to see why.",
        );
      }
    } catch {
      setRetryNote("That didn't start. Try again in a moment.");
    } finally {
      setRetrying(false);
    }
  };

  const stopWork = async () => {
    for (const ref of track.taskRefs) {
      const parsed = parseTaskRef(ref);
      if (!parsed) continue;
      await api.setTaskStatus(parsed.projectId, parsed.num, 'canceled').catch(() => undefined);
    }
    setConfirmStop(false);
  };

  return (
    <section
      className={`request-tracker${compact ? ' request-tracker-compact' : ''}`}
      data-testid="request-tracker"
      data-request-key={track.key}
      data-state={track.state}
      aria-label="Progress on your request"
    >
      <ol className="request-tracker-stops">
        {STOPS.map((s, index) => {
          const status = stopStatus(track, index);
          return (
            <li
              key={s.stop}
              className={`request-tracker-stop is-${status}`}
              aria-current={status === 'active' ? 'step' : undefined}
            >
              <span className="request-tracker-dot" aria-hidden="true" />
              <span className="request-tracker-label">{s.label}</span>
            </li>
          );
        })}
      </ol>
      {track.line && (
        <p className="request-tracker-line">
          {/* A lead hired moments ago is not in the roster yet: no letter in
              place of the figure that is about to load. */}
          <GezelIcon
            svg={lead?.icon ?? null}
            poppetje={lead?.poppetje ?? null}
            iconOverride={lead?.iconOverride === true}
            name={leadName}
            size={20}
            {...(lead ? {} : { pending: true })}
          />
          <span>
            <strong>{nameOf(track.line.gezelId) ?? leadName}</strong> {track.line.doing}
            {track.parts && !ready ? ` (${track.parts.done} of ${track.parts.total} done)` : ''}
          </span>
        </p>
      )}
      {!compact && track.paused && (
        <div className="request-tracker-paused" data-testid="request-tracker-paused">
          <span>
            {track.paused.reason ? `${taskPausedReasonText(track.paused.reason)} ` : ''}
            What it made so far is kept.
          </span>
          <button
            type="button"
            className="gz-key"
            onClick={() => void tryAgain()}
            disabled={retrying}
          >
            {retrying ? 'Starting…' : track.paused.reason ? 'Try again' : 'Carry on'}
          </button>
          {retryNote && <span className="request-tracker-paused-note">{retryNote}</span>}
        </div>
      )}
      {!compact && joined && (
        <p className="request-tracker-joined" data-testid="request-tracker-joined">
          {joined}
        </p>
      )}
      {debugMode && track.actual && (
        <p className="request-tracker-actual">
          {[nameOf(track.actual.gezelId), track.actual.stepName, track.actual.taskRef]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {!compact && overdue && (
        <div className="request-tracker-overdue">
          <span>Taking longer than usual.</span>
          <button type="button" className="gz-key" onClick={() => setKept(true)}>
            Keep waiting
          </button>
          <button type="button" className="gz-key" onClick={() => setConfirmStop(true)}>
            Stop
          </button>
        </div>
      )}
      {track.eta && !ready && !overdue && (
        <p className="request-tracker-eta">{kept ? 'Still working on it' : track.eta.text}</p>
      )}
      {!compact && ready && deliverable && (
        <DeliverableCard
          deliverable={deliverable}
          projectId={home}
          onOpen={openDeliverable}
          {...(track.title ? { title: track.title } : {})}
          {...(projectName ? { projectName } : {})}
          {...(maker && makerId
            ? {
                maker: {
                  name: nameOf(makerId) ?? maker.name,
                  icon: maker.icon ?? null,
                  poppetje: maker.poppetje ?? null,
                  iconOverride: maker.iconOverride === true,
                },
                onMakeChanges: () => navigateToTab({ kind: 'gezel', id: makerId }),
              }
            : {})}
        />
      )}
      {!compact && (track.crew.length > 0 || track.taskRefs.length > 0) && (
        <details className="request-tracker-more">
          <summary>{track.crew.length > 0 ? "Who's helping?" : 'Details'}</summary>
          {track.crew.length > 0 && (
            <ul className="msg-crew-intro-cards">
              {track.crew.map((id) => (
                <CrewMemberCard
                  key={id}
                  member={{
                    gezelId: id,
                    name: nameOf(id) ?? 'Crew member',
                    ...(gezels.get(id)?.role ? { role: gezels.get(id)!.role! } : {}),
                  }}
                  {...(gezels.get(id) ? { gezel: gezels.get(id)! } : {})}
                />
              ))}
            </ul>
          )}
          {track.taskRefs[0] && (
            <button
              type="button"
              className="gz-key request-tracker-open-task"
              onClick={() => navigateToTab({ kind: 'task', ref: track.taskRefs[0]! })}
            >
              {debugMode ? `Task ${track.taskRefs[0]}` : 'Open the task'}
            </button>
          )}
        </details>
      )}
      <ConfirmDialog
        open={confirmStop}
        title="Stop this work?"
        message="Gezel stops where it is. What it has made so far stays in the project."
        confirmLabel="Stop"
        danger
        onConfirm={stopWork}
        onCancel={() => setConfirmStop(false)}
      />
    </section>
  );
}
