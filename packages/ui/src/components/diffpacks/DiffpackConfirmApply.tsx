import { ConfirmDialog } from '../ConfirmDialog.js';

/**
 * The drift confirmation.
 *
 * A proposal is written against the files as they were; if one has moved
 * since, applying it may not mean what the gezel meant. That is a judgement
 * the user makes with the file names in front of them, so this names them
 * rather than saying "some files changed". It is marked `danger` because the
 * result is a write to the user's own source under weakened assumptions —
 * even though a patch that genuinely no longer fits is still refused after
 * this, by the patcher.
 */
export function DiffpackConfirmApply({
  paths,
  onConfirm,
  onCancel,
}: {
  paths: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <ConfirmDialog
      open
      danger
      title="These files changed since the proposal was written"
      confirmLabel="Apply anyway"
      message={
        <>
          <p>
            {paths.length === 1
              ? 'This file has been edited since the gezel drafted its change:'
              : 'These files have been edited since the gezel drafted its change:'}
          </p>
          <ul>
            {paths.map((path) => (
              <li key={path}>
                <code>{path}</code>
              </li>
            ))}
          </ul>
          <p>
            The change may no longer do what was intended. Anything that plainly doesn’t fit will
            still be refused.
          </p>
        </>
      }
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}
