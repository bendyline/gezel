import type {
  HarnessBlock,
  HarnessClientId,
  HarnessToolsClientStatus,
  HarnessToolsConfigUpdate,
  HarnessToolsSetupRequest,
  HarnessToolsStatusResponse,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { harnessApiErrorMessage } from '../harness-setup/useHarnessSetupCard.js';

/** Live connections change while the page is open; app setups rarely do. */
const REFRESH_MS = 10_000;

export interface HarnessTools {
  status: HarnessToolsStatusResponse | null;
  error: string | null;
  /** The action in flight, e.g. `configure:cursor`, so its button can say so. */
  busy: string | null;
  refresh: () => Promise<void>;
  updateConfig: (update: HarnessToolsConfigUpdate) => Promise<void>;
  configure: (client: HarnessClientId, req?: HarnessToolsSetupRequest) => Promise<boolean>;
  remove: (client: HarnessClientId) => Promise<boolean>;
  stop: (appId: string) => Promise<void>;
  unblock: (block: HarnessBlock) => Promise<void>;
  client: (client: HarnessClientId) => HarnessToolsClientStatus | undefined;
}

/**
 * Gezel's tools in other apps, for the whole Integrations page: one status
 * the Overview section and every app's tab read, so a change on one shows on
 * the others at once.
 */
export function useHarnessTools(): HarnessTools {
  const [status, setStatus] = useState<HarnessToolsStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getHarnessTools());
      setError(null);
    } catch (err) {
      setError(`Could not check Gezel's tools in other apps — ${harnessApiErrorMessage(err)}`);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!busyRef.current) void refresh();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>, failure: string): Promise<boolean> => {
      busyRef.current = key;
      setBusy(key);
      setError(null);
      try {
        await fn();
        await refresh();
        return true;
      } catch (err) {
        setError(`${failure} — ${harnessApiErrorMessage(err)}`);
        return false;
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
    },
    [refresh],
  );

  return {
    status,
    error,
    busy,
    refresh,
    updateConfig: async (update) => {
      await run(
        'config',
        async () => setStatus(await api.updateHarnessToolsConfig(update)),
        'Could not save the change',
      );
    },
    configure: (client, req = {}) =>
      run(
        `configure:${client}`,
        () => api.configureHarnessTools(client, req),
        'Could not set it up',
      ),
    remove: (client) =>
      run(`remove:${client}`, () => api.removeHarnessTools(client), 'Could not remove the setup'),
    stop: async (appId) => {
      await run(
        `stop:${appId}`,
        async () => setStatus(await api.stopHarnessConnection(appId)),
        'Could not stop it',
      );
    },
    unblock: async (block) => {
      await run(
        `unblock:${block.client}:${block.projectId}`,
        async () => setStatus(await api.unblockHarness(block)),
        'Could not turn it back on',
      );
    },
    client: (id) => status?.clients.find((c) => c.client === id),
  };
}
