import {
  type ActivityItem,
  type ActivitySection,
  type Question,
  displayName,
  isReadyQuestion,
} from '@bendyline/gezel';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Dialog } from '../primitives/index.js';
import { requestSettingsSection } from '../settings-nav.js';
import {
  ActivityEarlierRow,
  ActivityFold,
  ActivityMark,
  ActivityRequestRow,
  ActivityResultRow,
  ActivityRow,
  ActivitySub,
} from './ActivityRows.js';
import { GezelIcon } from './GezelIcon.js';
import {
  type QueueRowContext,
  type QueueRowSelection,
  QueueSessionRows,
  openQueuedChat,
  selectQueueRows,
  useQueueLiveTurns,
} from './QueueMeter.js';
import { useActivity } from './activity-context.js';
import { useHeaderDensity } from './header-density.js';
import { OPEN_UPDATES_EVENT, type OpenActivityIntent, navigateToTab } from './nav-actions.js';
import { QuestionDraftProvider } from './question-drafts.js';
import { openQuestionInChat } from './question-nav.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import '../styles/activity.css';

const PendingQuestionCard = lazy(() =>
  import('./PendingQuestionCard.js').then((module) => ({ default: module.PendingQuestionCard })),
);

const ActivityTaskStep = lazy(() =>
  import('./ActivityTaskStep.js').then((module) => ({ default: module.ActivityTaskStep })),
);

// A soft traffic light: decisions, work in motion, finished results.
type SectionTone = 'attention' | 'active' | 'quiet' | 'done';

// A decision leads, then what is running now, then what is finished; the
// waiting and scheduled work closes the panel. Ready used to sit last, under
// every scheduled job, so the results were the furthest thing from the top.
const SECTIONS: { id: ActivitySection; label: string; empty: string; tone: SectionTone }[] = [
  {
    id: 'needs-you',
    label: 'Needs you',
    empty: 'Nothing needs your attention.',
    tone: 'attention',
  },
  { id: 'working', label: 'Working', empty: 'No work is running right now.', tone: 'active' },
  { id: 'ready', label: 'Ready', empty: 'New results will appear here.', tone: 'done' },
  { id: 'next', label: 'Next', empty: 'Nothing waiting or scheduled.', tone: 'quiet' },
];

/** Scheduled work past this many rows folds into one line under Next. */
const SCHEDULED_FOLD_AFTER = 2;

const ISO_TIME = /\d{4}-\d{2}-\d{2}T[\d:.]+Z/;

function countSection(items: ActivityItem[], section: ActivitySection) {
  return items
    .filter((item) => item.section === section)
    .reduce((sum, item) => sum + Math.max(1, item.questionIds.length), 0);
}

export function ActivityControl() {
  const activity = useActivity();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string | undefined>();
  const [sectionRequest, setSectionRequest] = useState<{ section: ActivitySection } | null>(null);
  const [navigationError, setNavigationError] = useState<string | null>(null);
  const density = useHeaderDensity();
  const boringMode = useRoleBasedNameOnlyMode();
  const closeRef = useRef<HTMLButtonElement>(null);
  const order = useRef(new Map<string, number>());
  const clearReceipts = activity?.clearReceipts;
  useEffect(() => {
    if (!open) clearReceipts?.();
  }, [open, clearReceipts]);
  const snapshot = activity?.snapshot;
  const hasSnapshot = !!snapshot;
  useEffect(() => {
    if (!open || !sectionRequest || !hasSnapshot) return;
    let observer: ResizeObserver | undefined;
    // Wait for the portal, then keep the destination visible as lazy cards
    // above it grow. The first user interaction releases this anchoring.
    const frame = requestAnimationFrame(() => {
      const section = document.getElementById(`activity-${sectionRequest.section}`);
      if (!section) return;
      section.querySelector('h3')?.focus({ preventScroll: true });
      const scrollToSection = () => section.scrollIntoView({ block: 'start' });
      scrollToSection();
      observer = new ResizeObserver(scrollToSection);
      for (const sibling of section.parentElement?.children ?? []) observer.observe(sibling);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [open, sectionRequest, hasSnapshot]);
  const allItems = snapshot?.items ?? [];
  const { liveTurns, preparingTurns, onDeviceProvider } = useQueueLiveTurns(open, snapshot?.queues);
  const needs = countSection(allItems, 'needs-you');
  const working = countSection(allItems, 'working');
  const next = countSection(
    allItems.filter((item) => !item.scheduled),
    'next',
  );
  const ready = countSection(allItems, 'ready');
  const held = allItems.some((item) => item.heldByActivity);
  const headline = activity?.stale
    ? 'Status unavailable'
    : !snapshot
      ? 'Checking…'
      : needs
        ? `${needs} need${needs === 1 ? 's' : ''} you${working ? ` · ${working} working` : ''}`
        : working
          ? `${working} working${held ? ' · automatic work paused' : ''}`
          : held
            ? 'Automatic work paused'
            : ready
              ? `${ready} ready`
              : next
                ? `${next} waiting or scheduled`
                : 'All quiet';
  // What the key itself says: the same state in few enough words to fit its
  // fixed width. The whole sentence stays in its accessible name and tooltip.
  const keyHeadline = activity?.stale
    ? 'Unavailable'
    : !snapshot
      ? 'Checking…'
      : needs
        ? `${needs} need${needs === 1 ? 's' : ''} you`
        : working
          ? `${working} working`
          : held
            ? 'Paused'
            : ready
              ? `${ready} ready`
              : next
                ? `${next} waiting`
                : 'All quiet';

  useEffect(() => {
    const openUpdates = (event: Event) => {
      window.dispatchEvent(new Event('gezel:close-header-popovers'));
      const intent = (event as CustomEvent<OpenActivityIntent>).detail;
      setProjectId(intent?.projectId);
      setSectionRequest(intent?.section ? { section: intent.section } : null);
      setOpen(true);
    };
    const close = () => setOpen(false);
    window.addEventListener(OPEN_UPDATES_EVENT, openUpdates);
    window.addEventListener('gezel:close-header-popovers', close);
    return () => {
      window.removeEventListener(OPEN_UPDATES_EVENT, openUpdates);
      window.removeEventListener('gezel:close-header-popovers', close);
    };
  }, []);
  if (!activity) return null;
  const { gezels, projects, stale, receipts } = activity;
  const activeRows = Object.values(snapshot?.queues.providers ?? {}).flatMap(
    (provider) => provider?.active ?? [],
  );
  // Background indexing has a named worker but no chat session; its
  // activity item is only an anonymous "background:running" summary.
  // Include those queue owners just as the panel does. Request rows can
  // also stand for several turns, whose workers take precedence over the lead.
  const workingIds = [
    ...activeRows.flatMap((row) => (row.gezelId ? [row.gezelId] : [])),
    ...allItems
      .filter((item) => item.section === 'working')
      .flatMap((item) => {
        const request = item.requestKey
          ? snapshot?.requests?.find((request) => request.key === item.requestKey)
          : undefined;
        const sessions = new Set(request?.liveSessionIds ?? [item.sessionId]);
        const runningIds = activeRows.flatMap((row) =>
          row.sessionId && row.gezelId && sessions.has(row.sessionId) ? [row.gezelId] : [],
        );
        return runningIds.length ? runningIds : item.gezelId ? [item.gezelId] : [];
      }),
  ];
  const workingGezels =
    !needs && !stale
      ? [...new Set(workingIds)].map((id) => gezels.get(id)).filter((gezel) => gezel !== undefined)
      : [];
  const workingGezel = workingGezels[0];
  const workingName = workingGezel ? displayName(workingGezel, boringMode) : undefined;
  const showWorking = !needs && !stale && working > 0;
  const accessibleHeadline = workingGezel
    ? `${headline} · ${workingGezels.map((gezel) => displayName(gezel, boringMode)).join(', ')}`
    : headline;
  const items = allItems.filter((item) => !projectId || item.projectId === projectId);
  const pendingQuestions = snapshot?.questions ?? [];
  const pendingIds = new Set(pendingQuestions.map((q) => q.id));
  const questions = [...pendingQuestions, ...receipts.filter((q) => !pendingIds.has(q.id))].filter(
    (q) => !projectId || q.projectId === projectId,
  );
  for (const entry of [...items, ...questions]) {
    if (!order.current.has(entry.id)) order.current.set(entry.id, order.current.size);
  }
  const sortedQuestions = questions.sort(
    (a, b) => order.current.get(a.id)! - order.current.get(b.id)!,
  );
  const sortedItems = [...items].sort(
    (a, b) => order.current.get(a.id)! - order.current.get(b.id)!,
  );
  const projectName = (id: string | undefined) => (id ? (projects.get(id)?.name ?? id) : undefined);
  const gezelOf = (id: string | undefined) => (id ? gezels.get(id) : undefined);
  const nameOf = (id: string | undefined) => {
    const gezel = gezelOf(id);
    return gezel ? displayName(gezel, boringMode) : undefined;
  };
  const openChat = async (sessionId: string) => {
    setNavigationError(null);
    try {
      if (!(await openQueuedChat(sessionId, () => setOpen(false)))) {
        setNavigationError('Could not open this conversation. Please try again.');
      }
    } catch {
      setNavigationError('Could not open this conversation. Please try again.');
    }
  };
  const onOpenChange = (value: boolean) => {
    if (value) {
      window.dispatchEvent(new Event('gezel:close-header-popovers'));
      setProjectId(undefined);
      setSectionRequest(null);
      setNavigationError(null);
      activity.refresh();
    }
    setOpen(value);
  };
  const openItem = async (item: ActivityItem) => {
    setNavigationError(null);
    if (item.taskRef) {
      navigateToTab({ kind: 'task', ref: item.taskRef });
      setOpen(false);
    } else if (item.sessionId) await openChat(item.sessionId);
  };
  // The gezels on an engine right now, and the ones waiting for a slot, as
  // the same rows (Stop, reorder, cancel) the header queue used to show.
  // Each row stands in for its activity entry, so the work appears once.
  // A request's tracker stands for every session working on it, so the
  // engine's own rows for those sessions are left out.
  const tracked = new Set(
    allItems.flatMap((item) =>
      item.requestKey
        ? (snapshot?.requests?.find((request) => request.key === item.requestKey)?.liveSessionIds ??
          [])
        : [],
    ),
  );
  const queueRows: Partial<Record<ActivitySection, QueueRowSelection>> = snapshot
    ? {
        working: selectQueueRows(snapshot.queues, 'running', preparingTurns, projectId, tracked),
        next: selectQueueRows(snapshot.queues, 'waiting', preparingTurns, projectId, tracked),
      }
    : {};
  const representedByQueue = (item: ActivityItem) => {
    const rows = queueRows[item.section];
    if (!rows) return false;
    // Sessionless engine work is listed row by row, so its summary goes.
    if (item.id.startsWith('background:')) return true;
    return item.sessionId !== undefined && rows.sessionIds.has(item.sessionId);
  };
  const itemBySession = new Map(
    allItems.flatMap((item) => (item.sessionId ? [[item.sessionId, item] as const] : [])),
  );
  const rowContext: QueueRowContext = (sessionId) => {
    const item = itemBySession.get(sessionId);
    if (!item) return undefined;
    return item.taskRef
      ? {
          title: item.title,
          open: () => void openItem(item),
          openLabel: `View task details for ${item.title}`,
        }
      : { title: item.title };
  };
  const answer = (question: Question) => {
    activity.answered(question);
    // Keep keyboard focus with the answer receipt instead of losing it to body.
    requestAnimationFrame(() =>
      document.getElementById(`activity-question-${question.id}`)?.focus(),
    );
  };
  return (
    <QuestionDraftProvider>
      <Dialog.Root open={open} onOpenChange={onOpenChange} modal={false}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            className={`activity-control${needs ? ' needs-attention' : showWorking ? ' is-working' : ''}${showWorking ? ' has-worker' : ''}`}
            data-density={density}
            aria-label={`Activity — ${accessibleHeadline}`}
            title={`What's going on · ${accessibleHeadline}`}
          >
            <span aria-hidden="true" className="activity-control-dot" />
            {!showWorking && <span className="activity-control-label">Activity</span>}
            {showWorking ? (
              <span className="activity-control-worker" aria-hidden="true">
                {!boringMode && workingGezels.length > 0 && (
                  <span className="activity-control-avatars">
                    {workingGezels.slice(0, 3).map((gezel) => (
                      <span className="activity-control-avatar" key={gezel.id}>
                        <GezelIcon
                          svg={gezel.icon ?? null}
                          poppetje={gezel.poppetje}
                          iconOverride={gezel.iconOverride}
                          name={gezel.name}
                          size={18}
                          variant="icon"
                        />
                      </span>
                    ))}
                  </span>
                )}
                <span className="activity-control-worker-name">{workingName ?? 'Working…'}</span>
                {workingGezels.length > 1 && (
                  <span className="activity-control-more">+{workingGezels.length - 1}</span>
                )}
                <span className="activity-control-dots">
                  <span />
                  <span />
                  <span />
                </span>
              </span>
            ) : (
              <span className="activity-control-summary">{keyHeadline}</span>
            )}
            <span className="activity-control-count" aria-hidden="true">
              {needs || workingGezels.length || working || ready || next || '·'}
            </span>
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Content
            className="activity-panel"
            aria-describedby="activity-description"
            onPointerDownCapture={() => setSectionRequest(null)}
            onWheelCapture={() => setSectionRequest(null)}
            onTouchMoveCapture={() => setSectionRequest(null)}
            onKeyDownCapture={() => setSectionRequest(null)}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              closeRef.current?.focus();
            }}
          >
            <div className="activity-panel-header">
              <div>
                <Dialog.Title>What’s going on</Dialog.Title>
                {/* Every row names its project, so the scope is said aloud
                    only when the panel is held to one. */}
                <Dialog.Description
                  id="activity-description"
                  className={projectId ? undefined : 'sr-only'}
                >
                  {projectId ? projectName(projectId) : 'Across all your projects'}
                </Dialog.Description>
                {projectId && (
                  <button
                    type="button"
                    className="gz-link-button activity-all-projects"
                    onClick={() => setProjectId(undefined)}
                  >
                    Show all projects
                  </button>
                )}
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="btn secondary"
                  ref={closeRef}
                  aria-label="Close Activity"
                >
                  ×
                </button>
              </Dialog.Close>
            </div>
            <div className="activity-section-links" aria-label="Activity sections">
              {SECTIONS.map(({ id, label, tone }) => {
                const count = countSection(items, id);
                return (
                  <button
                    type="button"
                    className="btn secondary"
                    key={id}
                    data-section={id}
                    data-tone={tone}
                    data-lit={count > 0 || undefined}
                    onClick={() => setSectionRequest({ section: id })}
                  >
                    <span aria-hidden="true" className="activity-light" />
                    {label} <span className="activity-count">{count}</span>
                  </button>
                );
              })}
            </div>
            <div className="activity-panel-scroll">
              {stale && (
                <div className="activity-warning" aria-live="polite">
                  <strong>Status could not be refreshed.</strong>
                  <p>
                    {snapshot
                      ? `Showing the last update from ${new Date(snapshot.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Work may have changed.`
                      : 'We cannot tell what is running yet.'}
                  </p>
                  <button
                    type="button"
                    className="btn"
                    disabled={activity.refreshing}
                    onClick={activity.refresh}
                  >
                    {activity.refreshing ? 'Checking…' : 'Try again'}
                  </button>
                </div>
              )}
              {!snapshot && !stale && <output>Checking your work…</output>}
              {navigationError && <p role="alert">{navigationError}</p>}
              {snapshot &&
                SECTIONS.map(({ id, label, empty, tone }) => {
                  const listed = sortedItems.filter(
                    (item) =>
                      item.section === id && !item.questionIds.length && !representedByQueue(item),
                  );
                  const rows = listed.filter((item) => !item.scheduled);
                  // The standing schedule is not what is going on now: past a
                  // couple of rows it is one line the person can open.
                  const later = listed.filter((item) => item.scheduled);
                  const foldLater = later.length > SCHEDULED_FOLD_AFTER;
                  const firstLater = later
                    .flatMap((item) => ISO_TIME.exec(item.detail)?.[0] ?? [])
                    .sort()[0];
                  const crew = queueRows[id];
                  const inSection = sortedQuestions.filter(
                    (q) => id === (isReadyQuestion(q) ? 'ready' : 'needs-you'),
                  );
                  // The night's summary leads Ready; each result is a row beneath it.
                  const isResult = (q: Question) => q.intent?.kind === 'task-finished';
                  const cards = [
                    ...inSection.filter((q) => !isResult(q)),
                    ...inSection.filter(isResult),
                  ];
                  const earlier =
                    id === 'ready'
                      ? (snapshot.earlier ?? []).filter(
                          (track) => !projectId || track.projectId === projectId,
                        )
                      : [];
                  const isEmpty = !listed.length && !cards.length && !crew?.count;
                  const renderItem = (item: ActivityItem, folded = false) => {
                    const project = projectName(item.projectId);
                    // A person's request reads as its tracker, opened at their thread.
                    const track = item.requestKey
                      ? snapshot.requests?.find((r) => r.key === item.requestKey)
                      : undefined;
                    if (track) {
                      return (
                        <ActivityRequestRow
                          key={item.id}
                          track={track}
                          title={item.title}
                          project={project}
                          gezels={gezels}
                          queues={snapshot.queues}
                          namesOnly={boringMode}
                          onOpenChat={
                            item.sessionId ? () => void openChat(item.sessionId!) : undefined
                          }
                          onChanged={activity.refresh}
                        />
                      );
                    }
                    const mark = (
                      <ActivityMark
                        gezel={gezelOf(item.gezelId)}
                        plain={boringMode}
                        pulsing={item.section === 'working'}
                      />
                    );
                    if (item.section === 'needs-you' && item.taskRef) {
                      return (
                        <ActivityRow
                          key={item.id}
                          mark={mark}
                          title={item.title}
                          sub={[nameOf(item.gezelId), project]}
                        >
                          <Suspense fallback={<p>Loading the current step…</p>}>
                            <ActivityTaskStep
                              taskRef={item.taskRef}
                              snapshotAt={snapshot.at}
                              onContinued={activity.refresh}
                            />
                          </Suspense>
                        </ActivityRow>
                      );
                    }
                    const index = item.id.startsWith('index:');
                    const at = item.scheduled ? ISO_TIME.exec(item.detail)?.[0] : undefined;
                    return (
                      <ActivityRow
                        key={item.id}
                        mark={mark}
                        title={item.title}
                        // An indexing row's title already names its project.
                        sub={
                          index
                            ? [formatDetail(item.detail)]
                            : [
                                nameOf(item.gezelId),
                                project,
                                at ? (folded ? undefined : 'Scheduled') : formatDetail(item.detail),
                              ]
                        }
                        when={at ? formatWhen(at) : undefined}
                        whenTitle={at ? new Date(at).toLocaleString() : undefined}
                        onOpen={
                          !index && (item.taskRef || item.sessionId)
                            ? () => void openItem(item)
                            : undefined
                        }
                        openLabel={
                          item.taskRef
                            ? `View task details for ${item.title}`
                            : `Open the chat for ${item.title}`
                        }
                      >
                        {(index || item.heldByActivity) && (
                          <>
                            {index && item.projectId && (
                              <button
                                type="button"
                                className="gz-link-button"
                                onClick={() => {
                                  navigateToTab({ kind: 'project', id: item.projectId! });
                                  setOpen(false);
                                }}
                              >
                                Open project
                              </button>
                            )}
                            {index && item.gezelId && (
                              <button
                                type="button"
                                className="gz-link-button"
                                onClick={() => {
                                  navigateToTab({ kind: 'gezel', id: item.gezelId! });
                                  setOpen(false);
                                }}
                              >
                                Open {nameOf(item.gezelId) ?? 'Librarian'}
                              </button>
                            )}
                            {item.heldByActivity && (
                              <button
                                type="button"
                                className="gz-link-button"
                                onClick={() => {
                                  requestSettingsSection('team');
                                  navigateToTab({ kind: 'area', area: 'settings' });
                                  setOpen(false);
                                }}
                              >
                                Activity settings
                              </button>
                            )}
                          </>
                        )}
                      </ActivityRow>
                    );
                  };
                  return (
                    <section
                      className={`activity-section${isEmpty ? ' is-empty' : ''}`}
                      id={`activity-${id}`}
                      key={id}
                      aria-label={label}
                      data-section={id}
                      data-tone={tone}
                    >
                      <div className="activity-section-head">
                        <h3 tabIndex={-1}>
                          <span aria-hidden="true" className="activity-light" />
                          {label} <span className="activity-count">{countSection(items, id)}</span>
                        </h3>
                        {isEmpty && <p className="activity-empty">{empty}</p>}
                      </div>
                      {cards.map((q) => {
                        const closePanel = () => setOpen(false);
                        const inChat = (question: Question) => {
                          openQuestionInChat(question);
                          closePanel();
                        };
                        // Finished work is a row; a decision opens into a card.
                        const result = !q.answer && isResult(q);
                        return (
                          <div
                            className={`activity-question${result ? ' activity-question-result' : ''}`}
                            id={`activity-question-${q.id}`}
                            tabIndex={-1}
                            key={q.id}
                          >
                            {result ? (
                              <ActivityResultRow
                                question={q}
                                title={
                                  items.find((item) => item.questionIds.includes(q.id))?.title ??
                                  'Finished work'
                                }
                                project={projectName(q.projectId)}
                                onAnswered={answer}
                                onOpenInChat={inChat}
                                onNavigate={closePanel}
                              />
                            ) : (
                              <>
                                {q.intent?.kind !== 'night-shift-review' && (
                                  <p className="activity-context">
                                    <ActivityMark
                                      gezel={gezelOf(q.gezelId)}
                                      plain={boringMode}
                                      size={20}
                                    />
                                    <ActivitySub
                                      parts={[nameOf(q.gezelId), projectName(q.projectId)]}
                                    />
                                  </p>
                                )}
                                <Suspense fallback={null}>
                                  <PendingQuestionCard
                                    question={q}
                                    compact
                                    onAnswered={answer}
                                    onOpenInChat={inChat}
                                    onNavigate={closePanel}
                                  />
                                </Suspense>
                              </>
                            )}
                          </div>
                        );
                      })}
                      {crew && (
                        <QueueSessionRows
                          selection={crew}
                          status={snapshot.queues}
                          gezels={gezels}
                          projects={projects}
                          liveTurns={liveTurns}
                          onDeviceProvider={onDeviceProvider}
                          boringMode={boringMode}
                          onClose={() => setOpen(false)}
                          onItemChanged={activity.refresh}
                          rowContext={rowContext}
                        />
                      )}
                      {rows.map((item) => renderItem(item))}
                      {foldLater ? (
                        <ActivityFold
                          label="Scheduled for later"
                          count={later.length}
                          hint={firstLater ? `from ${formatWhen(firstLater)}` : undefined}
                        >
                          {later.map((item) => renderItem(item, true))}
                        </ActivityFold>
                      ) : (
                        later.map((item) => renderItem(item))
                      )}
                      {earlier.length > 0 && (
                        <ActivityFold label="Finished earlier" count={earlier.length}>
                          {earlier.map((track) => (
                            <ActivityEarlierRow
                              key={track.key}
                              track={track}
                              project={projectName(track.projectId)}
                              onOpenChat={(sessionId) => void openChat(sessionId)}
                              onNavigate={() => setOpen(false)}
                            />
                          ))}
                        </ActivityFold>
                      )}
                    </section>
                  );
                })}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </QuestionDraftProvider>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function formatDetail(detail: string): string {
  return detail.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) =>
    new Date(iso).toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
}
