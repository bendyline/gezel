import type {
  IncompleteModelDownload,
  ModelFitnessEntry,
  UnrecognizedLocalModel,
} from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  announceModelInventoryChanged,
  changedModelInventoryEngine,
} from '../model-inventory.js';
import type { ModelManagementAdapter } from './model-management-adapters.js';
import { useModelInstalls } from './use-model-installs.js';

/** Shared inventory/controller; capability checks, model fit, and layout stay in each panel. */
export function useLocalModelManager<M extends { id: string }>(
  adapter: ModelManagementAdapter<M>,
  onModelsChanged?: () => void,
) {
  const [models, setModels] = useState<M[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [incomplete, setIncomplete] = useState<IncompleteModelDownload[]>([]);
  const [unrecognized, setUnrecognized] = useState<UnrecognizedLocalModel[]>([]);
  const [toDelete, setToDelete] = useState<string | null>(null);
  const [fitness, setFitness] = useState(new Map<string, ModelFitnessEntry>());
  const [probing, setProbing] = useState<string[]>([]);
  const probingRef = useRef<string[]>([]);
  const inFlight = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshFitness = useCallback(async () => {
    try {
      const res = await api.listModelFitness();
      if (!mounted.current) return;
      setFitness(new Map(res.records.map((record) => [record.key, record])));
      setProbing(res.probing);
      probingRef.current = res.probing;
    } catch {
      /* fitness is advisory */
    }
  }, []);

  const refresh = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    setModelsLoading(true);
    const run = (async () => {
      try {
        const res = await adapter.list();
        if (!mounted.current) return;
        setModels(res.models);
        setUnrecognized(res.unrecognized ?? []);
        setModelsError(null);
      } catch (err) {
        if (mounted.current) setModelsError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted.current) setModelsLoading(false);
      }
      void refreshFitness();
      try {
        const res = await adapter.incomplete();
        if (mounted.current) setIncomplete(res.incomplete ?? []);
      } catch {
        /* interrupted-download inventory is advisory */
      }
    })();
    inFlight.current = run;
    void run.then(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    return run;
  }, [adapter, refreshFitness]);

  useEffect(() => {
    void refresh();
    const onChanged = (event: Event) => {
      if (changedModelInventoryEngine(event) === adapter.engine) void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [adapter, refresh]);

  // Fitness gets its own non-overlapping poll; slow download polling cannot block it.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const loop = async () => {
      await refreshFitness();
      if (!cancelled)
        timer = setTimeout(() => void loop(), probingRef.current.length ? 2_000 : 15_000);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [refreshFitness]);

  const deleteOne = useCallback(async () => {
    const id = toDelete;
    if (!id) return;
    setToDelete(null);
    setModelsError(null);
    setModels((cur) => cur.filter((model) => model.id !== id));
    setIncomplete((cur) => cur.filter((model) => model.id !== id));
    setUnrecognized((cur) => cur.filter((model) => model.id !== id));
    try {
      await adapter.remove(id);
      if (!mounted.current) return;
      announceModelInventoryChanged(adapter.engine);
      await refresh();
      onModelsChanged?.();
    } catch (err) {
      // Refresh first so success of the inventory read doesn't erase the deletion error.
      await refresh();
      if (mounted.current)
        setModelsError(`delete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [adapter, toDelete, refresh, onModelsChanged]);

  const installs = useModelInstalls(adapter, refresh, onModelsChanged);
  return {
    models,
    modelsError,
    modelsLoading,
    incomplete,
    unrecognized,
    toDelete,
    setToDelete,
    fitness,
    probing,
    refreshFitness,
    refresh,
    deleteOne,
    ...installs,
  };
}
