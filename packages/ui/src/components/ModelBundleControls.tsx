import type {
  GezmodelEngine,
  GezmodelImportProgress,
  GezmodelImportReview,
} from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type ModelBundleExportProgress, api } from '../api.js';
import { announceModelInventoryChanged } from '../model-inventory.js';
import { Dialog } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

interface OpenedBundleRequest {
  requestId: string;
  filename: string;
}

interface ActiveBundleScan {
  scanId: string;
  filename: string;
  source: 'browser' | 'native';
  progress: GezmodelImportProgress;
}

interface ActiveBundleScanOperation {
  scanId: string;
  source: ActiveBundleScan['source'];
  controller?: AbortController;
  canceled: boolean;
}

export type ModelBundleExportState =
  | { phase: 'idle' }
  | ({ phase: 'preparing' } & Pick<ModelBundleExportProgress, 'filename'>)
  | ({ phase: 'writing' | 'verifying' } & Pick<
      Extract<ModelBundleExportProgress, { phase: 'writing' | 'verifying' }>,
      'filename' | 'bytesCompleted' | 'bytesTotal'
    >)
  | {
      phase: 'complete';
      filename: string;
      bytesWritten: number;
      verified: boolean;
    }
  | { phase: 'error'; filename: string; message: string };

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

/**
 * Export flow shared by the standalone button and the per-row actions menu:
 * native streaming save when the Electron bridge is present, browser
 * save-picker fallback otherwise.
 */
export function useExportModelBundle(
  engine: GezmodelEngine,
  id: string,
): {
  run: () => Promise<void>;
  busy: boolean;
  canceling: boolean;
  error: string | null;
  progress: ModelBundleExportState;
  cancel: () => Promise<void>;
  /** Absent when the shell has no skip bridge; the browser path never verifies. */
  skipVerification: (() => Promise<void>) | undefined;
  skippingVerification: boolean;
  dismissProgress: () => void;
} {
  const [busy, setBusy] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [skippingVerification, setSkippingVerification] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ModelBundleExportState>({ phase: 'idle' });
  const exportIdRef = useRef<string | null>(null);
  const browserAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const subscribe = window.__GEZEL__?.onModelBundleExportProgress;
    if (!subscribe) return;
    return subscribe((next) => {
      if (next.exportId !== exportIdRef.current) return;
      if (next.phase === 'preparing') {
        setProgress({ phase: next.phase, filename: next.filename });
      } else {
        setProgress({
          phase: next.phase,
          filename: next.filename,
          bytesCompleted: next.bytesCompleted,
          ...(next.bytesTotal === undefined ? {} : { bytesTotal: next.bytesTotal }),
        });
      }
    });
  }, []);

  useEffect(() => {
    return () => {
      browserAbortRef.current?.abort();
      const exportId = exportIdRef.current;
      if (exportId) void window.__GEZEL__?.cancelModelBundleExport?.(exportId);
    };
  }, []);

  const run = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setCanceling(false);
    setSkippingVerification(false);
    setError(null);
    const filename = `${portableFilename(id)}.gezmodel`;
    try {
      const native = window.__GEZEL__?.exportModelBundle;
      if (native) {
        const exportId = globalThis.crypto.randomUUID();
        exportIdRef.current = exportId;
        const result = await native(engine, id, exportId);
        if (!result.ok) throw new Error(result.error);
        if (result.canceled) {
          setProgress({ phase: 'idle' });
          return;
        }
        setProgress({
          phase: 'complete',
          filename: result.path.split(/[\\/]/).pop() || filename,
          bytesWritten: result.bytesWritten,
          verified: result.verified,
        });
        return;
      }

      const controller = new AbortController();
      browserAbortRef.current = controller;
      setProgress({ phase: 'preparing', filename });
      const response = await api.exportModelBundle(engine, id, controller.signal);
      const saved = await saveInBrowser(
        response,
        filename,
        (bytesCompleted, bytesTotal) => {
          setProgress({ phase: 'writing', filename, bytesCompleted, bytesTotal });
        },
        controller.signal,
      );
      setProgress({
        phase: 'complete',
        filename,
        bytesWritten: saved.bytesWritten,
        verified: false,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'name' in err && err.name === 'AbortError') {
        setProgress({ phase: 'idle' });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setProgress({ phase: 'error', filename, message });
    } finally {
      browserAbortRef.current = null;
      exportIdRef.current = null;
      setCanceling(false);
      setSkippingVerification(false);
      setBusy(false);
    }
  }, [busy, engine, id]);

  const cancel = useCallback(async () => {
    if (!busy || canceling) return;
    setCanceling(true);
    const exportId = exportIdRef.current;
    try {
      if (exportId) {
        const nativeCancel = window.__GEZEL__?.cancelModelBundleExport;
        if (!nativeCancel) throw new Error('This version of Gezel cannot cancel native exports.');
        const result = await nativeCancel(exportId);
        if (!result.ok) throw new Error(result.error);
      } else {
        browserAbortRef.current?.abort();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCanceling(false);
    }
  }, [busy, canceling]);

  const nativeSkip = window.__GEZEL__?.skipModelBundleExportVerification;
  const skipVerification = useCallback(async () => {
    if (!nativeSkip || canceling || skippingVerification) return;
    const exportId = exportIdRef.current;
    if (!exportId) return;
    setSkippingVerification(true);
    try {
      const result = await nativeSkip(exportId);
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSkippingVerification(false);
    }
  }, [canceling, nativeSkip, skippingVerification]);

  const dismissProgress = useCallback(() => {
    setProgress({ phase: 'idle' });
    setError(null);
  }, []);
  return {
    run,
    busy,
    canceling,
    error,
    progress,
    cancel,
    skipVerification: nativeSkip ? skipVerification : undefined,
    skippingVerification,
    dismissProgress,
  };
}

/** Per-installed-model export link with native streaming-save support. */
export function ExportModelBundleButton({
  engine,
  id,
}: {
  engine: GezmodelEngine;
  id: string;
}) {
  const {
    run,
    busy,
    canceling,
    error,
    progress,
    cancel,
    skipVerification,
    skippingVerification,
    dismissProgress,
  } = useExportModelBundle(engine, id);

  return (
    <>
      <button type="button" className="gz-link-button" disabled={busy} onClick={() => void run()}>
        {busy ? 'Exporting…' : 'Export'}
      </button>
      {error && (
        <span className="error small" style={{ marginLeft: '0.5rem' }}>
          {error}
        </span>
      )}
      <ModelBundleExportProgressDialog
        state={progress}
        canceling={canceling}
        onCancel={cancel}
        onSkipVerification={skipVerification}
        skippingVerification={skippingVerification}
        onDismiss={dismissProgress}
      />
    </>
  );
}

export function ModelBundleExportProgressDialog({
  state,
  canceling,
  onCancel,
  onSkipVerification,
  skippingVerification = false,
  onDismiss,
}: {
  state: ModelBundleExportState;
  canceling: boolean;
  onCancel: () => Promise<void>;
  onSkipVerification?: (() => Promise<void>) | undefined;
  skippingVerification?: boolean;
  onDismiss: () => void;
}) {
  if (state.phase === 'idle') return null;
  const active =
    state.phase === 'preparing' || state.phase === 'writing' || state.phase === 'verifying';
  const meter =
    (state.phase === 'writing' || state.phase === 'verifying') &&
    state.bytesTotal !== undefined &&
    state.bytesTotal > 0
      ? {
          max: state.bytesTotal,
          value: Math.min(state.bytesCompleted, state.bytesTotal),
        }
      : null;
  const progressLabel =
    state.phase === 'preparing'
      ? 'Preparing model bundle'
      : state.phase === 'writing'
        ? 'Model bundle write progress'
        : state.phase === 'verifying'
          ? 'Model bundle verification progress'
          : undefined;

  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className="model-export-dialog"
          onEscapeKeyDown={(event) => {
            if (active) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (active) event.preventDefault();
          }}
        >
          <Dialog.Title asChild>
            <h3>
              {state.phase === 'complete'
                ? 'Model exported'
                : state.phase === 'error'
                  ? 'Model could not be exported'
                  : `Exporting ${state.filename}`}
            </h3>
          </Dialog.Title>
          <Dialog.Description asChild>
            <div className="model-export-dialog-body">
              {state.phase === 'preparing' && (
                <p>
                  Preparing and hashing the model before writing the bundle. Large models can take
                  several minutes before the first bytes are ready.
                </p>
              )}
              {state.phase === 'writing' && (
                <p>
                  Writing the bundle to the selected file. Keep Gezel open until verification
                  finishes.
                </p>
              )}
              {state.phase === 'verifying' && (
                <p>
                  The file is written. Gezel is reading it back and checking every file against its
                  SHA-256 checksum.
                  {onSkipVerification
                    ? ' Skipping keeps the file — its checksums are checked on import instead.'
                    : ''}
                </p>
              )}
              {active && (
                <>
                  <progress
                    className="model-export-progress"
                    aria-label={progressLabel}
                    {...(meter ?? {})}
                  />
                  <span className="model-export-progress-copy">
                    {state.phase === 'preparing'
                      ? 'Inspecting model files…'
                      : `${formatBytes(state.bytesCompleted)}${
                          state.bytesTotal === undefined
                            ? ''
                            : ` of ${state.phase === 'writing' ? 'about ' : ''}${formatBytes(
                                state.bytesTotal,
                              )}`
                        } · ${state.phase === 'writing' ? 'writing' : 'verified'}`}
                  </span>
                </>
              )}
              {state.phase === 'complete' && (
                <output className="model-export-complete">
                  <strong>{state.filename}</strong>
                  <span>
                    {state.verified
                      ? `Export complete. Gezel wrote ${formatBytes(
                          state.bytesWritten,
                        )} and verified every bundled file.`
                      : `Export complete. ${formatBytes(
                          state.bytesWritten,
                        )} written without a read-back check; Gezel verifies every file's checksum when the bundle is imported.`}
                  </span>
                </output>
              )}
              {state.phase === 'error' && (
                <p className="error" role="alert">
                  {state.message}
                </p>
              )}
            </div>
          </Dialog.Description>
          {active ? (
            <Dialog.Actions>
              <button type="button" disabled={canceling} onClick={() => void onCancel()}>
                {canceling ? 'Canceling…' : 'Cancel'}
              </button>
              {state.phase === 'verifying' && onSkipVerification && (
                <button
                  type="button"
                  disabled={canceling || skippingVerification}
                  onClick={() => void onSkipVerification()}
                >
                  {skippingVerification ? 'Finishing…' : 'Skip verification'}
                </button>
              )}
            </Dialog.Actions>
          ) : (
            <Dialog.Actions>
              <Dialog.Close asChild>
                <button type="button" onClick={onDismiss}>
                  Close
                </button>
              </Dialog.Close>
            </Dialog.Actions>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
  const activeScanRef = useRef<ActiveBundleScanOperation | null>(null);
  const pendingOpenedScansRef = useRef<OpenedBundleRequest[]>([]);
  const [scan, setScan] = useState<ActiveBundleScan | null>(null);
  const [canceling, setCanceling] = useState(false);
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

  const startScan = useCallback(
    (filename: string, source: ActiveBundleScan['source'], totalBytes?: number) => {
      const scanId = globalThis.crypto.randomUUID();
      const operation: ActiveBundleScanOperation = {
        scanId,
        source,
        ...(source === 'browser' ? { controller: new AbortController() } : {}),
        canceled: false,
      };
      activeScanRef.current = operation;
      setCanceling(false);
      setError(null);
      setScan({
        scanId,
        filename,
        source,
        progress: {
          phase: 'receiving',
          bytesCompleted: 0,
          ...(totalBytes === undefined ? {} : { bytesTotal: totalBytes }),
        },
      });
      return operation;
    },
    [],
  );

  const updateScanProgress = useCallback((scanId: string, progress: GezmodelImportProgress) => {
    setScan((current) => (current?.scanId === scanId ? { ...current, progress } : current));
  }, []);

  const finishScan = useCallback((operation: ActiveBundleScanOperation) => {
    if (activeScanRef.current !== operation) return;
    activeScanRef.current = null;
    setScan(null);
    setCanceling(false);
  }, []);

  const scanFile = useCallback(
    async (file: File) => {
      if (activeScanRef.current) return;
      const operation = startScan(file.name, 'browser', file.size);
      try {
        const next = await api.scanModelBundle(file, {
          scanId: operation.scanId,
          totalBytes: file.size,
          signal: operation.controller?.signal,
          onProgress: (progress) => updateScanProgress(operation.scanId, progress),
        });
        if (!operation.canceled) acceptReview(next);
      } catch (err) {
        if (!operation.canceled && !isAbortError(err)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        finishScan(operation);
        if (inputRef.current) inputRef.current.value = '';
      }
    },
    [acceptReview, finishScan, startScan, updateScanProgress],
  );

  const scanOpened = useCallback(
    async (request: OpenedBundleRequest) => {
      const native = window.__GEZEL__?.scanOpenedModelBundle;
      if (!native) return;
      if (activeScanRef.current) {
        pendingOpenedScansRef.current.push(request);
        return;
      }
      const operation = startScan(request.filename, 'native');
      try {
        const result = await native(request.requestId, operation.scanId);
        if (!result.ok) throw new Error(result.error);
        if ('review' in result && !operation.canceled) acceptReview(result.review);
      } catch (err) {
        if (!operation.canceled && !isAbortError(err)) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        finishScan(operation);
      }
    },
    [acceptReview, finishScan, startScan],
  );

  useEffect(() => {
    const openPicker = () => inputRef.current?.click();
    window.addEventListener('gezel:import-model-bundle', openPicker);
    window.__GEZEL__?.onOpenModelBundle?.((request) => void scanOpened(request));
    return () => window.removeEventListener('gezel:import-model-bundle', openPicker);
  }, [scanOpened]);

  useEffect(() => {
    return window.__GEZEL__?.onModelBundleImportProgress?.((progress) => {
      updateScanProgress(progress.scanId, progress);
    });
  }, [updateScanProgress]);

  useEffect(() => {
    if (scan || activeScanRef.current) return;
    const next = pendingOpenedScansRef.current.shift();
    if (next) void scanOpened(next);
  }, [scan, scanOpened]);

  useEffect(() => {
    return () => {
      const operation = activeScanRef.current;
      if (!operation) return;
      operation.canceled = true;
      if (operation.source === 'native') {
        void window.__GEZEL__?.cancelModelBundleImport?.(operation.scanId);
      } else {
        void api.cancelModelBundleImport(operation.scanId).catch(() => {});
      }
      operation.controller?.abort();
    };
  }, []);

  const cancelScan = useCallback(async () => {
    const operation = activeScanRef.current;
    if (!operation || canceling) return;
    operation.canceled = true;
    setCanceling(true);
    let cleanupError: string | null = null;
    try {
      if (operation.source === 'native') {
        const cancel = window.__GEZEL__?.cancelModelBundleImport;
        if (!cancel) throw new Error('This version of Gezel cannot cancel model imports.');
        const result = await cancel(operation.scanId);
        if (!result.ok) throw new Error(result.error);
      } else {
        await api.cancelModelBundleImport(operation.scanId);
      }
    } catch (err) {
      cleanupError = err instanceof Error ? err.message : String(err);
    } finally {
      operation.controller?.abort();
      finishScan(operation);
      if (cleanupError) {
        setError(`The import was stopped, but cleanup could not be confirmed: ${cleanupError}`);
      }
    }
  }, [canceling, finishScan]);

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

      <Dialog.Root open={Boolean(scan || (error && !review))}>
        <Dialog.Portal>
          <Dialog.Overlay />
          <Dialog.Content
            className="model-import-dialog"
            onEscapeKeyDown={(event) => {
              if (scan) event.preventDefault();
            }}
            onPointerDownOutside={(event) => {
              if (scan) event.preventDefault();
            }}
          >
            <Dialog.Title asChild>
              <h3>{scan ? 'Checking model bundle' : 'Model bundle could not be imported'}</h3>
            </Dialog.Title>
            <Dialog.Description asChild>
              {scan ? (
                <div className="model-export-dialog-body">
                  <p className="muted small">{importProgressDescription(scan)}</p>
                  <progress
                    className="model-export-progress"
                    aria-label="Model bundle scan progress"
                    {...importProgressMeter(scan.progress)}
                  />
                  <span className="model-export-progress-copy" aria-live="polite">
                    {importProgressCopy(scan.progress)}
                  </span>
                </div>
              ) : (
                <p className="error small">{error}</p>
              )}
            </Dialog.Description>
            {scan ? (
              <Dialog.Actions>
                <button type="button" disabled={canceling} onClick={() => void cancelScan()}>
                  {canceling ? 'Canceling…' : 'Cancel'}
                </button>
              </Dialog.Actions>
            ) : (
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

function importProgressDescription(scan: ActiveBundleScan): string {
  switch (scan.progress.phase) {
    case 'receiving':
      return `Copying ${scan.filename} into private staging before opening it.`;
    case 'inspecting':
      return `Inspecting ${scan.filename} for unsafe paths, executable content, and malformed entries.`;
    case 'verifying':
      return `Reading every file in ${scan.filename} and checking its SHA-256 checksum.`;
    case 'validating':
      return `Checking the model metadata and file formats in ${scan.filename}.`;
  }
}

function importProgressMeter(
  progress: GezmodelImportProgress,
): { max: number; value: number } | Record<string, never> {
  if (progress.phase === 'verifying' && progress.bytesTotal > 0) {
    return {
      max: progress.bytesTotal,
      value: Math.min(progress.bytesCompleted, progress.bytesTotal),
    };
  }
  if (
    progress.phase === 'receiving' &&
    progress.bytesTotal !== undefined &&
    progress.bytesTotal > 0
  ) {
    return {
      max: progress.bytesTotal,
      value: Math.min(progress.bytesCompleted, progress.bytesTotal),
    };
  }
  return {};
}

function importProgressCopy(progress: GezmodelImportProgress): string {
  switch (progress.phase) {
    case 'receiving':
      return progress.bytesTotal === undefined
        ? `${formatBytes(progress.bytesCompleted)} copied`
        : `${formatBytes(progress.bytesCompleted)} of ${formatBytes(progress.bytesTotal)} copied`;
    case 'inspecting':
      return 'Inspecting archive structure…';
    case 'verifying':
      return `${formatBytes(progress.bytesCompleted)} of ${formatBytes(
        progress.bytesTotal,
      )} verified`;
    case 'validating':
      return 'Validating model metadata and file formats…';
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && error.name === 'AbortError',
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

async function saveInBrowser(
  response: Response,
  suggestedName: string,
  onProgress: (bytesCompleted: number, bytesTotal?: number) => void,
  signal?: AbortSignal,
): Promise<{ bytesWritten: number }> {
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
    const writable = await handle.createWritable();
    const reader = response.body.getReader();
    const writer = writable.getWriter();
    const bytesTotal = responseModelBytes(response);
    let bytesWritten = 0;
    onProgress(bytesWritten, bytesTotal);
    try {
      while (true) {
        signal?.throwIfAborted();
        const next = await reader.read();
        if (next.done) break;
        bytesWritten += next.value.byteLength;
        await writer.write(next.value);
        onProgress(bytesWritten, bytesTotal);
      }
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
      throw error;
    }
    return { bytesWritten };
  }

  // Compatibility fallback for browsers without the File System Access API.
  // The Electron shell and Chromium desktop path above both stream to disk.
  signal?.throwIfAborted();
  const blob = await response.blob();
  signal?.throwIfAborted();
  onProgress(blob.size, responseModelBytes(response));
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can race the browser's download handoff and leave
  // a zero-byte file. Give the compatibility download time to retain the URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return { bytesWritten: blob.size };
}

function responseModelBytes(response: Response): number | undefined {
  const raw = response.headers.get('x-gezel-model-bytes');
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  const bytes = Number(raw);
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
}

function portableFilename(id: string): string {
  return id.replace(/[^a-z0-9._-]+/gi, '-').replace(/^[.-]+/, '') || 'model';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}
