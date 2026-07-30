import type { GezelSummary } from '@bendyline/gezel';
import { displayName } from '@bendyline/gezel';
import { useMemo, useState } from 'react';
import { Popover } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';

interface ChatRecipientPickerProps {
  gezels: GezelSummary[];
  primaryGezelId: string;
  additionalRecipientIds: string[];
  roleBasedNameOnlyMode: boolean;
  onSelectPrimary: (gezelId: string) => void;
  onAddRecipient: (gezelId: string) => void;
}

/**
 * Address-book popover for the chat composer's To line.
 *
 * Each row deliberately has two actions: the broad name/face key replaces the
 * primary recipient, while the small `+` key keeps the primary and adds that
 * gezel to the fan-out list.
 */
export function ChatRecipientPicker({
  gezels,
  primaryGezelId,
  additionalRecipientIds,
  roleBasedNameOnlyMode,
  onSelectPrimary,
  onAddRecipient,
}: ChatRecipientPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const named = useMemo(() => {
    const seen = new Set<string>();
    return gezels
      .filter((gezel) => {
        if (seen.has(gezel.id)) return false;
        seen.add(gezel.id);
        return true;
      })
      .map((gezel) => ({
        gezel,
        rendered: displayName(
          { name: gezel.name, roleBasedName: gezel.roleBasedName },
          roleBasedNameOnlyMode,
        ),
      }));
  }, [gezels, roleBasedNameOnlyMode]);

  const searchable = named.length > 8;
  const normalizedQuery = query.trim().toLowerCase();
  const shown =
    searchable && normalizedQuery
      ? named.filter(
          ({ gezel, rendered }) =>
            rendered.toLowerCase().includes(normalizedQuery) ||
            (gezel.role ?? '').toLowerCase().includes(normalizedQuery),
        )
      : named;
  const added = new Set(additionalRecipientIds);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="chat-composer-recipient-trigger"
          aria-label="Choose recipients"
          title="Add or change recipients"
        >
          <span className="chat-recipient-plus-glyph" aria-hidden="true">
            +
          </span>
        </button>
      </Popover.Trigger>
      <Popover.Content
        className="chat-recipient-popover"
        align="end"
        side="top"
        aria-label="Choose a gezel"
      >
        <span className="chat-recipient-popover-label">Choose a gezel</span>
        {searchable && (
          <input
            className="chat-recipient-search"
            type="search"
            value={query}
            placeholder="Search by name or role"
            aria-label="Search gezels"
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        <div className="chat-recipient-list">
          {shown.map(({ gezel, rendered }) => {
            const isPrimary = gezel.id === primaryGezelId;
            const isAdded = added.has(gezel.id);
            return (
              <div
                key={gezel.id}
                className={`chat-recipient-option${isPrimary ? ' chat-recipient-option-primary' : ''}`}
              >
                <button
                  type="button"
                  className="chat-recipient-select"
                  aria-current={isPrimary ? 'true' : undefined}
                  aria-label={`Talk to ${rendered}`}
                  onClick={() => {
                    onSelectPrimary(gezel.id);
                    setOpen(false);
                  }}
                >
                  <GezelIcon
                    svg={gezel.icon ?? null}
                    poppetje={gezel.poppetje}
                    iconOverride={gezel.iconOverride}
                    name={rendered}
                    size={26}
                  />
                  <span className="chat-recipient-option-text">
                    <span className="chat-recipient-option-name">{rendered}</span>
                    {gezel.role && <span className="chat-recipient-option-role">{gezel.role}</span>}
                  </span>
                </button>
                {isPrimary || isAdded ? (
                  <span className="chat-recipient-option-state">{isPrimary ? 'To' : 'Added'}</span>
                ) : (
                  <button
                    type="button"
                    className="chat-recipient-add"
                    aria-label={`Add ${rendered} to recipients`}
                    title={`Add ${rendered}`}
                    onClick={() => onAddRecipient(gezel.id)}
                  >
                    <span className="chat-recipient-plus-glyph" aria-hidden="true">
                      +
                    </span>
                  </button>
                )}
              </div>
            );
          })}
          {shown.length === 0 && <p className="muted small chat-recipient-empty">No matches.</p>}
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
