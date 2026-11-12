import {
  type InterestAreaId,
  interestAreasToSave,
  resolveInterestAreas,
  shouldAskInterests,
} from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useRef } from 'react';
import { api } from '../api.js';
import { setRead } from '../data/api-reads.js';
import { useApiRead } from '../data/use-api-read.js';

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

function interestSlice(config: ConfigResponse): InterestConfig {
  const source = config as InterestConfig;
  return {
    interests: source.interests,
    firstUseAt: source.firstUseAt,
    securityPolicy: source.securityPolicy,
  };
}

/**
 * The person's interest areas, from the shared config read. Every surface
 * that orders work reads them here, and a save from any one of them reaches
 * the others through the same cache.
 */
export function useInterests(): InterestsState {
  const config = useApiRead('getConfig', [], { select: interestSlice }).data;
  const latest = useRef<InterestConfig | undefined>(config);
  latest.current = config;

  const save = useCallback(async (next: readonly InterestAreaId[]) => {
    const interests = {
      areas: interestAreasToSave(latest.current, next),
      askedAt: new Date().toISOString(),
    };
    setRead(
      'getConfig',
      [],
      (previous) => ({ ...(previous ?? {}), interests }) as unknown as ConfigResponse,
    );
    try {
      await api.updateConfig({ interests });
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: { interests } }));
    } catch {
      // The keys stay as pressed; the next load shows what was saved.
    }
  }, []);

  return {
    loaded: config !== undefined,
    areas: resolveInterestAreas(config),
    ask: shouldAskInterests(config, Date.now()),
    appNetwork: config?.securityPolicy?.allowAppNetwork !== false,
    save,
  };
}
