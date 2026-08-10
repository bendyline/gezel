import type { GezmodelEngine, GezmodelImportReview } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { announceModelInventoryChanged } from '../model-inventory.js';
import { Dialog } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface OpenedBundleRequest {
  requestId: string;
  filename: string;
}

/** Small Models-screen affordance; the global controller owns the file input. */
export function ImportModelBundleButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className}
      onClick={() => window.dispatchEvent(new Event('gezel:import-model-bundle'))}
    >
      Import .gezmodel
    </button>
  );
}

/** Per-installed-model export link with native streaming-save support. */
export function ExportModelBundleButton({
  engine,
  id,
}: {
  engine: GezmodelEngine;
  id: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const native = window.__GEZEL__?.exportModelBundle;
      if (native) {
        const result = await native(engine, id);
        if (!result.ok) throw new Error(result.error);
        return;
      }
      const response = await api.exportModelBundle(engine, id);
      await saveInBrowser(response, `${portableFilename(id)}.gezmodel`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, engine, id]);

  return (
    <>
      <button type="button" className="home-link" disabled={busy} onClick={() => void run()}>
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {error && (
        <span className="error small" style={{ marginLeft: '0.5rem' }}>
          {error}
        </span>
      )}
    </>
  );
}

/**
 * One application-wide import controller. It handles both the Models-screen
 * file input and opaque file-open requests from the Electron main process.
 */
export function ModelBundleImportController({
  onEngineIdentified,
}: {
  onEngineIdentified?: (engine: GezmodelEngine) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [review, setReview] = useState<GezmodelImportReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const acceptReview = useCallback(
    (next: GezmodelImportReview) => {
      setReview(next);
      setError(null);
      onEngineIdentified?.(next.manifest.engine);
    },
    [onEngineIdentified],
  );

  const scanFile = useCallback(
    async (file: File) => {
      setScanning(file.name);
      setError(null);
      try {
        acceptReview(await api.scanModelBundle(file));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(null);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [acceptReview],
  );

  const scanOpened = useCallback(
    async (request: OpenedBundleRequest) => {
      const native = window.__GEZEL__?.scanOpenedModelBundle;
      if (!native) return;
      setScanning(request.filename);
      setError(null);
      try {
        const result = await native(request.requestId);
        if (!result.ok) throw new Error(result.error);
        acceptReview(result.review);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(null);
      }
    },
    [acceptReview],
  );

  useEffect(() => {
    const openPicker = () => inputRef.current?.click();
    window.addEventListener('gezel:import-model-bundle', openPicker);
    window.__GEZEL__?.onOpenModelBundle?.((request) => void scanOpened(request));
    return () => window.removeEventListener('gezel:import-model-bundle', openPicker);
  }, [scanOpened]);

  const cancelReview = useCallback(() => {
    const current = review;
    setReview(null);
    setError(null);
    if (current) void api.cancelModelBundleImport(current.importId).catch(() => {});
  }, [review]);

  const confirm = useCallback(async () => {
    if (!review) return;
    try {
      await api.confirmModelBundleImport(review.importId, review.alreadyInstalled);
      const engine = review.manifest.engine;
      setReview(null);
      setError(null);
      announceModelInventoryChanged(engine);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [review]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".gezmodel,application/vnd.gezel.model+zip,application/zip"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) void scanFile(file);
        }}
      />

      <Dialog.Root open={Boolean(scanning || (error && !review))}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content
            onEscapeKeyDown={(event) => {
              if (scanning) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (scanning) event.preventDefault();
            }}
          >
            <Dialog.Title asChild>
              <h3>{scanning ? 'Checking model bundle' : 'Model bundle could not be imported'}</h3>
            </Dialog.Title>
            <Dialog.Description className={scanning ? 'muted small' : 'error small'}>
              {scanning
                ? `Scanning ${scanning} for unsafe paths, executable content, malformed model files, and checksum mismatches. Large models can take a few minutes.`
                : error}
            </Dialog.Description>
            {!scanning && (
              <Dialog.Actions>
                <Dialog.Close asChild>
                  <button type="button" onClick={() => setError(null)}>
                    Close
                  </button>
                </Dialog.Close>
              </Dialog.Actions>
            )}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={Boolean(review)}
        title={review?.alreadyInstalled ? 'Replace local model?' : 'Import this model?'}
        confirmLabel={review?.alreadyInstalled ? 'Replace model' : 'Import model'}
        danger={Boolean(review?.alreadyInstalled)}
        message={review ? <ImportReview review={review} error={error} /> : undefined}
        onConfirm={confirm}
        onCancel={cancelReview}
      />
    </>
  );
}

function ImportReview({ review, error }: { review: GezmodelImportReview; error: string | null }) {
  const license = review.manifest.license;
  const modelFiles = review.manifest.files.filter((file) => file.role === 'model').length;
  return (
    <span style={{ display: 'grid', gap: '0.45rem' }}>
      <span>
        <strong>{review.manifest.name}</strong> ({review.manifest.engine})
      </span>
      <span>
        {formatBytes(review.manifest.approxSizeBytes)} across {modelFiles}{' '}
        {modelFiles === 1 ? 'model file' : 'model files'}
      </span>
      <span>License: {license?.shortName ?? license?.name ?? 'not provided'}</span>
      <span>
        Security scan passed: every archived file is declared, contained, data-only, and SHA-256
        verified. This confirms bundle integrity, not the publisher's identity.
      </span>
      {review.alreadyInstalled && <span>The existing copy will be replaced atomically.</span>}
      {review.warnings.map((warning) => (
        <span className="error" key={warning}>
          {warning}
        </span>
      ))}
      {error && <span className="error">{error}</span>}
    </span>
  );
}

async function saveInBrowser(response: Response, suggestedName: string): Promise<void> {
  const picker = (
    window as typeof window & {
      showSaveFilePicker?: (opts: {
        suggestedName: string;
        types: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
    }
  ).showSaveFilePicker;
  if (picker && response.body) {
    const handle = await picker({
      suggestedName,
      types: [
        {
          description: 'Gezel model bundle',
          accept: { 'application/vnd.gezel.model+zip': ['.gezmodel'] },
        },
      ],
    });
    await response.body.pipeTo(await handle.createWritable());
    return;
  }

  // Compatibility fallback for browsers without the File System Access API.
  // The Electron shell and Chromium desktop path above both stream to disk.
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function portableFilename(id: string): string {
  return id.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '') || 'model';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}
