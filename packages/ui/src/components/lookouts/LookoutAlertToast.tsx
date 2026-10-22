import type { ChatEventEnvelope } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { streamSharedAllChatEvents } from '../../shared-chat-events.js';
import './lookouts.css';

interface Alert {
  firingId: string;
  title: string;
  body: string;
  sound: boolean;
  at: number;
}

const SHOW_MS = 30_000;
const MAX_SHOWN = 3;

/**
 * A lookout's alert while the app is open. The desktop app stays quiet with
 * a window focused (see the earned-notification policy), so this is the
 * alert the person sees then — with the one control a sound needs: Stop.
 */
export function LookoutAlertToast() {
  const [alerts, setAlerts] = useState<Alert[]>([]);

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
          if (ev.type !== 'lookout_fired' || (!ev.alert && !ev.sound)) continue;
          const alert: Alert = {
            firingId: ev.firingId,
            title: ev.alert?.title ?? ev.name,
            body: ev.alert?.body ?? 'Playing a sound.',
            sound: ev.sound === true,
            at: Date.now(),
          };
          setAlerts((current) =>
            [alert, ...current.filter((a) => a.firingId !== alert.firingId)].slice(0, MAX_SHOWN),
          );
        }
      } catch {
        /* stream ended */
      }
    })();
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    if (alerts.length === 0) return;
    const timer = setInterval(() => {
      setAlerts((current) => current.filter((a) => Date.now() - a.at < SHOW_MS));
    }, 1_000);
    return () => clearInterval(timer);
  }, [alerts.length]);

  if (alerts.length === 0) return null;
  const dismiss = (id: string) => setAlerts((current) => current.filter((a) => a.firingId !== id));
  return (
    <section className="lookout-toasts" aria-label="Lookout alerts">
      {alerts.map((a) => (
        <div key={a.firingId} className="lookout-toast" role="alert">
          <div>
            <strong>{a.title}</strong>
            <div className="small">{a.body}</div>
          </div>
          <div className="lookout-toast-actions">
            {a.sound ? (
              <button
                type="button"
                onClick={() => {
                  void api.stopLookoutSounds().catch(() => {});
                  dismiss(a.firingId);
                }}
              >
                Stop sound
              </button>
            ) : null}
            <button type="button" onClick={() => dismiss(a.firingId)} aria-label="Dismiss">
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
