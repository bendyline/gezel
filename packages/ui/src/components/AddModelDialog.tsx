import type { CatalogItemSummary, CatalogKind } from '@bendyline/gezel';
import { type ReactNode, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Dialog } from '../primitives/index.js';

/**
 * The models a page can download, behind an "Add a model…" key. The engine
 * and media pages used to list their whole catalog under the installed
 * models, so a page opened to check or tune a model was mostly a shop. The
 * installed models stay on the page; the catalog opens when asked for.
 *
 * Downloads outlive the dialog. Their state belongs to the page's manager,
 * which renders this dialog, so a row keeps its progress while open and the
 * page's "Downloading…" section carries it once the dialog closes.
 */
export function AddModelDialog({
  open,
  onOpenChange,
  title = 'Add a model',
  description,
  children,
  more,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  description: ReactNode;
  children: ReactNode;
  /** Other ways to add a model (one not in the catalog, a model package), beside Done. */
  more?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="add-model-dialog" data-testid="add-model-dialog">
          <Dialog.Title asChild>
            <h3>{title}</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">{description}</Dialog.Description>
          <div className="add-model-dialog-body">{children}</div>
          <Dialog.Actions>
            {more && <div className="add-model-dialog-more">{more}</div>}
            <Dialog.Close asChild>
              <button type="button">Done</button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Title of a catalog row's disabled "Needs attention" key: its files on this
 * device are unreadable, and the page's recovery row (behind this dialog)
 * owns the update-or-remove choice.
 */
export const NEEDS_ATTENTION_TITLE =
  "This model's files on this device need attention. Close this list to update or remove them.";

/** The installed-models heading, with the key that opens {@link AddModelDialog} at its right. */
export function ModelListHeading({ title, onAdd }: { title: string; onAdd: () => void }) {
  return (
    <div className="model-list-heading">
      <h4>{title}</h4>
      <button type="button" onClick={onAdd}>
        Add a model…
      </button>
    </div>
  );
}

/** Where downloads come from, in the words every model page uses. */
export function HuggingFaceHostingNote() {
  return (
    <>
      Models are hosted by{' '}
      <a
        href="https://huggingface.co"
        target="_blank"
        rel="noreferrer"
        style={{ color: 'inherit' }}
      >
        Hugging Face
      </a>
      , a community library of open, freely available AI models. Your device downloads them
      directly.
    </>
  );
}

/**
 * The catalog, loaded with the page rather than with the dialog: installed
 * rows read it too (a model's hardware hint, "From Hugging Face"), and those
 * must not wait for someone to open the catalog. The dialog's browser adopts
 * these items and hands back whatever its Refresh fetches.
 */
export function useCatalogItems(
  kind: CatalogKind,
): [CatalogItemSummary[] | undefined, (items: CatalogItemSummary[]) => void] {
  const [items, setItems] = useState<CatalogItemSummary[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void api
      .listCatalogItems(kind)
      .then((res) => {
        if (!cancelled && Array.isArray(res?.items)) setItems(res.items);
      })
      .catch(() => {
        /* The dialog's browser fetches again and shows the error itself. */
      });
    return () => {
      cancelled = true;
    };
  }, [kind]);
  return [items, setItems];
}

/**
 * What a download that failed to start has to say: a checksum changed
 * upstream, an error, or a warning. Managers show it inside the dialog while
 * it is open, where the Download key was pressed, and on the page otherwise.
 */
export function LocalInstallNotices({
  mismatch,
  error,
  warning,
  onDownloadAnyway,
  onDismissMismatch,
}: {
  mismatch: { catalogId: string; file: string } | null;
  error: string | null;
  warning: { id: string; message: string } | null;
  onDownloadAnyway: (catalogId: string) => void;
  onDismissMismatch: () => void;
}) {
  return (
    <>
      {mismatch && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ <code>{mismatch.catalogId}</code> is newer on Hugging Face than the version Gezel
            knows about
          </div>
          <p style={{ marginBottom: '0.5rem' }}>
            The file <code>{mismatch.file}</code> changed upstream, so its checksum no longer
            matches what this version of Gezel pinned. This is almost always a harmless upstream fix
            — model authors routinely re-publish chat templates and tokenizer configs — but we can't
            verify it automatically. You can download the current version now, or wait for a Gezel
            update with a refreshed catalog.
          </p>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              type="button"
              className="gz-link-button"
              onClick={() => onDownloadAnyway(mismatch.catalogId)}
            >
              Download anyway
            </button>
            <button type="button" className="gz-link-button" onClick={onDismissMismatch}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="ollama-section">
          <p className="error" style={{ marginBottom: '0.5rem' }}>
            {error}
          </p>
        </div>
      )}

      {warning && (
        <div className="ollama-section">
          <div className="gz-status-pill gz-status-pill--warn" style={{ marginBottom: '0.5rem' }}>
            ⚠ {warning.id}: {warning.message}
          </div>
        </div>
      )}
    </>
  );
}
