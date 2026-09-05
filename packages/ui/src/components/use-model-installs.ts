import { useCallback, useEffect, useRef, useState } from 'react';
import { announceModelInventoryChanged } from '../model-inventory.js';
import type { ModelInstallEvent, ModelManagementAdapter } from './model-management-adapters.js';

export interface ActiveModelInstall {
  catalogId: string;
  bytesWritten: number;
  totalBytes: number;
  fileIndex: number;
  fileCount: number;
  file: string;
  phase: 'downloading' | 'verifying' | 'extracting-metadata';
  retrying?: { attempt: number; maxAttempts: number; delayMs: number; reason: string };
  error?: string;
  /** SSE attachment ownership; both origins are server jobs and support explicit cancellation. */
  origin: 'local' | 'remote';
  controller?: AbortController;
}

/** Owns install attempts, stream attachment, retry, and polling reconciliation. */
export function useModelInstalls<M extends { id: string }>(
  adapter: ModelManagementAdapter<M>,
  refresh: () => Promise<void>,
  onModelsChanged?: () => void,
) {
  const [installs, renderInstalls] = useState(new Map<string, ActiveModelInstall>());
  // Synchronous ownership prevents double starts and stale finalizers deleting a retry.
  const current = useRef(installs);
  const mounted = useRef(true);
  const [installWarning, setInstallWarning] = useState<{ id: string; message: string } | null>(
    null,
  );
  const [installError, setInstallError] = useState<string | null>(null);
  const [installMismatch, setInstallMismatch] = useState<{
    catalogId: string;
    file: string;
  } | null>(null);
  const update = useCallback((change: (next: Map<string, ActiveModelInstall>) => void) => {
    if (!mounted.current) return;
    const next = new Map(current.current);
    change(next);
    current.current = next;
    renderInstalls(next);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Detach only. Unmounting a view must never cancel a server-owned download.
      for (const install of current.current.values()) install.controller?.abort();
      current.current = new Map();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousRemoteIds = new Set<string>();
    const tick = async () => {
      try {
        const { installs: remoteInstalls } = await adapter.active();
        if (cancelled) return;
        const seen = new Set(remoteInstalls.map((entry) => entry.catalogId));
        update((next) => {
          for (const remote of remoteInstalls) {
            if (next.get(remote.catalogId)?.origin === 'local') continue;
            next.set(remote.catalogId, {
              ...remote,
              fileIndex: 0,
              fileCount: 1,
              file: '',
              origin: 'remote',
            });
          }
          for (const [id, entry] of next) {
            if (entry.origin === 'remote' && !seen.has(id)) next.delete(id);
          }
        });
        if ([...previousRemoteIds].some((id) => !seen.has(id))) void refresh();
        previousRemoteIds = seen;
      } catch {
        /* advisory; retain the last snapshot */
      }
      if (!cancelled) timer = setTimeout(() => void tick(), 2_000);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [adapter, refresh, update]);

  const startInstall = useCallback(
    (catalogId: string, opts?: { skipSha?: boolean }) => {
      if (current.current.has(catalogId)) return;
      setInstallError(null);
      setInstallMismatch(null);
      const controller = new AbortController();
      update((next) =>
        next.set(catalogId, {
          catalogId,
          bytesWritten: 0,
          totalBytes: 0,
          fileIndex: 0,
          fileCount: 1,
          file: '',
          phase: 'downloading',
          origin: 'local',
          controller,
        }),
      );
      const ownsAttempt = () =>
        mounted.current && current.current.get(catalogId)?.controller === controller;
      const handleEvent = (ev: ModelInstallEvent) => {
        if (!ownsAttempt()) return;
        if (ev.type === 'done') {
          if (ev.warning) setInstallWarning({ id: ev.id, message: ev.warning });
        } else if (ev.type === 'error' && ev.mismatch) {
          update((next) => next.delete(catalogId));
          setInstallMismatch({ catalogId, file: ev.mismatch!.file });
        } else {
          update((next) => {
            const cur = next.get(catalogId)!;
            if (ev.type === 'progress') {
              next.set(catalogId, {
                ...cur,
                bytesWritten: ev.bytesWritten,
                totalBytes: ev.totalBytes || cur.totalBytes,
                file: ev.file ?? cur.file,
                fileIndex: ev.fileIndex ?? cur.fileIndex,
                fileCount: ev.fileCount ?? cur.fileCount,
                phase: 'downloading',
                retrying: undefined,
                error: undefined,
              });
            } else if (ev.type === 'retrying') next.set(catalogId, { ...cur, retrying: ev });
            else if (ev.type === 'verifying' || ev.type === 'extracting-metadata')
              next.set(catalogId, { ...cur, phase: ev.type, file: ev.file ?? cur.file });
            else if (ev.type === 'error')
              next.set(catalogId, { ...cur, error: ev.error, retrying: undefined });
          });
          if (ev.type === 'error') setInstallError(ev.error);
        }
      };
      void (async () => {
        try {
          await adapter.install(
            catalogId,
            handleEvent,
            controller.signal,
            opts?.skipSha ? { skipSha: true } : undefined,
          );
          if (ownsAttempt()) announceModelInventoryChanged(adapter.engine);
        } catch (err) {
          if (ownsAttempt() && !controller.signal.aborted) {
            const message = `download failed: ${err instanceof Error ? err.message : String(err)}`;
            setInstallError(message);
            update((next) => {
              const cur = next.get(catalogId)!;
              next.set(catalogId, { ...cur, error: cur.error ?? message, retrying: undefined });
            });
          }
        } finally {
          if (ownsAttempt())
            update((next) => {
              const cur = next.get(catalogId)!;
              if (cur.error) next.set(catalogId, { ...cur, controller: undefined });
              else next.delete(catalogId);
            });
          if (mounted.current) {
            void refresh();
            onModelsChanged?.();
          }
        }
      })();
    },
    [adapter, refresh, onModelsChanged, update],
  );

  const retryInstall = useCallback(
    (id: string) => {
      if (!current.current.get(id)?.error) return;
      current.current.get(id)?.controller?.abort();
      update((next) => next.delete(id));
      startInstall(id);
    },
    [startInstall, update],
  );

  const cancelInstall = useCallback(
    (id: string) => {
      current.current.get(id)?.controller?.abort();
      update((next) => next.delete(id));
      void adapter.cancel(id).catch((err: unknown) => {
        if (mounted.current)
          setInstallError(`cancel failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },
    [adapter, update],
  );

  const downloadAnyway = useCallback(
    (id: string) => startInstall(id, { skipSha: true }),
    [startInstall],
  );
  return {
    installs,
    installWarning,
    setInstallWarning,
    installError,
    setInstallError,
    installMismatch,
    setInstallMismatch,
    startInstall,
    retryInstall,
    cancelInstall,
    downloadAnyway,
  };
}
