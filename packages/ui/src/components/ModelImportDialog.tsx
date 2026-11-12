import {
  type ModelImportCheck,
  type ModelImportEngine,
  type ModelImportReview,
  type ModelImportReviewRequest,
  composeFitnessBadge,
} from '@bendyline/gezel';
import type { ModelFitnessEntry } from '@bendyline/gezel-client';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { announceModelInventoryChanged } from '../model-inventory.js';
import { Dialog, Select } from '../primitives/index.js';
import { HuggingFaceRepoLink } from './HuggingFaceRepoLink.js';
import { InstallProgressRow } from './InstallProgressRow.js';
import { formatContextWindow } from './model-context.js';
import { formatBytes } from './model-memory-copy.js';

/**
 * Adding a model the catalog does not carry: from a Hugging Face link (a GGUF
 * repo, or an MLX build on Apple silicon), or from GGUF files on this
 * computer. Opened from Settings → Models, or by Hugging Face's "Use this
 * model" menu through `gezel://model/huggingface/<owner>/<name>`. Nothing
 * downloads or is added until the person confirms, and the review refuses a
 * model that fails a check. Afterwards the fitness check tries the model for
 * real. Contract in docs/model-imports.md.
 */
export interface ModelImportDialogProps {
  open: boolean;
  /** From a `gezel://` link: the review starts as the dialog opens. */
  initial?: { repo: string; file?: string };
  onClose: () => void;
  /** A model finished downloading or was added; Settings refreshes its list. */
  onInstalled?: (id: string, engine: ModelImportEngine) => void;
}

type Phase =
  | { kind: 'enter'; error?: string }
  | { kind: 'reviewing'; label: string }
  | { kind: 'uploading'; importId: string; name: string; bytesSent: number; totalBytes: number }
  | { kind: 'review'; review: ModelImportReview; busy?: boolean; error?: string }
  | {
      kind: 'downloading';
      engine: ModelImportEngine;
      id: string;
      name: string;
      bytesWritten: number;
      totalBytes: number;
      status: string;
      error?: string;
    }
  | {
      kind: 'checking';
      engine: ModelImportEngine;
      id: string;
      name: string;
      entry?: ModelFitnessEntry;
      probing: boolean;
    };

const FITNESS_POLL_MS = 3_000;
const UPLOAD_POLL_MS = 1_000;

const STATUS_WORD: Record<ModelImportCheck['status'], string> = {
  pass: 'Passed',
  warn: 'Note',
  fail: 'Problem',
};

/** Radix Select refuses an empty value; an MLX build at the repo root has key ''. */
const ROOT_CHOICE = '.';
const toSelectValue = (key: string) => key || ROOT_CHOICE;
const fromSelectValue = (value: string) => (value === ROOT_CHOICE ? '' : value);

function describeProgress(bytesWritten: number, totalBytes: number): string {
  if (totalBytes > 0) {
    const pct = Math.min(100, Math.round((bytesWritten / totalBytes) * 100));
    return `Downloading ${formatBytes(bytesWritten)} of ${formatBytes(totalBytes)} (${pct}%)`;
  }
  return bytesWritten > 0 ? `Downloading ${formatBytes(bytesWritten)}…` : 'Preparing download…';
}

function settingsLine(review: ModelImportReview): string {
  const { tuning } = review;
  if (tuning.from === 'catalog') {
    return `Settings: borrowed from ${tuning.catalogName ?? 'a model'} in Gezel's catalog, built from the same base model and tested.`;
  }
  if (tuning.from === 'author') return "Settings: the ones the model's author recommends.";
  return "Settings: Gezel's general settings for a model of this size.";
}

export function ModelImportDialog({ open, initial, onClose, onInstalled }: ModelImportDialogProps) {
  const [phase, setPhase] = useState<Phase>({ kind: 'enter' });
  const [reference, setReference] = useState('');
  const installAbort = useRef<AbortController | null>(null);
  const uploadAbort = useRef<AbortController | null>(null);
  /** A local import still staged on the daemon; cancelled unless confirmed. */
  const pendingLocal = useRef<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const closed = useRef(false);

  const runReview = useCallback(async (request: ModelImportReviewRequest, label: string) => {
    setPhase({ kind: 'reviewing', label });
    try {
      const review = await api.reviewModelImport(request);
      if (!closed.current) setPhase({ kind: 'review', review });
    } catch (err) {
      if (!closed.current) setPhase({ kind: 'enter', error: apiErrorMessage(err) });
    }
  }, []);

  const dropLocal = useCallback(() => {
    uploadAbort.current?.abort();
    uploadAbort.current = null;
    const importId = pendingLocal.current;
    pendingLocal.current = null;
    if (importId) void api.cancelLocalModelImport(importId).catch(() => {});
  }, []);

  const initialRepo = initial?.repo;
  const initialFile = initial?.file;
  useEffect(() => {
    if (!open) return;
    closed.current = false;
    setReference(initialRepo ?? '');
    if (initialRepo) {
      void runReview(
        { repo: initialRepo, ...(initialFile ? { file: initialFile } : {}) },
        `Checking ${initialRepo} on Hugging Face…`,
      );
    } else {
      setPhase({ kind: 'enter' });
    }
    return () => {
      closed.current = true;
      installAbort.current?.abort();
      installAbort.current = null;
      dropLocal();
    };
  }, [open, initialRepo, initialFile, runReview, dropLocal]);

  // While the post-install fitness check runs, poll for its record.
  const checkingKey =
    phase.kind === 'checking' && phase.probing ? `${phase.engine}:${phase.id}` : null;
  useEffect(() => {
    if (!checkingKey) return;
    let stopped = false;
    const poll = async () => {
      try {
        const { records, probing } = await api.listModelFitness();
        if (stopped) return;
        const entry = records.find((record) => record.key === checkingKey);
        const stillProbing = probing.includes(checkingKey) || !entry;
        setPhase((prev) =>
          prev.kind === 'checking' && `${prev.engine}:${prev.id}` === checkingKey
            ? { ...prev, ...(entry ? { entry } : {}), probing: stillProbing }
            : prev,
        );
      } catch {
        // A missed poll is retried on the next tick.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), FITNESS_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [checkingKey]);

  // While a file is sent, the daemon says how much has arrived.
  const uploadingId = phase.kind === 'uploading' ? phase.importId : null;
  useEffect(() => {
    if (!uploadingId) return;
    const timer = window.setInterval(() => {
      void api
        .getLocalModelImport(uploadingId)
        .then((status) =>
          setPhase((prev) =>
            prev.kind === 'uploading' && prev.importId === uploadingId
              ? { ...prev, bytesSent: status.bytesReceived }
              : prev,
          ),
        )
        .catch(() => {});
    }, UPLOAD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [uploadingId]);

  const close = () => {
    // Closing during a download leaves it running; Settings shows its progress.
    installAbort.current?.abort();
    installAbort.current = null;
    dropLocal();
    onClose();
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = reference.trim();
    if (!text) return;
    void runReview({ reference: text }, 'Checking the model on Hugging Face…');
  };

  const sendFiles = async (files: File[]) => {
    if (files.length === 0) return;
    if (files.some((file) => !file.name.toLowerCase().endsWith('.gguf'))) {
      setPhase({
        kind: 'enter',
        error: 'Choose .gguf files. Gezel adds GGUF models from this computer.',
      });
      return;
    }
    dropLocal();
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    try {
      const { importId } = await api.startLocalModelImport();
      pendingLocal.current = importId;
      const controller = new AbortController();
      uploadAbort.current = controller;
      for (const file of files) {
        if (closed.current) return;
        setPhase((prev) => ({
          kind: 'uploading',
          importId,
          name: file.name,
          bytesSent: prev.kind === 'uploading' ? prev.bytesSent : 0,
          totalBytes,
        }));
        await api.uploadLocalModelFile(importId, file, file.name, controller.signal);
      }
      uploadAbort.current = null;
      if (closed.current) return;
      setPhase({ kind: 'reviewing', label: 'Checking the files…' });
      const review = await api.reviewLocalModelImport(importId);
      if (!closed.current) setPhase({ kind: 'review', review });
    } catch (err) {
      if (closed.current) return;
      dropLocal();
      setPhase({ kind: 'enter', error: apiErrorMessage(err) });
    }
  };

  const finished = (engine: ModelImportEngine, id: string, name: string) => {
    announceModelInventoryChanged(engine);
    onInstalled?.(id, engine);
    setPhase({ kind: 'checking', engine, id, name, probing: true });
  };

  const install = async (engine: ModelImportEngine, id: string, name: string) => {
    const controller = new AbortController();
    installAbort.current = controller;
    setPhase({
      kind: 'downloading',
      engine,
      id,
      name,
      bytesWritten: 0,
      totalBytes: 0,
      status: 'Preparing download…',
    });
    let failed: string | undefined;
    let done = false;
    const progress = (bytesWritten: number, totalBytes: number) =>
      setPhase((prev) =>
        prev.kind === 'downloading'
          ? {
              ...prev,
              bytesWritten,
              totalBytes,
              status: describeProgress(bytesWritten, totalBytes),
            }
          : prev,
      );
    const status = (text: string) =>
      setPhase((prev) => (prev.kind === 'downloading' ? { ...prev, status: text } : prev));
    try {
      if (engine === 'mlx') {
        await api.installMlxModel(
          id,
          (event) => {
            if (closed.current) return;
            if (event.type === 'progress') progress(event.bytesWrittenAll, event.totalBytesAll);
            else if (event.type === 'verifying') status('Checking the download…');
            else if (event.type === 'extracting-metadata') status('Reading the model…');
            else if (event.type === 'retrying') status(`${event.reason} Retrying…`);
            else if (event.type === 'error') failed = event.error;
            else if (event.type === 'done') done = true;
          },
          controller.signal,
        );
      } else {
        await api.installLlamaCppModel(
          id,
          (event) => {
            if (closed.current) return;
            if (event.type === 'progress') progress(event.bytesWritten, event.totalBytes);
            else if (event.type === 'verifying') status('Checking the download…');
            else if (event.type === 'extracting-metadata') status('Reading the model…');
            else if (event.type === 'retrying') status(`${event.reason} Retrying…`);
            else if (event.type === 'error') failed = event.error;
            else if (event.type === 'done') done = true;
          },
          controller.signal,
        );
      }
    } catch (err) {
      if (!controller.signal.aborted) failed = apiErrorMessage(err);
    }
    if (closed.current || controller.signal.aborted) return;
    installAbort.current = null;
    if (failed || !done) {
      setPhase((prev) =>
        prev.kind === 'downloading'
          ? { ...prev, error: failed ?? 'The download stopped before it finished.' }
          : prev,
      );
      return;
    }
    finished(engine, id, name);
  };

  const confirm = async (review: ModelImportReview) => {
    setPhase({ kind: 'review', review, busy: true });
    try {
      if (review.source.kind === 'local-file') {
        const result = await api.confirmLocalModelImport(review.source.importId);
        pendingLocal.current = null;
        if (!closed.current) finished(result.engine, result.id, result.name);
        return;
      }
      const result = await api.confirmModelImport({
        repo: review.source.repo,
        revision: review.source.revision,
        file: review.selectedFile,
      });
      await install(result.engine, result.id, result.name);
    } catch (err) {
      if (!closed.current) setPhase({ kind: 'review', review, error: apiErrorMessage(err) });
    }
  };

  const cancelDownload = async (engine: ModelImportEngine, id: string) => {
    installAbort.current?.abort();
    installAbort.current = null;
    if (engine === 'mlx') await api.cancelMlxModelInstall(id).catch(() => {});
    else await api.cancelLlamaCppModelInstall(id).catch(() => {});
    onClose();
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : close())}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="model-import-dialog" data-testid="model-import-dialog">
          <Dialog.Title asChild>
            <h3>Add a model</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Gezel tries every catalog model before it ships. A model you add yourself has not been
            tried, so Gezel checks it before adding it and tries it once it is here.
          </Dialog.Description>
          <div className="model-import-dialog-body">
            {phase.kind === 'enter' && (
              <form className="model-import-enter" onSubmit={submit}>
                <label className="small" htmlFor="model-import-reference">
                  Link to a model on Hugging Face (GGUF, or MLX on Apple silicon Macs)
                </label>
                <input
                  id="model-import-reference"
                  type="text"
                  value={reference}
                  placeholder="https://huggingface.co/owner/model-GGUF"
                  onChange={(event) => setReference(event.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                <p className="muted small model-import-or">
                  Or add a .gguf file that is already on this computer.{' '}
                  <button
                    type="button"
                    className="gz-link-button"
                    onClick={() => fileInput.current?.click()}
                  >
                    Choose files…
                  </button>
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".gguf"
                  multiple
                  hidden
                  data-testid="model-import-files"
                  onChange={(event) => {
                    const files = Array.from(event.target.files ?? []);
                    event.target.value = '';
                    void sendFiles(files);
                  }}
                />
                {phase.error && (
                  <p className="error small" role="alert">
                    {phase.error}
                  </p>
                )}
              </form>
            )}
            {phase.kind === 'reviewing' && (
              <p className="muted small" aria-live="polite">
                {phase.label}
              </p>
            )}
            {phase.kind === 'uploading' && (
              <InstallProgressRow
                title={<strong>{phase.name}</strong>}
                status={`Copying in ${formatBytes(phase.bytesSent)} of ${formatBytes(phase.totalBytes)}`}
                percent={phase.totalBytes > 0 ? (phase.bytesSent / phase.totalBytes) * 100 : null}
                onCancel={close}
              />
            )}
            {phase.kind === 'review' && (
              <ReviewBody
                review={phase.review}
                disabled={Boolean(phase.busy)}
                onChoose={(file) => {
                  const source = phase.review.source;
                  if (source.kind !== 'huggingface') return;
                  void runReview(
                    { repo: source.repo, revision: source.revision, file },
                    'Checking that file…',
                  );
                }}
              />
            )}
            {phase.kind === 'review' && phase.error && (
              <p className="error small" role="alert">
                {phase.error}
              </p>
            )}
            {phase.kind === 'downloading' && (
              <InstallProgressRow
                title={<strong>{phase.name}</strong>}
                status={phase.error ?? phase.status}
                percent={
                  phase.totalBytes > 0 && !phase.error
                    ? (phase.bytesWritten / phase.totalBytes) * 100
                    : null
                }
                tone={phase.error ? 'error' : 'normal'}
                onCancel={() => void cancelDownload(phase.engine, phase.id)}
                onRetry={() => void install(phase.engine, phase.id, phase.name)}
              />
            )}
            {phase.kind === 'checking' && <CheckingBody phase={phase} />}
          </div>
          <Dialog.Actions>
            <ActionKeys
              phase={phase}
              reference={reference}
              onClose={close}
              onReview={() => submit()}
              onConfirm={(review) => void confirm(review)}
              onCatalog={(id, name) => void install('llama-cpp', id, name)}
            />
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ActionKeys({
  phase,
  reference,
  onClose,
  onReview,
  onConfirm,
  onCatalog,
}: {
  phase: Phase;
  reference: string;
  onClose: () => void;
  onReview: () => void;
  onConfirm: (review: ModelImportReview) => void;
  onCatalog: (id: string, name: string) => void;
}) {
  if (phase.kind === 'enter' || phase.kind === 'reviewing') {
    return (
      <>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={phase.kind === 'reviewing' || !reference.trim()}
          onClick={onReview}
        >
          Check model
        </button>
      </>
    );
  }
  if (phase.kind === 'review') {
    const { review } = phase;
    const local = review.source.kind === 'local-file';
    const primary = local
      ? `Add ${formatBytes(review.downloadBytes)}`
      : `Download ${formatBytes(review.downloadBytes)}`;
    if (review.alreadyInstalled && !local) {
      return (
        <button type="button" onClick={onClose}>
          Done
        </button>
      );
    }
    const match = review.catalogMatch;
    if (match && !local && review.engine === 'llama-cpp') {
      return (
        <>
          <button type="button" className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="secondary"
            disabled={phase.busy || review.blocked}
            onClick={() => onConfirm(review)}
          >
            Download this upload
          </button>
          <button
            type="button"
            disabled={phase.busy}
            onClick={() => onCatalog(match.id, match.name)}
          >
            Download {match.name}
          </button>
        </>
      );
    }
    return (
      <>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          disabled={phase.busy || review.blocked}
          onClick={() => onConfirm(review)}
          {...(review.blocked ? { title: 'This model did not pass its checks.' } : {})}
        >
          {phase.busy ? 'Starting…' : primary}
        </button>
      </>
    );
  }
  const done = phase.kind === 'checking' && !phase.probing;
  return (
    <button type="button" className={done ? undefined : 'secondary'} onClick={onClose}>
      {done ? 'Done' : 'Close'}
    </button>
  );
}

function ReviewBody({
  review,
  disabled,
  onChoose,
}: {
  review: ModelImportReview;
  disabled: boolean;
  onChoose: (file: string) => void;
}) {
  const { details, source } = review;
  const facts = [
    review.engine === 'mlx' ? 'MLX' : undefined,
    details.parameterSize,
    details.quantization,
    details.contextWindow ? `${formatContextWindow(details.contextWindow)} context` : undefined,
    details.mixtureOfExperts ? 'mixture of experts' : undefined,
    details.vision ? 'sees images' : undefined,
  ].filter((fact): fact is string => Boolean(fact));
  const choice = review.choices.find((item) => item.key === review.selectedFile);
  return (
    <div className="model-import-review">
      <div className="model-import-identity">
        <strong className="model-import-name">{review.name}</strong>
        <div className="muted small model-import-byline">
          {source.kind === 'huggingface' ? (
            <HuggingFaceRepoLink repo={source.repo} />
          ) : (
            <span>
              {source.files.length === 1
                ? `${source.files[0]?.name} from this computer`
                : `${source.files.length} files from this computer`}
            </span>
          )}
          {review.author && <span>by {review.author}</span>}
          {review.license && <span>license: {review.license}</span>}
        </div>
        {facts.length > 0 && <div className="muted small">{facts.join(' · ')}</div>}
        <div className="muted small">{settingsLine(review)}</div>
      </div>

      {review.alreadyInstalled && (
        <p className="small model-import-notice">
          {source.kind === 'local-file'
            ? 'This model is already on this computer. Adding it again replaces that copy.'
            : 'This model is already on this computer.'}
        </p>
      )}
      {review.catalogMatch && source.kind === 'huggingface' && (
        <p className="small model-import-notice">
          Gezel's catalog already has this exact file as <strong>{review.catalogMatch.name}</strong>
          , tuned and tested for Gezel. Download that one unless you need this upload.
        </p>
      )}
      {review.catalogMatch && source.kind === 'local-file' && (
        <p className="small model-import-notice">
          This is the exact file Gezel's catalog offers as{' '}
          <strong>{review.catalogMatch.name}</strong>, so it runs with that model's tested settings.
        </p>
      )}

      {review.choices.length > 1 ? (
        <div className="model-import-choice">
          <span className="small">{review.engine === 'mlx' ? 'Build' : 'File'}</span>
          <Select.Root
            value={toSelectValue(review.selectedFile)}
            onValueChange={(value) => onChoose(fromSelectValue(value))}
            disabled={disabled}
          >
            <Select.Trigger className="model-import-choice-trigger" aria-label="File to download">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {review.choices.map((item) => (
                <Select.Item
                  key={item.key || ROOT_CHOICE}
                  value={toSelectValue(item.key)}
                  textValue={item.quant ?? item.key}
                >
                  {item.quant ?? item.key.split('/').pop()} · {formatBytes(item.sizeBytes)}
                  {item.fit && item.fit.tier !== 'fits' ? ` · ${item.fit.label}` : ''}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        </div>
      ) : (
        choice && (
          <div className="muted small">
            <code>{choice.key || 'whole repository'}</code> · {formatBytes(choice.sizeBytes)}
          </div>
        )
      )}

      <ul className="model-import-checks" aria-label="Checks before adding">
        {review.checks.map((item) => (
          <li key={item.id} className="model-import-check" data-status={item.status}>
            <span className="model-import-check-status small">
              <span className="model-import-dot" aria-hidden />
              {STATUS_WORD[item.status]}
            </span>
            <span className="model-import-check-text small">
              <strong>{item.title}.</strong> {item.detail}
            </span>
          </li>
        ))}
      </ul>
      {review.blocked && (
        <output className="small model-import-blocked">
          Gezel won't add this model while a check above says Problem.
        </output>
      )}
    </div>
  );
}

function CheckingBody({ phase }: { phase: Extract<Phase, { kind: 'checking' }> }) {
  if (phase.probing) {
    return (
      <div className="model-import-review" aria-live="polite">
        <p className="small">
          <strong>{phase.name}</strong> is here. Gezel is now trying it: starting it, asking for a
          short reply, and asking it to use a tool.
        </p>
        <p className="muted small">
          This can take a few minutes. You can close this window; the result appears beside the
          model in Settings → Models.
        </p>
      </div>
    );
  }
  const badge = composeFitnessBadge({
    ...(phase.entry
      ? {
          fitness: {
            record: phase.entry.record,
            stale: phase.entry.stale,
            hardwareChanged: phase.entry.hardwareChanged,
          },
        }
      : {}),
  });
  const passed = phase.entry?.record.admitted === true;
  return (
    <div className="model-import-review" aria-live="polite">
      <p className="small">
        <span
          className={`gz-status-pill${badge.tier === 'ok' ? ' gz-status-pill--ok' : badge.tier === 'warn' ? ' gz-status-pill--warn' : ''}`}
        >
          {badge.label}
        </span>{' '}
        <strong>{phase.name}</strong>
      </p>
      <p className="small">{badge.reason ?? badge.detail}</p>
      <p className="muted small">
        {passed
          ? 'It is ready. Choose it in the model picker, or give it to a crew member in their settings.'
          : 'Gezel will not pick this model for work on its own, but you can still choose it yourself. You can remove it in Settings → Models.'}
      </p>
    </div>
  );
}
