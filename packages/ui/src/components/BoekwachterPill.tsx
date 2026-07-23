import type { ChatEventEnvelope } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { streamSharedAllChatEvents } from '../shared-chat-events.js';

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          const project = ev.projectId ? ` ${ev.projectId}` : '';
          setMessage(`${label}${project}${ev.detail ? ` — ${ev.detail}` : ''}`);
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
  return (
    <output
      className="boekwachter-pill"
      aria-label={`Boekwachter: ${message}`}
      title={`Background indexing (boekwachter): ${message}`}
    >
      <span className="boekwachter-pill-dot" aria-hidden="true" />
      <span className="boekwachter-pill-label boekwachter-pill-label-full" aria-hidden="true">
        Boekwachter: {message}
      </span>
      <span className="boekwachter-pill-label boekwachter-pill-label-short" aria-hidden="true">
        Indexing
      </span>
    </output>
  );
}
