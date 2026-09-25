import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ChatNarrationMode } from './chat-narration.js';

interface NarrationFlags {
  narrateAssistantReplies?: boolean;
  narrateProgressUpdates?: boolean;
}

function modeFrom(flags: NarrationFlags): ChatNarrationMode {
  if (flags.narrateAssistantReplies !== true) return 'off';
  return flags.narrateProgressUpdates === false ? 'replies' : 'progress';
}

/**
 * Subscribes the chat narration settings (config.narrateAssistantReplies
 * and its sub-option config.narrateProgressUpdates) into a component.
 *
 * Mirrors {@link useRoleBasedNameOnlyMode} — listens for the
 * `gezel:config-updated` custom event so a Settings toggle propagates to
 * any mounted chat without a route change.
 */
export function useChatNarrationMode(): ChatNarrationMode {
  const [flags, setFlags] = useState<NarrationFlags>({});

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setFlags({
          narrateAssistantReplies: cfg.narrateAssistantReplies,
          narrateProgressUpdates: cfg.narrateProgressUpdates,
        });
      })
      .catch(() => {});
    const onConfigUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as NarrationFlags | undefined;
      if (!detail) return;
      setFlags((prev) => ({
        narrateAssistantReplies:
          typeof detail.narrateAssistantReplies === 'boolean'
            ? detail.narrateAssistantReplies
            : prev.narrateAssistantReplies,
        narrateProgressUpdates:
          typeof detail.narrateProgressUpdates === 'boolean'
            ? detail.narrateProgressUpdates
            : prev.narrateProgressUpdates,
      }));
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onConfigUpdated);
    };
  }, []);

  return modeFrom(flags);
}
