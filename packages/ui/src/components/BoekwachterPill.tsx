import type { ChatEventEnvelope, GezelSummary } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';
import { GezelIcon } from './GezelIcon.js';

/**
 * Transient header pill showing what the boekwachter (background indexing)
 * is doing right now — driven by the global `index_progress` SSE events the
 * scan / enrichment / digest loops emit. Self-subscribing like
 * EngineStatusPill; renders nothing when the boekwachter has been quiet,
 * so the header stays clean outside indexing bursts.
 */

const PHASE_LABEL: Record<string, string> = {
  scan: 'scanning',
  enrich: 'studying',
  review: 'reviewing',
  digest: 'digest',
};

/** How long the last progress message stays visible after activity stops. */
const LINGER_MS = 8_000;

export function BoekwachterPill() {
  const [message, setMessage] = useState<string | null>(null);
  const [workerId, setWorkerId] = useState<string | null>(null);
  const [workerName, setWorkerName] = useState<string | null>(null);
  const [worker, setWorker] = useState<GezelSummary | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Project NAMES for the pill copy — every other surface shows names, and a
  // raw id (`spring-cleaning-2`) reads as debug output in the header. Cached
  // once per mount; a rename mid-burst shows the old name for a moment, which
  // beats an id every time.
  const projectNamesRef = useRef<Map<string, string> | null>(null);
  const projectName = async (id: string): Promise<string> => {
    if (!projectNamesRef.current) {
      try {
        const res = await api.listProjects();
        projectNamesRef.current = new Map(res.projects.map((p) => [p.id, p.name]));
      } catch {
        return id;
      }
    }
    return projectNamesRef.current.get(id) ?? id;
  };

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type !== 'index_progress') continue;
          const label = PHASE_LABEL[ev.phase] ?? ev.phase;
          const project = ev.projectId ? ` ${await projectName(ev.projectId)}` : '';
          setMessage(`${label}${project}${ev.detail ? ` — ${ev.detail}` : ''}`);
          setWorkerId(ev.gezelId ?? null);
          setWorkerName(ev.gezelName ?? null);
          if (ev.gezelId) {
            void api
              .getGezel(ev.gezelId)
              .then((gezel) => setWorker(gezel))
              .catch(() => setWorker(null));
          } else {
            setWorker(null);
          }
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => setMessage(null), LINGER_MS);
        }
      } catch {
        /* stream ended (shutdown / navigation) — pill just goes quiet */
      }
    })();
    return () => {
      ctrl.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  if (!message) return null;
  const name = worker?.name ?? workerName;
  const label = name ? `${name}: ${message}` : `Indexing: ${message}`;
  const contents = (
    <>
      {worker ? (
        <span className="boekwachter-pill-avatar" aria-hidden="true">
          <GezelIcon
            svg={worker.icon ?? null}
            poppetje={worker.poppetje}
            iconOverride={worker.iconOverride}
            name={worker.name}
            size={18}
          />
        </span>
      ) : (
        <span className="boekwachter-pill-dot" aria-hidden="true" />
      )}
      <span className="boekwachter-pill-label boekwachter-pill-label-full" aria-hidden="true">
        {label}
      </span>
      <span className="boekwachter-pill-label boekwachter-pill-label-short" aria-hidden="true">
        Indexing
      </span>
      <output className="sr-only" aria-live="polite">
        {label}
      </output>
    </>
  );
  if (!workerId) {
    return (
      <div className="boekwachter-pill" title={`Background structural indexing: ${message}`}>
        {contents}
      </div>
    );
  }
  return (
    <button
      type="button"
      className="boekwachter-pill"
      aria-label={`Open ${name ?? 'Boekwachter'} — ${message}`}
      title={`${name ?? 'Boekwachter'} is ${message}. Open gezel.`}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent('gezel:open-tab', {
            detail: { kind: 'gezel', id: workerId, activate: true },
          }),
        )
      }
    >
      {contents}
    </button>
  );
}
