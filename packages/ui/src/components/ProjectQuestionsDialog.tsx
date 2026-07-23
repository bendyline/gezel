import { Dialog } from '../primitives/index.js';
import { NeedsInputPanel } from './NeedsInputPanel.js';

/**
 * Modal that resolves a single project's pending questions — opened from the
 * sidebar's per-project "needs input" affordance. Thin wrapper around
 * {@link NeedsInputPanel} scoped by `projectId`: the panel already loads,
 * live-refreshes, and renders the {@link PendingQuestionCard}s, so answering
 * flows through the existing machinery. Closes when the user dismisses it or
 * when the project's last question is answered (`onEmpty`).
 */
export function ProjectQuestionsDialog({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className="project-questions-dialog"
          aria-label="Resolve pending questions"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Needs your input</Dialog.Title>
          <NeedsInputPanel projectId={projectId} onEmpty={onClose} onOpenInChat={onClose} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
