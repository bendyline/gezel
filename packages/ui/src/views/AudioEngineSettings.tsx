import type { AudioEngineHealth, AudioEngineStatusResponse, AudioVoice } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { AudioModelManager } from '../components/AudioModelManager.js';

/**
 * Settings subsection for audio (STT + TTS). Surfaces an honest
 * readiness pill for each engine, the model picker for each, and a
 * voice picker + "preview" button for TTS. Mirrors
 * {@link ImageEngineSettings}'s layout but with two engines instead
 * of one.
 */
export function AudioEngineSettings() {
  const [status, setStatus] = useState<AudioEngineStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [voices, setVoices] = useState<AudioVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('af_heart');
  const [previewText, setPreviewText] = useState('The quick brown fox jumps over the lazy dog.');
  const [previewState, setPreviewState] = useState<
    { kind: 'idle' } | { kind: 'synthesizing' } | { kind: 'error'; msg: string }
  >({ kind: 'idle' });
  const [defaultSttModel, setDefaultSttModel] = useState<string | undefined>(undefined);
  const [narrate, setNarrate] = useState<boolean>(false);
  const [narrateSaving, setNarrateSaving] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, v, cfg] = await Promise.all([
        api.getAudioEngineStatus(),
        api.listAudioVoices(),
        api.getConfig(),
      ]);
      setStatus(s);
      setVoices(v.voices);
      setNarrate(cfg.narrateAssistantReplies ?? false);
      setDefaultSttModel(cfg.defaultSttModel);
      setStatusError(null);
    } catch (err) {
      setStatus(null);
      setStatusError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onToggleNarrate = useCallback(async (next: boolean) => {
    setNarrateSaving(true);
    setNarrate(next);
    try {
      const res = await api.updateConfig({ narrateAssistantReplies: next });
      // Fan out so any open chat surfaces pick up the change live without
      // a route change. Same channel SettingsView uses for boring mode.
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
    } catch (err) {
      // Revert the optimistic update if the save fails.
      setNarrate(!next);
      setStatusError((err as Error).message);
    } finally {
      setNarrateSaving(false);
    }
  }, []);

  const onSetActiveSttModel = useCallback(async (id: string) => {
    // Optimistic so the radio moves under the click; the engine restart the
    // save triggers takes long enough that waiting on it reads as a dead
    // control.
    setDefaultSttModel(id);
    try {
      const res = await api.updateConfig({ defaultSttModel: id });
      setDefaultSttModel(res.defaultSttModel);
    } catch (err) {
      setDefaultSttModel(undefined);
      setStatusError((err as Error).message);
    }
  }, []);

  const onPreview = useCallback(async () => {
    if (!previewText.trim()) return;
    setPreviewState({ kind: 'synthesizing' });
    try {
      const res = await api.synthesizeSpeech({
        text: previewText,
        voice: selectedVoice,
        // Inline so the renderer can play immediately without an
        // extra artifact-fetch round-trip.
        inline: true,
      });
      if (res.b64Wav && audioRef.current) {
        audioRef.current.src = `data:audio/wav;base64,${res.b64Wav}`;
        await audioRef.current.play().catch(() => {});
      }
      setPreviewState({ kind: 'idle' });
    } catch (err) {
      setPreviewState({ kind: 'error', msg: formatPreviewError(err) });
    }
  }, [previewText, selectedVoice]);

  return (
    <div className="provider-card">
      <div className="settings-card-header">
        <h3>Audio</h3>
      </div>

      <p className="muted small">
        Speech-to-text via the bundled <code>whisper.cpp</code> engine and text-to-speech via the
        bundled <code>Kokoro</code> engine — both run locally.
      </p>

      {statusError && <p className="error">Couldn't reach the Gezel service. {statusError}</p>}

      {/* ── Speech-to-text ── */}
      <section style={{ marginTop: '1rem' }}>
        <div className="settings-card-header">
          <h4 style={{ margin: 0 }}>Speech-to-text (whisper.cpp)</h4>
          {status && <EngineStatusPill engine={status.stt} />}
        </div>
        <EngineGuidance engine={status?.stt} />
        <AudioModelManager
          kind="stt"
          {...(defaultSttModel ? { configuredDefaultModelId: defaultSttModel } : {})}
          onSetActiveModel={onSetActiveSttModel}
          {...(engineDisabled(status?.stt)
            ? {
                disabledReason:
                  status?.stt.status === 'not-configured'
                    ? 'whisper.cpp engine is not wired up — downloading a model now would still leave it unrunnable.'
                    : 'whisper.cpp engine is not reachable.',
              }
            : {})}
          onModelsChanged={() => void refresh()}
        />
      </section>

      {/* ── Text-to-speech ── */}
      <section style={{ marginTop: '1.5rem' }}>
        <div className="settings-card-header">
          <h4 style={{ margin: 0 }}>Text-to-speech (Kokoro)</h4>
          {status && <EngineStatusPill engine={status.tts} />}
        </div>
        <EngineGuidance engine={status?.tts} />
        <AudioModelManager
          kind="tts"
          {...(engineDisabled(status?.tts)
            ? { disabledReason: 'Kokoro engine is not configured.' }
            : {})}
          onModelsChanged={() => void refresh()}
        />

        {status?.tts.status === 'ok' && (
          <div className="ollama-section" style={{ marginTop: '1rem' }}>
            <label className="provider-row">
              <input
                type="checkbox"
                checked={narrate}
                disabled={narrateSaving}
                onChange={(e) => void onToggleNarrate(e.target.checked)}
              />
              <span>
                Narrate assistant replies
                <span className="muted small" style={{ marginLeft: '0.5rem' }}>
                  — speak each completed gezel reply aloud using that gezel's voice.
                </span>
              </span>
            </label>
          </div>
        )}

        {status?.tts.status === 'ok' && (
          <div className="ollama-section" style={{ marginTop: '1rem' }}>
            <h4>Preview a voice</h4>
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'center',
                flexWrap: 'wrap',
              }}
            >
              <label className="provider-row">
                <span>Voice</span>
                <select value={selectedVoice} onChange={(e) => setSelectedVoice(e.target.value)}>
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name} ({v.language})
                    </option>
                  ))}
                </select>
              </label>
              <input
                type="text"
                value={previewText}
                onChange={(e) => setPreviewText(e.target.value)}
                style={{ minWidth: 280, flex: 1 }}
              />
              <button
                type="button"
                onClick={() => void onPreview()}
                disabled={previewState.kind === 'synthesizing' || !previewText.trim()}
              >
                {previewState.kind === 'synthesizing' ? 'Synthesizing…' : 'Preview'}
              </button>
            </div>
            {previewState.kind === 'error' && <p className="error">{previewState.msg}</p>}
            {/* biome-ignore lint/a11y/useMediaCaption: preview audio for the user's own typed text. */}
            <audio ref={audioRef} controls style={{ width: '100%', marginTop: '0.5rem' }} />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Pull the server-side error string out of a thrown error. The HTTP layer
 * stuffs the response body into `GezelApiError.details` (`{ error: string }`
 * for our 500 path); without unwrapping it the user just sees the bare
 * "Gezel API error 500" with no clue what actually broke.
 */
function formatPreviewError(err: unknown): string {
  if (err instanceof GezelApiError) {
    const details = err.details;
    if (details && typeof details === 'object' && 'error' in details) {
      const inner = (details as { error?: unknown }).error;
      if (typeof inner === 'string' && inner.length > 0) {
        return `${err.message}: ${inner}`;
      }
    }
    if (typeof details === 'string' && details.length > 0) {
      return `${err.message}: ${details}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

function engineDisabled(engine: AudioEngineHealth | undefined): boolean {
  if (!engine) return true;
  return engine.status === 'not-configured' || engine.status === 'unreachable';
}

function EngineStatusPill({ engine }: { engine: AudioEngineHealth }) {
  if (engine.status === 'ok') {
    return <span className="gz-status-pill gz-status-pill--ok">Ready</span>;
  }
  if (engine.status === 'no-model') {
    return <span className="gz-status-pill gz-status-pill--warn">No model</span>;
  }
  if (engine.status === 'unreachable') {
    return <span className="gz-status-pill gz-status-pill--error">Unreachable</span>;
  }
  return <span className="gz-status-pill gz-status-pill--warn">Not configured</span>;
}

function EngineGuidance({ engine }: { engine: AudioEngineHealth | undefined }) {
  if (!engine) return null;
  if (engine.status === 'not-configured') {
    return (
      <p className="muted small">
        Engine isn't wired up on this install yet.
        {engine.error ? <> {engine.error}</> : null}
      </p>
    );
  }
  if (engine.status === 'unreachable') {
    return (
      <p className="error">
        Engine isn't responding
        {engine.baseUrl ? (
          <>
            {' '}
            at <code>{engine.baseUrl}</code>
          </>
        ) : null}
        .{engine.error ? <> {engine.error}</> : null}
      </p>
    );
  }
  if (engine.status === 'no-model') {
    return (
      <p className="muted small">Engine is ready — download a model below to start using it.</p>
    );
  }
  return null;
}
