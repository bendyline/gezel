import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/**
 * Inline audio player for tool-call attachments.
 *
 * Loads the artifact blob via the authenticated client (same auth
 * fence as ToolImageThumbnail), wires it to a hidden `<audio>`
 * element, and renders a play/pause + scrubber UI. Revokes the
 * object URL on unmount so we don't leak per-render.
 */
export function AudioPlayer({
  projectId,
  path,
  durationSeconds,
  voice,
}: {
  projectId: string;
  path: string;
  durationSeconds?: number;
  voice?: string;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [resolvedDuration, setResolvedDuration] = useState<number | undefined>(durationSeconds);

  useEffect(() => {
    let revoked = false;
    let url: string | null = null;
    void (async () => {
      try {
        const blob = await api.fetchProjectArtifactBlob(projectId, path);
        if (revoked) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
    return () => {
      revoked = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [projectId, path]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  if (error) {
    return (
      <div className="tool-audio-row tool-audio-error">
        <code className="muted small">{path}</code>
        <span className="error small">Audio failed to load: {error}</span>
      </div>
    );
  }

  return (
    <div className="tool-audio-row">
      <button
        type="button"
        className="tool-audio-play"
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={togglePlay}
        disabled={!src}
      >
        {playing ? (
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Pause"
          >
            <title>Pause</title>
            <rect x="3" y="2" width="3" height="12" />
            <rect x="10" y="2" width="3" height="12" />
          </svg>
        ) : (
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            role="img"
            aria-label="Play"
          >
            <title>Play</title>
            <polygon points="3,2 13,8 3,14" />
          </svg>
        )}
      </button>
      <div className="tool-audio-meta">
        <code className="small">{path.split(/[/\\]/).pop()}</code>
        <span className="muted small">
          {voice ? <>voice: {voice} · </> : null}
          {formatTime(currentTime)}
          {resolvedDuration !== undefined ? <> / {formatTime(resolvedDuration)}</> : null}
        </span>
      </div>
      {/* biome-ignore lint/a11y/useMediaCaption: TTS / transcription audio rendered inline; captions don't apply. */}
      <audio
        ref={audioRef}
        src={src ?? undefined}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          if (Number.isFinite(e.currentTarget.duration)) {
            setResolvedDuration(e.currentTarget.duration);
          }
        }}
        preload="metadata"
        style={{ display: 'none' }}
      />
    </div>
  );
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
