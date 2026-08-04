import { useState } from 'react';
import { api } from '../api.js';
import { DropdownMenu } from '../primitives/index.js';
import { ConfirmDialog } from './ConfirmDialog.js';

export const GEZEL_REMOVAL_EUPHEMISMS = [
  'Retire gezel',
  'Let gezel win the lottery',
  'Send gezel to recess',
] as const;

type GezelRemovalEuphemism = (typeof GEZEL_REMOVAL_EUPHEMISMS)[number];

export function randomGezelRemovalEuphemism(): GezelRemovalEuphemism {
  const index = Math.floor(Math.random() * GEZEL_REMOVAL_EUPHEMISMS.length);
  return GEZEL_REMOVAL_EUPHEMISMS[index] ?? GEZEL_REMOVAL_EUPHEMISMS[0];
}

function personalizeEuphemism(euphemism: GezelRemovalEuphemism, name: string): string {
  switch (euphemism) {
    case 'Retire gezel':
      return `Retire ${name}`;
    case 'Let gezel win the lottery':
      return `Let ${name} win the lottery`;
    case 'Send gezel to recess':
      return `Send ${name} to recess`;
  }
}

/** Shared per-gezel actions menu used by both detail-pane placements. */
export function GezelActionsMenu({
  gezel,
  onDeleted,
  compact = false,
}: {
  gezel: { id: string; name: string; storageScope?: 'user' | 'machine-shared' };
  onDeleted?: (gezelId: string) => void;
  /** Row menus are smaller and reveal on row hover/focus. */
  compact?: boolean;
}) {
  // Pick once per mounted detail pane: playful on each visit, stable while
  // the user moves between tabs or reads the confirmation.
  const [euphemism] = useState(randomGezelRemovalEuphemism);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This menu currently contains only account-destructive removal. A shared
  // identity cannot be removed safely without a distinct machine-wide flow.
  if (gezel.storageScope === 'machine-shared') return null;

  const openConfirm = () => {
    setError(null);
    setConfirming(true);
  };

  const removeGezel = async () => {
    setError(null);
    try {
      await api.deleteGezel(gezel.id);
      setConfirming(false);
      window.dispatchEvent(
        new CustomEvent('gezel:gezel-deleted', {
          detail: { gezelId: gezel.id, name: gezel.name },
        }),
      );
      onDeleted?.(gezel.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  const personalized = personalizeEuphemism(euphemism, gezel.name);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={`gezel-actions-trigger${compact ? ' gezel-actions-trigger--row' : ''}`}
            aria-label={`Actions for ${gezel.name}`}
            title="Gezel actions"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="app-nav-menu gezel-actions-menu"
            sideOffset={4}
            align="end"
          >
            <DropdownMenu.Item className="app-nav-menu-item danger" onSelect={openConfirm}>
              {euphemism}…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      <ConfirmDialog
        open={confirming}
        title={`${personalized}?`}
        message={
          <>
            This will permanently remove {gezel.name}, including their chats, memories, and
            settings, from your system. You won't be able to get this gezel back.
            {error && <span className="gezel-delete-error">{error}</span>}
          </>
        }
        confirmLabel={personalized}
        danger
        onConfirm={removeGezel}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
