import { type FormEvent, useEffect, useState } from 'react';
import { Dialog } from '../primitives/index.js';

function stripSuffix(value: string, suffix?: string): string {
  if (!suffix || !value.toLowerCase().endsWith(suffix.toLowerCase())) return value;
  return value.slice(0, -suffix.length);
}

/**
 * A minimal "enter a path, then Create" modal. Shared by the Documents
 * view toolbar and the sidebar's Documents "+" affordance so both surfaces
 * pop the same simple dialog rather than diverging.
 */
export function NewPathDialog({
  open,
  title,
  placeholder,
  submitLabel,
  onSubmit,
  onCancel,
  initialValue = '',
  suffix,
  fieldLabel = 'Path',
  error,
}: {
  open: boolean;
  title: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (path: string) => void;
  onCancel: () => void;
  /** Seed the input when the dialog opens — e.g. a `folder/` prefix so a
   *  new file lands inside the selected folder. Default empty. */
  initialValue?: string;
  /** Fixed filename suffix shown beside the input and appended on submit. */
  suffix?: string;
  /** Visible field label. Defaults to Path; rename flows use Name. */
  fieldLabel?: string;
  /** Optional inline error while keeping the dialog open for correction. */
  error?: string | null;
}) {
  const [value, setValue] = useState(() => stripSuffix(initialValue, suffix));
  useEffect(() => {
    if (open) setValue(stripSuffix(initialValue, suffix));
  }, [open, initialValue, suffix]);
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    onSubmit(`${stripSuffix(value.trim(), suffix)}${suffix ?? ''}`);
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content>
          <form onSubmit={handleSubmit} style={{ display: 'contents' }}>
            <Dialog.Title asChild>
              <h3>{title}</h3>
            </Dialog.Title>
            <label>
              {fieldLabel}
              <span className={suffix ? 'new-path-input-row' : undefined}>
                <input
                  value={value}
                  onChange={(e) => setValue(stripSuffix(e.target.value, suffix))}
                  placeholder={placeholder}
                />
                {suffix && (
                  <span className="new-path-input-suffix" aria-hidden="true">
                    {suffix}
                  </span>
                )}
              </span>
            </label>
            {error && (
              <p className="gz-dialog-error" role="alert">
                {error}
              </p>
            )}
            <Dialog.Actions>
              <button type="button" onClick={onCancel}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!value.trim()}>
                {submitLabel}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
