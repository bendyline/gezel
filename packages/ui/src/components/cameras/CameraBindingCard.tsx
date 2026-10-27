import type { ChatEventEnvelope, LiveBindingStatus } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api.js';
import { formatRelativeTime } from '../../relative-time.js';
import { streamSharedProjectChatEvents } from '../../shared-chat-events.js';
import { setVisibleInterval } from '../../visible-interval.js';
import {
  type CameraForm,
  CameraSetupPanel,
  cameraConfigFromForm,
  cameraFormFromConfig,
} from './CameraSetupPanel.js';
import './cameras.css';

export interface CameraBinding {
  id: string;
  type: string;
  displayName?: string;
  disabled?: boolean;
  disabledReason?: 'user' | 'emergency-stop';
  lastError?: string;
  config?: Record<string, unknown>;
  live?: LiveBindingStatus;
}

const PREVIEW_EVERY_MS = 2_000;

function statusLine(
  live: LiveBindingStatus | undefined,
  binding: CameraBinding,
): {
  text: string;
  tone: 'ok' | 'muted' | 'warn' | 'error';
} {
  if (binding.disabled) {
    return {
      text:
        binding.disabledReason === 'emergency-stop' ? 'Stopped by the emergency stop.' : 'Paused.',
      tone: 'muted',
    };
  }
  if (!live) return { text: 'Starting…', tone: 'muted' };
  if (live.state === 'watching') {
    if (live.episode) {
      return {
        text: live.episode.motion ? 'Something is moving.' : 'Something is in view.',
        tone: 'warn',
      };
    }
    return {
      text: live.lastMotionAt
        ? `Watching. Last movement ${formatRelativeTime(live.lastMotionAt)}.`
        : 'Watching.',
      tone: 'ok',
    };
  }
  if (live.state === 'starting') return { text: 'Opening the camera…', tone: 'muted' };
  if (live.state === 'held') return { text: live.reason ?? 'Waiting.', tone: 'muted' };
  if (live.state === 'paused') return { text: live.reason ?? 'Paused.', tone: 'muted' };
  return { text: live.reason ?? binding.lastError ?? 'The camera stopped.', tone: 'error' };
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * One camera on a project: what it is doing now, a small live view while
 * this card is on screen, and its controls. Watching is always visible and
 * one click stops it.
 */
export function CameraBindingCard({
  projectId,
  binding,
  onChanged,
  onRemove,
}: {
  projectId: string;
  binding: CameraBinding;
  onChanged: () => void;
  onRemove: (bindingId: string) => void;
}) {
  const [live, setLive] = useState<LiveBindingStatus | undefined>(binding.live);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<CameraForm>(() =>
    cameraFormFromConfig(binding.config, binding.displayName),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => setLive(binding.live), [binding.live]);

  // Live status over the project stream: the card never polls for state.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const env of streamSharedProjectChatEvents({
          url: api.projectEventsUrl(projectId),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          const ev = (env as ChatEventEnvelope).event;
          if (ev.type === 'camera_status' && ev.bindingId === binding.id) setLive(ev.status);
        }
      } catch {
        /* stream ended */
      }
    })();
    return () => ctrl.abort();
  }, [projectId, binding.id]);

  const watching = !binding.disabled && live?.state === 'watching';

  // The preview refreshes only while the card is visible, and only from the
  // daemon's memory; nothing is written to disk for it.
  useEffect(() => {
    if (!watching) {
      setPreviewUrl(null);
      return;
    }
    let current: string | null = null;
    let stopped = false;
    const load = async () => {
      try {
        const blob = await api.fetchCameraPreview(projectId, binding.id);
        if (stopped) return;
        const next = URL.createObjectURL(blob);
        setPreviewUrl(next);
        if (current) URL.revokeObjectURL(current);
        current = next;
      } catch {
        /* no frame yet */
      }
    };
    void load();
    const stop = setVisibleInterval(() => void load(), PREVIEW_EVERY_MS);
    return () => {
      stopped = true;
      stop();
      if (current) URL.revokeObjectURL(current);
    };
  }, [watching, projectId, binding.id]);

  const patch = useCallback(
    async (body: Parameters<typeof api.patchConnector>[2]) => {
      setBusy(true);
      setError('');
      try {
        await api.patchConnector(projectId, binding.id, body);
        onChanged();
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [projectId, binding.id, onChanged],
  );

  const line = statusLine(live, binding);
  const name = binding.displayName || 'Camera';

  return (
    <div className="camera-card">
      <div className="camera-card-body">
        <div className={`camera-card-view${watching ? ' camera-card-view--live' : ''}`}>
          {previewUrl ? (
            <img src={previewUrl} alt={`Live view from ${name}`} />
          ) : (
            <span className="camera-card-view-empty" aria-hidden="true" />
          )}
          {watching ? <span className="camera-card-on">On</span> : null}
        </div>
        <div className="camera-card-text">
          <strong>{name}</strong>
          <div className={`small camera-card-status camera-card-status--${line.tone}`}>
            {line.text}
          </div>
          <div className="small muted">
            {live?.review === 'no-model'
              ? 'No image reader is installed, so it only notices movement (Settings → Image recognition).'
              : live?.review === 'held'
                ? 'Recognizing waits while Gezel is set to chat only.'
                : live?.lastEventAt
                  ? `Last moment kept ${formatRelativeTime(live.lastEventAt)}.`
                  : null}
            {live?.capturesBytes ? ` Saved pictures: ${formatBytes(live.capturesBytes)}.` : ''}
          </div>
        </div>
      </div>
      <div className="gz-mail-link-actions">
        <button
          type="button"
          className={binding.disabled ? 'primary' : undefined}
          onClick={() => void patch({ disabled: !binding.disabled })}
          disabled={busy}
        >
          {binding.disabled ? 'Resume' : 'Pause'}
        </button>
        <button type="button" onClick={() => setEditing((v) => !v)} disabled={busy}>
          {editing ? 'Close settings' : 'Settings'}
        </button>
        <button
          type="button"
          className="danger"
          onClick={() => onRemove(binding.id)}
          disabled={busy}
        >
          Remove
        </button>
      </div>
      {editing ? (
        <div className="camera-card-settings">
          <CameraSetupPanel form={form} onChange={setForm} />
          <div className="gz-mail-link-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !form.device}
              onClick={async () => {
                const ok = await patch({
                  displayName: form.displayName,
                  config: cameraConfigFromForm(form),
                });
                if (ok) setEditing(false);
              }}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      ) : null}
      {error ? <p className="error small">{error}</p> : null}
    </div>
  );
}
