import { useState } from 'react';
import { api } from '../api.js';
import { useSocialMode } from './useSocialMode.js';

/**
 * The one social-mode switch, shared by Settings on both hosts and the
 * first-run Preferences. Off is the plain register: no character in how
 * gezels talk, growth out of sight, no greeting card.
 */
export function SocialModeToggle({ describe = true }: { describe?: boolean }) {
  const social = useSocialMode();
  const [error, setError] = useState('');
  const save = async (on: boolean) => {
    setError('');
    try {
      const config = await api.updateConfig({ social: on });
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: config }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <>
      {describe && (
        <p className="muted" style={{ marginTop: 0 }}>
          Gezels show their own character in how they talk, their growth is on display, and opening
          a chat shows what is waiting for you.
        </p>
      )}
      <label className="debug-toggle" style={{ marginTop: 0 }}>
        <input
          type="checkbox"
          checked={social}
          onChange={(event) => void save(event.target.checked)}
        />
        <span>Social mode</span>
      </label>
      {error && <p className="error">{error}</p>}
    </>
  );
}
