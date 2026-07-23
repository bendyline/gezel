import { type FormEvent, useEffect, useState } from 'react';
import { Dialog } from '../primitives/index.js';

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
}) {
  const [value, setValue] = useState(initialValue);
  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    onSubmit(value.trim());
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
              Path
              <input
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
              />
            </label>
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
