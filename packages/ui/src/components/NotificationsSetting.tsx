import { DEFAULT_NOTIFICATION_DAILY_CAP } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

const CAPS = [0, 1, 3, 5, 10] as const;

/**
 * How many notifications a day may reach the person: questions, finished
 * work, level-ups, the night's review, project reminders. Keys in a tray,
 * saved on click. Nothing is ever sent on the clock alone, so the cap is a
 * ceiling, not a schedule.
 */
export function NotificationsSetting() {
  const [cap, setCap] = useState<number | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api
      .getConfig()
      .then((config) => {
        if (!cancelled) setCap(config.notifications?.dailyCap ?? DEFAULT_NOTIFICATION_DAILY_CAP);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const save = async (dailyCap: number) => {
    setError('');
    setCap(dailyCap);
    try {
      const config = await api.updateConfig({ notifications: { dailyCap } });
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: config }));
      if (dailyCap > 0) await window.__GEZEL__?.earnedNotifications?.requestPermission();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        Only when something happened: a question for you, finished work, a level-up, the night’s
        review, or a reminder a project worked out from its own progress. Several at once arrive as
        one.
      </p>
      <div className="gz-tray" role="radiogroup" aria-label="Notifications a day at most">
        {CAPS.map((value) => (
          <button
            key={value}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
            role="radio"
            aria-checked={cap === value}
            disabled={cap === null}
            className={`gz-key${cap === value ? ' gz-key-active' : ''}`}
            onClick={() => void save(value)}
          >
            {value === 0 ? 'Off' : value}
          </button>
        ))}
      </div>
      <p className="muted small">A day, at most.</p>
      {error && <p className="error">{error}</p>}
    </>
  );
}
