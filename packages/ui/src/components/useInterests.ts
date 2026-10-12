import {
  type InterestAreaId,
  interestAreasToSave,
  resolveInterestAreas,
  shouldAskInterests,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

/** The slice of config interests read. */
interface InterestConfig {
  interests?: { areas?: string[]; askedAt?: string };
  firstUseAt?: string;
  securityPolicy?: { allowAppNetwork?: boolean };
}

export interface InterestsState {
  /** Loaded from config; false until the first read answers. */
  loaded: boolean;
  /** The person's areas, in the order picked. */
  areas: InterestAreaId[];
  /** The welcome may ask (a new install that has not answered or skipped). */
  ask: boolean;
  /** The security policy lets the app download (knowledge offers hide when it does not). */
  appNetwork: boolean;
  /** Save a new choice; stamps `askedAt`, so the welcome stops asking. */
  save(next: readonly InterestAreaId[]): Promise<void>;
}

/**
 * The person's interest areas, from config. Every surface that orders work
 * reads them here, and a save from any one of them reaches the others
 * through `gezel:config-updated`.
 */
export function useInterests(): InterestsState {
  const [config, setConfig] = useState<InterestConfig | null>(null);
  const latest = useRef<InterestConfig | null>(null);
  latest.current = config;

  useEffect(() => {
    let cancelled = false;
    api
      .getConfig()
      .then((cfg) => {
        if (!cancelled) setConfig(cfg as InterestConfig);
      })
      .catch(() => {});
    const onUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail as InterestConfig | undefined;
      if (detail && 'interests' in detail) {
        setConfig((prev) => ({ ...(prev ?? {}), interests: detail.interests }));
      }
    };
    window.addEventListener('gezel:config-updated', onUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onUpdated);
    };
  }, []);

  const save = useCallback(async (next: readonly InterestAreaId[]) => {
    const interests = {
      areas: interestAreasToSave(latest.current, next),
      askedAt: new Date().toISOString(),
    };
    setConfig((prev) => ({ ...(prev ?? {}), interests }));
    try {
      await api.updateConfig({ interests });
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: { interests } }));
    } catch {
      // The keys stay as pressed; the next load shows what was saved.
    }
  }, []);

  return {
    loaded: config !== null,
    areas: resolveInterestAreas(config),
    ask: shouldAskInterests(config, Date.now()),
    appNetwork: config?.securityPolicy?.allowAppNetwork !== false,
    save,
  };
}
