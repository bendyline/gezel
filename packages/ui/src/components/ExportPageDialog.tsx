import { useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { downloadBlob } from './DocumentExport/download-blob.js';

type ExportFormat = 'single' | 'folder';

const CHOICES: Array<{ format: ExportFormat; label: string; hint: string }> = [
  {
    format: 'single',
    label: 'One file (.html)',
    hint: 'Opens by double-clicking and can be emailed. Libraries, styles and images are inside it.',
  },
  {
    format: 'folder',
    label: 'Folder (.zip)',
    hint: 'The page’s files with its libraries beside them, ready to put on a website.',
  },
];

/**
 * Export a workspace page with the libraries it uses (docs/page-libraries.md),
 * as one file or as a zipped folder. Says what the copy leaves out.
 */
export function ExportPageDialog({
  open,
  projectId,
  path,
  onClose,
}: {
  open: boolean;
  projectId: string;
  path: string;
  onClose: () => void;
}) {
  const [format, setFormat] = useState<ExportFormat>('single');
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[] | null>(null);

  const close = () => {
    setError(null);
    setNotes(null);
    onClose();
  };

  const run = async () => {
    setError(null);
    try {
      const exported = await api.exportProjectPage(projectId, path, format);
      downloadBlob(exported.blob, exported.filename);
      if (exported.notes.length) setNotes(exported.notes);
      else close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <ConfirmDialog
      open={open}
      title="Export this page"
      message={`A copy of ${path} that works anywhere, with the libraries it uses.`}
      confirmLabel={notes ? 'Export again' : 'Export'}
      cancelLabel={notes ? 'Done' : 'Cancel'}
      onConfirm={run}
      onCancel={close}
    >
      <fieldset className="gz-setting-options gz-setting-options-list">
        <legend className="gz-setting-label">Export as</legend>
        {CHOICES.map((choice) => (
          <label key={choice.format} className="gz-setting-option">
            <input
              type="radio"
              name="export-format"
              checked={format === choice.format}
              onChange={() => setFormat(choice.format)}
            />
            <span>
              {choice.label}
              <span className="gz-setting-hint" style={{ display: 'block' }}>
                {choice.hint}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {notes ? (
        <div>
          <output className="gz-setting-label" style={{ display: 'block' }}>
            Saved. The copy leaves out:
          </output>
          <ul className="gz-setting-hint">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
