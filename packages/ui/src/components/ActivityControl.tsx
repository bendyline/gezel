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
import { QueueMeterPanel, openQueuedChat } from './QueueMeter.js';
import { useActivity } from './activity-context.js';
import { useHeaderDensity } from './header-density.js';
import { OPEN_UPDATES_EVENT, navigateToTab } from './nav-actions.js';
import { QuestionDraftProvider } from './question-drafts.js';
import { openQuestionInChat } from './question-nav.js';
import { useRoleBasedNameOnlyMode } from './useRoleBasedNameOnlyMode.js';
import '../styles/activity.css';

const PendingQuestionCard = lazy(() =>
  import('./PendingQuestionCard.js').then((module) => ({ default: module.PendingQuestionCard })),
);

const SECTIONS: { id: ActivitySection; label: string; empty: string }[] = [
  { id: 'needs-you', label: 'Needs you', empty: 'Nothing needs your attention.' },
  { id: 'working', label: 'Working', empty: 'No work is running right now.' },
  { id: 'next', label: 'Next', empty: 'Nothing waiting or scheduled.' },
  { id: 'ready', label: 'Ready', empty: 'New results will appear here.' },
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
  const [details, setDetails] = useState(false);
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
  const allItems = snapshot?.items ?? [];
  const needs = countSection(allItems, 'needs-you');
  const working = countSection(allItems, 'working');
  const next = countSection(allItems, 'next');
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
      setProjectId((event as CustomEvent<{ projectId?: string }>).detail?.projectId);
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
            className={`activity-control${needs ? ' needs-attention' : ''}`}
            data-density={density}
            aria-label={`Activity — ${headline}`}
            title={`What's going on · ${headline}`}
          >
            <span aria-hidden="true" className="activity-control-dot" />
            <span className="activity-control-label">Activity</span>
            <span className="activity-control-summary">{headline}</span>
            <span className="activity-control-count" aria-hidden="true">
              {needs || working || ready || next || '·'}
            </span>
          </button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Content
            className="activity-panel"
            aria-describedby="activity-description"
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
              {SECTIONS.map(({ id, label }) => (
                <button
                  type="button"
                  className="btn secondary"
                  key={id}
                  onClick={() =>
                    document.getElementById(`activity-${id}`)?.scrollIntoView({ block: 'start' })
                  }
                >
                  {label} <span>{countSection(items, id)}</span>
                </button>
              ))}
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
                SECTIONS.map(({ id, label, empty }) => {
                  const rows = sortedItems.filter(
                    (item) => item.section === id && !item.questionIds.length,
                  );
                  const cards = sortedQuestions.filter(
                    (q) => id === (isReadyQuestion(q) ? 'ready' : 'needs-you'),
                  );
                  return (
                    <section
                      className="activity-section"
                      id={`activity-${id}`}
                      key={id}
                      aria-label={label}
                    >
                      <h3>
                        {label} <span>{countSection(items, id)}</span>
                      </h3>
                      {cards.map((q) => (
                        <div
                          className="activity-question"
                          id={`activity-question-${q.id}`}
                          tabIndex={-1}
                          key={q.id}
                        >
                          <p className="activity-context">{contextLabel(q)}</p>
                          <Suspense fallback={<output>Loading question…</output>}>
                            <PendingQuestionCard
                              question={q}
                              compact
                              onAnswered={answer}
                              onOpenInChat={(question) => {
                                openQuestionInChat(question);
                                setOpen(false);
                              }}
                            />
                          </Suspense>
                        </div>
                      ))}
                      {rows.map((item) => (
                        <article className="activity-work" key={item.id}>
                          <p className="activity-context">{contextLabel(item)}</p>
                          <strong>{item.title}</strong>
                          <p>{formatDetail(item.detail)}</p>
                          {item.taskRef || item.sessionId ? (
                            <button
                              type="button"
                              className="btn secondary"
                              onClick={() => void openItem(item)}
                            >
                              {item.taskRef ? 'Open task' : 'Open chat'}
                            </button>
                          ) : null}
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
                      ))}
                      {!rows.length && !cards.length && <p className="activity-empty">{empty}</p>}
                    </section>
                  );
                })}
              {snapshot && (
                <details
                  className="activity-details"
                  open={details}
                  onToggle={(event) => setDetails(event.currentTarget.open)}
                >
                  <summary>Queue details and controls</summary>
                  {details && (
                    <QueueMeterPanel
                      embedded
                      status={snapshot.queues}
                      gezels={gezels}
                      projects={projects}
                      liveTurns={new Map()}
                      preparingTurns={[]}
                      onDeviceProvider={null}
                      boringMode={boringMode}
                      onClose={() => setOpen(false)}
                      onItemChanged={activity.refresh}
                    />
                  )}
                </details>
              )}
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
