import { useState } from 'react';
import { api } from '../api.js';
import { SettingCheck } from './SettingsSection.js';
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
      <SettingCheck
        label="Social mode"
        hint={
          describe
            ? 'Crew members show their own character in how they talk, their growth is on display, and opening a chat shows what is waiting for you.'
            : undefined
        }
        checked={social}
        onChange={(checked) => void save(checked)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
