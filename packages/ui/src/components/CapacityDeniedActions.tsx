import type { SessionModelFit } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * "Gemma 4 (12B, Q4)" → "Gemma 4 12B". The quant is a detail of the file, not
 * of the model a person chooses.
 */
export function shortModelName(name: string): string {
  const match = /^(.*?)\s*\(([^,)]+)(?:,[^)]*)?\)\s*$/.exec(name);
  return match ? `${match[1]} ${match[2]}` : name;
}

/**
 * The keys under a "not enough memory" failure. Retry appears only once the
 * session's model would actually start, because the person closed something
 * or chose another model; until then it could only fail the same way. When a
 * model already on this computer would start, one key switches to it and
 * runs the turn again.
 */
export function CapacityDeniedActions({
  sessionId,
  busy,
  onRetry,
  onError,
}: {
  sessionId: string;
  /** Which failed-turn action is running; Retry says "Retrying…" only for its own. */
  busy?: 'acknowledge' | 'retry' | undefined;
  onRetry: () => void;
  onError: (message: string) => void;
}) {
  // undefined while the first answer is pending; null when the daemon cannot say.
  const [fit, setFit] = useState<SessionModelFit | null | undefined>(undefined);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = () =>
      api
        .getSessionModelFit(sessionId)
        .then((next) => {
          if (alive) setFit(next && typeof next === 'object' && 'provider' in next ? next : null);
        })
        .catch(() => {
          if (alive) setFit(null);
        });
    void check();
    // Closing other programs or picking a model in Settings happens away
    // from this card; read the answer again when the person comes back.
    window.addEventListener('focus', check);
    window.addEventListener('gezel:config-updated', check);
    return () => {
      alive = false;
      window.removeEventListener('focus', check);
      window.removeEventListener('gezel:config-updated', check);
    };
  }, [sessionId]);

  const switchAndRetry = async (provider: string, model: string) => {
    setSwitching(true);
    try {
      const config = await api.getConfig();
      const next = await api.updateConfig({
        defaultModel: { ...config.defaultModel, [provider]: model },
      });
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: next }));
      onRetry();
    } catch {
      onError('Could not switch models. Check the connection and try again.');
    } finally {
      setSwitching(false);
    }
  };

  if (fit === undefined) return null;
  const canRetry = fit === null || fit.startsNow !== false;
  const alternative =
    fit && fit.startsNow === false && fit.followsDefault ? fit.alternative : undefined;
  const disabled = busy !== undefined || switching;
  return (
    <>
      {alternative && fit && (
        <button
          type="button"
          className="timeline-session-error-action timeline-session-error-action-primary"
          data-testid="capacity-alternative"
          disabled={disabled}
          onClick={() => void switchAndRetry(fit.provider, alternative.model)}
        >
          {switching ? 'Switching…' : `Use ${shortModelName(alternative.name)} instead`}
          <span className="timeline-session-error-action-note">already on this computer</span>
        </button>
      )}
      {canRetry && (
        <button
          type="button"
          className="timeline-session-error-action timeline-session-error-action-primary"
          disabled={disabled}
          onClick={onRetry}
        >
          {busy === 'retry' ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </>
  );
}
