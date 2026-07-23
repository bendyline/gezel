import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../primitives/index.js';

/**
 * Simple single-input modal dialog. Electron's `window.prompt()` silently
 * returns null (not implemented in Chromium-based renderers), so we render
 * our own. Radix handles backdrop click + Escape; Enter submits the form.
 */
export function PromptDialog({
  open,
  title,
  message,
  placeholder,
  defaultValue = '',
  submitLabel = 'OK',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
  required = false,
}: {
  open: boolean;
  title: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  submitLabel?: string;
  cancelLabel?: string;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
  required?: boolean;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setBusy(false);
    }
  }, [open, defaultValue]);

  const submit = async () => {
    if (busy) return;
    if (required && !value.trim()) return;
    setBusy(true);
    try {
      await onSubmit(value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            queueMicrotask(() => inputRef.current?.focus());
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
            style={{ display: 'contents' }}
          >
            <Dialog.Title asChild>
              <h3>{title}</h3>
            </Dialog.Title>
            {message && <Dialog.Description className="muted small">{message}</Dialog.Description>}
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              disabled={busy}
            />
            <Dialog.Actions>
              <button type="button" onClick={onCancel} disabled={busy}>
                {cancelLabel}
              </button>
              <button
                type="submit"
                className="primary"
                disabled={busy || (required && !value.trim())}
              >
                {busy ? 'Working…' : submitLabel}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
