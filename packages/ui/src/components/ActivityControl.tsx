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
import { GezelIcon } from './GezelIcon.js';
import {
  type QueueRowContext,
  type QueueRowSelection,
  QueueSessionRows,
  openQueuedChat,
  selectQueueRows,
  useQueueLiveTurns,
} from './QueueMeter.js';
import { RequestTracker } from './RequestTracker.js';
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
type SectionTone = 'attention' | 'active' | 'done';

const SECTIONS: { id: ActivitySection; label: string; empty: string; tone: SectionTone }[] = [
  {
    id: 'needs-you',
    label: 'Needs you',
    empty: 'Nothing needs your attention.',
    tone: 'attention',
  },
  { id: 'working', label: 'Working', empty: 'No work is running right now.', tone: 'active' },
  { id: 'next', label: 'Next', empty: 'Nothing waiting or scheduled.', tone: 'active' },
  { id: 'ready', label: 'Ready', empty: 'New results will appear here.', tone: 'done' },
];

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
  const contextLabel = (item: { projectId?: string; gezelId?: string }) => {
    const gezel = item.gezelId ? gezels.get(item.gezelId) : undefined;
    return [
      item.projectId ? (projects.get(item.projectId)?.name ?? item.projectId) : undefined,
      gezel ? displayName(gezel, boringMode) : undefined,
    ]
      .filter(Boolean)
      .join(' · ');
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
    } else if (item.sessionId) {
      try {
        if (!(await openQueuedChat(item.sessionId, () => setOpen(false)))) {
          setNavigationError('Could not open this conversation. Please try again.');
        }
      } catch {
        setNavigationError('Could not open this conversation. Please try again.');
      }
    }
  };
  // The gezels on an engine right now, and the ones waiting for a slot, as
  // the same rows (Stop, reorder, cancel) the header queue used to show.
  // Each row stands in for its activity entry, so the work appears once.
  const queueRows: Partial<Record<ActivitySection, QueueRowSelection>> = snapshot
    ? {
        working: selectQueueRows(snapshot.queues, 'running', preparingTurns, projectId),
        next: selectQueueRows(snapshot.queues, 'waiting', preparingTurns, projectId),
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
                {held && <span className="activity-control-summary">· automatic work paused</span>}
              </span>
            ) : (
              <span className="activity-control-summary">{headline}</span>
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
                <Dialog.Description id="activity-description">
                  {projectId
                    ? (projects.get(projectId)?.name ?? projectId)
                    : 'Across all your projects'}
                </Dialog.Description>
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
            {projectId && (
              <button
                type="button"
                className="btn secondary activity-all-projects"
                onClick={() => setProjectId(undefined)}
              >
                Show all projects
              </button>
            )}
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
                  const rows = sortedItems.filter(
                    (item) =>
                      item.section === id && !item.questionIds.length && !representedByQueue(item),
                  );
                  const crew = queueRows[id];
                  const cards = sortedQuestions.filter(
                    (q) => id === (isReadyQuestion(q) ? 'ready' : 'needs-you'),
                  );
                  const isEmpty = !rows.length && !cards.length && !crew?.count;
                  return (
                    <section
                      className={`activity-section${isEmpty ? ' is-empty' : ''}`}
                      id={`activity-${id}`}
                      key={id}
                      aria-label={label}
                      data-section={id}
                      data-tone={tone}
                    >
                      <h3 tabIndex={-1}>
                        <span aria-hidden="true" className="activity-light" />
                        {label} <span className="activity-count">{countSection(items, id)}</span>
                      </h3>
                      {cards.map((q) => (
                        <div
                          className="activity-question"
                          id={`activity-question-${q.id}`}
                          tabIndex={-1}
                          key={q.id}
                        >
                          <p className="activity-context">{contextLabel(q)}</p>
                          <Suspense fallback={null}>
                            <PendingQuestionCard
                              question={q}
                              compact
                              onAnswered={answer}
                              onOpenInChat={(question) => {
                                openQuestionInChat(question);
                                setOpen(false);
                              }}
                              onNavigate={() => setOpen(false)}
                            />
                          </Suspense>
                        </div>
                      ))}
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
                      {rows.map((item) => {
                        // A person's request reads as its tracker, opened at their thread.
                        const track = item.requestKey
                          ? snapshot.requests?.find((r) => r.key === item.requestKey)
                          : undefined;
                        return (
                          <article className="activity-work" key={item.id}>
                            <p className="activity-context">{contextLabel(item)}</p>
                            <strong>{item.title}</strong>
                            {track ? (
                              <RequestTracker
                                track={track}
                                gezels={gezels}
                                variant="compact"
                                roleBasedNameOnlyMode={boringMode}
                              />
                            ) : item.section === 'needs-you' && item.taskRef ? (
                              <Suspense fallback={<p>Loading the current step…</p>}>
                                <ActivityTaskStep
                                  taskRef={item.taskRef}
                                  snapshotAt={snapshot.at}
                                  onContinued={activity.refresh}
                                />
                              </Suspense>
                            ) : (
                              <p>{formatDetail(item.detail)}</p>
                            )}
                            {track && item.sessionId ? (
                              <button
                                type="button"
                                className="btn secondary"
                                onClick={() => void openItem({ ...item, taskRef: undefined })}
                              >
                                Open chat
                              </button>
                            ) : (item.section !== 'needs-you' || !item.taskRef) &&
                              (item.taskRef || item.sessionId) ? (
                              <button
                                type="button"
                                className="gz-link-button"
                                onClick={() => void openItem(item)}
                              >
                                {item.taskRef ? 'View task details' : 'Open chat'}
                              </button>
                            ) : null}
                            {item.id.startsWith('index:') && (
                              <>
                                {item.projectId && (
                                  <button
                                    type="button"
                                    className="btn secondary"
                                    onClick={() => {
                                      navigateToTab({ kind: 'project', id: item.projectId! });
                                      setOpen(false);
                                    }}
                                  >
                                    Open project
                                  </button>
                                )}
                                {item.gezelId && (
                                  <button
                                    type="button"
                                    className="btn secondary"
                                    onClick={() => {
                                      navigateToTab({ kind: 'gezel', id: item.gezelId! });
                                      setOpen(false);
                                    }}
                                  >
                                    Open {contextLabel({ gezelId: item.gezelId }) || 'Librarian'}
                                  </button>
                                )}
                              </>
                            )}
                            {item.heldByActivity && (
                              <button
                                type="button"
                                className="btn secondary"
                                onClick={() => {
                                  requestSettingsSection('team');
                                  navigateToTab({ kind: 'area', area: 'settings' });
                                  setOpen(false);
                                }}
                              >
                                Activity settings
                              </button>
                            )}
                          </article>
                        );
                      })}
                      {isEmpty && <p className="activity-empty">{empty}</p>}
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

function formatDetail(detail: string): string {
  return detail.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, (iso) =>
    new Date(iso).toLocaleString([], {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }),
  );
}
