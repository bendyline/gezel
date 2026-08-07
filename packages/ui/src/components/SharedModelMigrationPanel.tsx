import type {
  GezmodelEngine,
  SharedModelMigrationCandidate,
  SharedModelMigrationResult,
} from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  MODEL_INVENTORY_CHANGED_EVENT,
  announceModelInventoryChanged,
  changedModelInventoryEngine,
} from '../model-inventory.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export function SharedModelMigrationPanel({
  engine,
  onModelsChanged,
}: {
  engine: GezmodelEngine;
  onModelsChanged?: () => void;
}) {
  const [available, setAvailable] = useState(false);
  const [candidates, setCandidates] = useState<SharedModelMigrationCandidate[]>([]);
  const [selected, setSelected] = useState<SharedModelMigrationCandidate | null>(null);
  const [moving, setMoving] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    kind: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.listSharedModelMigrationCandidates(engine);
      setAvailable(result.available);
      setCandidates(result.candidates);
    } catch {
      // This is an optional capability and older daemons do not expose it.
      // Keep the model-management screen usable and simply hide the panel.
      setAvailable(false);
      setCandidates([]);
    }
  }, [engine]);

  useEffect(() => {
    void refresh();
    const onChanged = (event: Event) => {
      const changedEngine = changedModelInventoryEngine(event);
      if (changedEngine === engine) void refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onChanged);
  }, [engine, refresh]);

  useEffect(() => {
    if (!candidates.some((candidate) => candidate.moving)) return;
    const timer = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(timer);
  }, [candidates, refresh]);

  const move = useCallback(
    async (candidate: SharedModelMigrationCandidate) => {
      const key = candidateKey(candidate);
      setSelected(null);
      setMoving(key);
      setNotice(null);
      try {
        const result = await api.moveModelToShared({
          source: candidate.source,
          engine: candidate.engine,
          id: candidate.id,
        });
        setNotice(noticeFor(result, candidate.name));
        announceModelInventoryChanged(candidate.engine);
        onModelsChanged?.();
        await refresh();
      } catch (error) {
        const message = describe(error);
        if (message.includes('already being moved')) {
          // The move may have started from an earlier mount of this panel.
          // Reconcile with the daemon instead of presenting its lock as an error.
          await refresh();
        } else {
          setNotice({ kind: 'error', text: message });
        }
      } finally {
        setMoving(null);
      }
    },
    [onModelsChanged, refresh],
  );

  const moveInProgress = moving !== null || candidates.some((candidate) => candidate.moving);

  if ((!available || candidates.length === 0) && !notice) return null;

  return (
    <div className="ollama-section shared-model-migration" aria-live="polite">
      <h4>Models ready to share</h4>
      <p className="muted small shared-model-migration-copy">
        These up-to-date models are using space in a private Gezel folder. Move them to the shared
        model library so every account on this device can use one verified copy.
      </p>

      {notice && (
        <p
          className={notice.kind === 'error' ? 'error small' : 'muted small'}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.text}
        </p>
      )}

      {available && candidates.length > 0 && (
        <ul className="shared-model-migration-list">
          {candidates.map((candidate) => {
            const key = candidateKey(candidate);
            const isMoving = moving === key || candidate.moving;
            return (
              <li key={key}>
                <div>
                  <strong>{candidate.name}</strong>
                  <span className="muted small">
                    {candidate.sourceLabel} · {formatBytes(candidate.approxSizeBytes)}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={moveInProgress}
                  onClick={() => setSelected(candidate)}
                >
                  {isMoving ? 'Moving and verifying…' : 'Move to shared location'}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <ConfirmDialog
        open={selected !== null}
        title={`Move ${selected?.name ?? 'model'} to the shared library?`}
        message={
          <>
            Gezel will copy and verify the complete model through the machine service, publish it
            atomically, and only then remove the private copy from{' '}
            {selected?.sourceLabel ?? 'this folder'}. Other accounts on this device will be able to
            use the shared model.
          </>
        }
        confirmLabel="Move model"
        onConfirm={() => (selected ? move(selected) : undefined)}
        onCancel={() => setSelected(null)}
      />
    </div>
  );
}

function candidateKey(candidate: SharedModelMigrationCandidate): string {
  return `${candidate.source}:${candidate.engine}:${candidate.id}`;
}

function noticeFor(
  result: SharedModelMigrationResult,
  name: string,
): { kind: 'success' | 'warning'; text: string } {
  if (result.warning) return { kind: 'warning', text: result.warning };
  return { kind: 'success', text: `${name} is now in the shared model library.` };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(0)} MB`;
  return `${bytes} B`;
}

function describe(error: unknown): string {
  if (error instanceof GezelApiError) {
    const details = error.details;
    if (details && typeof details === 'object' && 'error' in details) {
      const message = (details as { error?: unknown }).error;
      if (typeof message === 'string' && message.length > 0) return message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
