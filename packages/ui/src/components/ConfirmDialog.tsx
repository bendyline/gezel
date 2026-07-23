import { useState } from 'react';
import { AlertDialog } from '../primitives/index.js';

/**
 * Modal yes/no dialog. Backdrop click + Escape both cancel (Radix defaults),
 * Enter confirms via autoFocus on the action button. Use `danger` to mark
 * destructive actions — the primary button goes red.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content>
          <AlertDialog.Title asChild>
            <h3>{title}</h3>
          </AlertDialog.Title>
          {message && (
            <AlertDialog.Description className="muted small">{message}</AlertDialog.Description>
          )}
          <AlertDialog.Actions>
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy}>
                {cancelLabel}
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className={danger ? 'danger' : 'primary'}
                onClick={(e) => {
                  e.preventDefault();
                  void run();
                }}
                disabled={busy}
              >
                {busy ? 'Working…' : confirmLabel}
              </button>
            </AlertDialog.Action>
          </AlertDialog.Actions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
