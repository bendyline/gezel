import type { ChatEventEnvelope, GezelSummary, Project, Question } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import { GezelIcon } from './GezelIcon.js';
import { PendingQuestionCard } from './PendingQuestionCard.js';

/**
 * "Needs your input" — lists unanswered structured questions across
 * every project, paginated. Previously lived on the Home view; now
 * rendered inside a top-nav overlay so the user can answer from
 * anywhere in the app without losing context.
 *
 * Loads + refreshes its own data via the global SSE stream, so it
 * stays in sync regardless of which view the user is on.
 */
export function NeedsInputPanel({
  onOpenInChat,
  projectId,
  onEmpty,
}: {
  /** Focus the thread a question came from, then close the host surface. */
  onOpenInChat?: (question: Question) => void;
  /** When set, only this project's pending questions are shown (the sidebar
   *  intervene popup). Unset = every project (the global Home overlay). */
  projectId?: string;
  /** Fired once the (scoped) list drains to zero — lets a host dialog close
   *  itself after the last question is answered. */
  onEmpty?: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [gezels, setGezels] = useState<Map<string, GezelSummary>>(new Map());
  const [projectsById, setProjectsById] = useState<Map<string, Project>>(new Map());
  const refetchGezelsRef = useRef<Promise<void> | null>(null);
  const refetchGezels = useCallback(() => {
    if (refetchGezelsRef.current) return refetchGezelsRef.current;
    const p = (async () => {
      try {
        const r = await api.listGezels();
        const m = new Map<string, GezelSummary>();
        for (const g of r.gezels) m.set(g.id, g);
        setGezels(m);
      } catch {
        /* non-fatal */
      } finally {
        refetchGezelsRef.current = null;
      }
    })();
    refetchGezelsRef.current = p;
    return p;
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await api.listQuestions({ pending: true });
      setQuestions(res.questions);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void refetchGezels();
    api
      .listProjects()
      .then((r) => {
        const m = new Map<string, Project>();
        for (const p of r.projects) m.set(p.id, p);
        setProjectsById(m);
      })
      .catch(() => {});
  }, [refresh, refetchGezels]);

  useEffect(() => {
    if (questions.some((q) => !gezels.has(q.gezelId))) void refetchGezels();
  }, [questions, gezels, refetchGezels]);

  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type === 'question_asked' || ev.type === 'question_answered') {
            void refresh();
          }
        }
      } catch {
        /* aborted */
      }
    })();
    return () => ctrl.abort();
  }, [refresh]);

  const scoped = projectId ? questions.filter((q) => q.projectId === projectId) : questions;

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    if (activeIndex > scoped.length - 1) {
      setActiveIndex(Math.max(0, scoped.length - 1));
    }
  }, [scoped.length, activeIndex]);

  // When scoped to one project (the sidebar intervene popup), tell the host to
  // close once its last question is answered. `everHadRef` guards the brief
  // pre-load empty state so the dialog doesn't insta-close before data lands.
  const everHadRef = useRef(false);
  useEffect(() => {
    if (scoped.length > 0) everHadRef.current = true;
  }, [scoped.length]);
  useEffect(() => {
    if (projectId && everHadRef.current && scoped.length === 0) onEmpty?.();
  }, [projectId, scoped.length, onEmpty]);

  if (scoped.length === 0) {
    return <div className="needs-input-empty muted">No pending questions right now.</div>;
  }

  const active = scoped[Math.min(activeIndex, scoped.length - 1)];
  if (!active) return null;
  const gezel = gezels.get(active.gezelId);
  const project = projectsById.get(active.projectId);

  const advancePast = () => {
    if (scoped.length > 1) {
      setActiveIndex((i) => Math.min(i, scoped.length - 2));
    }
    void refresh();
  };

  return (
    <section className="home-needs-input">
      <header>
        <h3>Needs your input</h3>
        <p className="muted">
          Question {activeIndex + 1} of {scoped.length}
          {gezel ? (
            <>
              {' '}
              from <strong>{gezel.name}</strong>
            </>
          ) : null}
          {project ? (
            <>
              {' '}
              · <span>{project.name}</span>
            </>
          ) : null}
        </p>
      </header>
      {scoped.length > 1 && (
        <div className="home-needs-input-tabs" role="tablist">
          <button
            type="button"
            className="home-needs-input-nav-btn"
            onClick={() => setActiveIndex((i) => Math.max(0, i - 1))}
            disabled={activeIndex === 0}
            aria-label="Previous question"
            title="Previous question"
          >
            ←
          </button>
          {scoped.map((q, i) => {
            const tabGezel = gezels.get(q.gezelId);
            return (
              <button
                key={q.id}
                type="button"
                role="tab"
                aria-selected={i === activeIndex}
                className={`home-needs-input-tab${i === activeIndex ? ' home-needs-input-tab-active' : ''}`}
                onClick={() => setActiveIndex(i)}
                title={tabGezel?.name ?? 'Gezel'}
              >
                <GezelIcon
                  svg={tabGezel?.icon ?? null}
                  poppetje={tabGezel?.poppetje}
                  iconOverride={tabGezel?.iconOverride}
                  name={tabGezel?.name ?? 'Gezel'}
                  size={16}
                />
                <span>{i + 1}</span>
              </button>
            );
          })}
          <button
            type="button"
            className="home-needs-input-nav-btn"
            onClick={() => setActiveIndex((i) => Math.min(scoped.length - 1, i + 1))}
            disabled={activeIndex >= scoped.length - 1}
            aria-label="Next question"
            title="Next question"
          >
            →
          </button>
        </div>
      )}
      <div className="home-needs-input-item">
        <div className="home-needs-input-meta">
          <GezelIcon
            svg={gezel?.icon ?? null}
            poppetje={gezel?.poppetje}
            iconOverride={gezel?.iconOverride}
            name={gezel?.name ?? 'Gezel'}
            size={20}
          />
          <span className="home-needs-input-author">
            <strong>{gezel?.name ?? 'A gezel'}</strong>
            {project && (
              <>
                {' · '}
                <span className="muted">{project.name}</span>
              </>
            )}
          </span>
        </div>
        <PendingQuestionCard
          key={active.id}
          question={active}
          onAnswered={advancePast}
          onOpenInChat={onOpenInChat}
        />
      </div>
    </section>
  );
}
