import type { ChatEventEnvelope } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { Popover } from '../../primitives/index.js';
import { streamSharedAllChatEvents } from '../../shared-chat-events.js';
import './cameras.css';

type Watching = Array<{ projectId: string; bindingId: string; name: string }>;

/**
 * "Camera on", in the titlebar, whenever any camera on any project is
 * watching. Watching must always be visible, and stopping it is one click:
 * the menu pauses a camera right where the person noticed it.
 */
export function WatchingIndicator() {
  const [cameras, setCameras] = useState<Watching>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    void api
      .listWatchingCameras()
      .then((res) => setCameras(res.cameras))
      .catch(() => {});
    void (async () => {
      try {
        for await (const env of streamSharedAllChatEvents({
          url: api.allEventsUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type === 'cameras_watching') setCameras(ev.cameras);
        }
      } catch {
        /* stream ended */
      }
    })();
    return () => ctrl.abort();
  }, []);

  if (cameras.length === 0) return null;
  const label = cameras.length === 1 ? `${cameras[0]?.name} is on` : `${cameras.length} cameras on`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="boekwachter-pill camera-on-pill"
          aria-label={label}
          title={label}
        >
          <span className="camera-on-dot" aria-hidden="true" />
          <span className="boekwachter-pill-label">{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Content className="camera-on-menu" align="end">
        <p className="small muted">
          Watching now. Pictures stay on this computer unless a camera is set to let cloud AI see
          them.
        </p>
        <ul>
          {cameras.map((c) => (
            <li key={`${c.projectId}/${c.bindingId}`}>
              <span>{c.name}</span>
              <button
                type="button"
                disabled={busy === c.bindingId}
                onClick={async () => {
                  setBusy(c.bindingId);
                  try {
                    await api.patchConnector(c.projectId, c.bindingId, { disabled: true });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Pause
              </button>
            </li>
          ))}
        </ul>
      </Popover.Content>
    </Popover.Root>
  );
}
