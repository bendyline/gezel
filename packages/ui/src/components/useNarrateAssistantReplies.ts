import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Subscribes the "narrate assistant replies" flag
 * (config.narrateAssistantReplies) into a component. When true, the chat
 * UI plays a TTS rendering of each completed assistant message using
 * the speaking gezel's per-character voice.
 *
 * Mirrors {@link useRoleBasedNameOnlyMode} — listens for the
 * `gezel:config-updated` custom event so a SettingsView toggle
 * propagates to any mounted chat without a route change.
 */
export function useNarrateAssistantReplies(): boolean {
  const [on, setOn] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setOn(cfg.narrateAssistantReplies ?? false);
      })
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as { narrateAssistantReplies?: boolean } | undefined;
      if (detail && typeof detail.narrateAssistantReplies === 'boolean') {
        setOn(detail.narrateAssistantReplies);
      }
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onConfigUpdated);
    };
  }, []);

  return on;
}
