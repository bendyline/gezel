import {
  type GezelSummary,
  type ReferencedFile,
  type RequestStop,
  type RequestTrack,
  displayName,
  parseTaskRef,
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
}: {
  track: RequestTrack;
  gezels: ReadonlyMap<string, GezelSummary>;
  debugMode?: boolean;
  roleBasedNameOnlyMode?: boolean;
  variant?: 'full' | 'compact';
  /** Opens a file in the thread's own project; other projects open in their own view. */
  onOpenFile?: (file: ReferencedFile) => void;
}) {
  const [kept, setKept] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const nameOf = (id: string | undefined) => {
    const gezel = id ? gezels.get(id) : undefined;
    return gezel
      ? displayName({ name: gezel.name, roleBasedName: gezel.roleBasedName }, roleBasedNameOnlyMode)
      : undefined;
  };
  const lead = track.leadGezelId ? gezels.get(track.leadGezelId) : undefined;
  const leadName = nameOf(track.leadGezelId) ?? 'Your gezel';
  const ready = track.state === 'ready';
  const overdue = track.eta?.overdue === true && !kept;
  const compact = variant === 'compact';
  // The lead hands over the work; debug mode credits who really made it.
  const makerId = debugMode && track.makerGezelId ? track.makerGezelId : track.leadGezelId;
  const maker = makerId ? gezels.get(makerId) : undefined;
  const deliverable = track.deliverable;
  const home = deliverable?.projectId ?? track.projectId;

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
          <GezelIcon
            svg={lead?.icon ?? null}
            poppetje={lead?.poppetje ?? null}
            iconOverride={lead?.iconOverride === true}
            name={leadName}
            size={20}
          />
          <span>
            <strong>{nameOf(track.line.gezelId) ?? leadName}</strong> {track.line.doing}
            {track.parts && !ready ? ` (${track.parts.done} of ${track.parts.total} done)` : ''}
          </span>
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
                    name: nameOf(id) ?? 'A gezel',
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
        message="The crew stops where it is. What it has made so far stays in the project."
        confirmLabel="Stop"
        danger
        onConfirm={stopWork}
        onCancel={() => setConfirmStop(false)}
      />
    </section>
  );
}
