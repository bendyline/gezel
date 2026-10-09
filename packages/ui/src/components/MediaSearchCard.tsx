import type { MediaSearchStatusResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

type ImageTokenBudget = 70 | 140 | 280 | 560 | 1120;

/** Vision tokens per photo, as the person chooses them: more detail, slower indexing. */
const DETAIL_LEVELS: ReadonlyArray<{
  budget: ImageTokenBudget;
  label: string;
  description: string;
}> = [
  { budget: 70, label: 'Quick', description: 'about four times faster; small details blur.' },
  { budget: 140, label: 'Balanced', description: 'twice as fast; most scenes still read.' },
  {
    budget: 280,
    label: 'Detailed',
    description: 'the same detail knowledge catalogs use, so their photos and yours compare.',
  },
  {
    budget: 560,
    label: 'Finest',
    description: 'reads small text and fine detail, at about twice the time per photo.',
  },
];

/**
 * Settings → Image recognition: searching photos, video and sound by what is
 * in them. One on-device model reads pictures, video frames and audio into
 * the same space as words, so "the whiteboard sketch of the API" finds the
 * photo. The status pill beside the heading is the whole lifecycle; video and
 * sound also need a system ffmpeg, which this card names when it is missing.
 */
export function MediaSearchCard() {
  const [status, setStatus] = useState<MediaSearchStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.retrieval.mediaSearchStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = status?.status === 'downloading';
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void refresh(), 1_500);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const save = useCallback(
    async (patch: { enabled?: boolean; imageTokenBudget?: ImageTokenBudget }) => {
      if (!status) return;
      setSaving(true);
      setError(null);
      try {
        await api.updateConfig({
          mediaSearch: {
            enabled: status.enabled,
            imageTokenBudget: status.imageTokenBudget as ImageTokenBudget,
            ...patch,
          },
        });
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [status, refresh],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setError(null);
      try {
        await action();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
      await refresh();
    },
    [refresh],
  );

  const level = DETAIL_LEVELS.find((l) => l.budget === status?.imageTokenBudget);
  const audioReady = status?.installedParts.includes('audio') === true;

  return (
    <section className="provider-card" style={{ marginBottom: '2rem' }}>
      <div className="settings-card-header">
        <h3>Search photos, video and sound</h3>
        {status && <StatusPill status={status} />}
      </div>
      <p className="muted small">
        Gezel looks at what is in your photos, video and recordings, so a search for "the whiteboard
        sketch of the login flow" finds the picture even when nothing in its name says so. Knowledge
        catalogs that ship photos and clips are searched the same way. Everything runs on this
        device. Turning this on downloads the model once (about{' '}
        {megabytes(status?.approxBytes.images ?? 0)} MB).
      </p>
      <label className="debug-toggle">
        <input
          type="checkbox"
          checked={status?.enabled === true}
          disabled={!status || saving}
          onChange={(e) => void save({ enabled: e.target.checked })}
        />
        <span>Search photos, video and sound by what is in them</span>
      </label>

      {status?.enabled && (
        <>
          <div
            className="gz-tray gz-tray--described"
            role="radiogroup"
            aria-label="Photo detail"
            style={{ marginTop: '0.75rem' }}
          >
            {DETAIL_LEVELS.map((l) => {
              const active = l.budget === status.imageTokenBudget;
              return (
                <button
                  key={l.budget}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                  role="radio"
                  aria-checked={active}
                  className={`gz-key${active ? ' gz-key-active' : ''}`}
                  disabled={saving}
                  onClick={() => void save({ imageTokenBudget: l.budget })}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
          {level && (
            <p className="gz-tray-description muted small">
              <strong>{level.label}</strong> — {level.description} Changing this looks at every
              photo again in the background.
            </p>
          )}

          <p className="muted small" style={{ margin: '0.75rem 0 0' }}>
            {videoLine(status)}
          </p>
          <div className="new-row" style={{ marginTop: '0.5rem' }}>
            {!status.ffmpeg && (
              <button
                type="button"
                onClick={() => void run(() => api.retrieval.recheckMediaSearchFfmpeg())}
              >
                Check for ffmpeg again
              </button>
            )}
            {status.ffmpeg && !audioReady && status.status !== 'downloading' && (
              <button
                type="button"
                onClick={() => void run(() => api.retrieval.installMediaSearch({ audio: true }))}
              >
                Download sound support now
              </button>
            )}
          </div>
        </>
      )}

      {status && status.status !== 'ready' && status.status !== 'off' && (
        <p className="muted small" style={{ margin: '0.5rem 0 0' }}>
          {statusLine(status)}
        </p>
      )}
      {(error ?? status?.error) && <p className="error small">{error ?? status?.error}</p>}
    </section>
  );
}

function StatusPill({ status }: { status: MediaSearchStatusResponse }) {
  switch (status.status) {
    case 'ready':
      return <span className="gz-status-pill gz-status-pill--ok">Ready</span>;
    case 'off':
      return <span className="gz-status-pill gz-status-pill--info">Off</span>;
    case 'downloading':
      return <span className="gz-status-pill gz-status-pill--info">Downloading</span>;
    case 'error':
      return <span className="gz-status-pill gz-status-pill--warn">Download failed</span>;
    default:
      return <span className="gz-status-pill gz-status-pill--warn">Not downloaded</span>;
  }
}

function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000));
}

function statusLine(status: MediaSearchStatusResponse): string {
  switch (status.status) {
    case 'not-installed':
      return 'Not downloaded yet. Until it is, photos are found by their names and descriptions.';
    case 'blocked-network':
      return 'Downloads are turned off in Security settings, so the model cannot be fetched. Photos are found by their names and descriptions.';
    case 'downloading': {
      const progress = status.progress;
      return progress
        ? `Downloading… ${megabytes(progress.bytesDone)} of ${megabytes(progress.bytesTotal)} MB`
        : 'Downloading…';
    }
    case 'error':
      return 'The download stopped. It tries again the next time Gezel starts.';
    default:
      return '';
  }
}

function videoLine(status: MediaSearchStatusResponse): string {
  if (!status.ffmpeg) {
    return 'Video and sound files need ffmpeg, which was not found on this computer. Install it (for example from ffmpeg.org, or with Homebrew on a Mac), then check again. Photos work without it.';
  }
  if (!status.installedParts.includes('audio')) {
    return `Video and sound files are searched once the sound part of the model downloads (about ${megabytes(status.approxBytes.audio)} MB). That happens on its own the first time one is indexed.`;
  }
  return `Video and sound files are searched too, using ffmpeg ${status.ffmpeg.version}.`;
}
