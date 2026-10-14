import type { AIEngagementMode } from '@bendyline/gezel';
import { type KeyboardEvent, useState } from 'react';
import { DropdownMenu, Tooltip } from '../primitives/index.js';
import { EngagementModeIcon } from './EngagementModeIcon.js';
import { ENGAGEMENT_MODES } from './engagement-modes.js';

/** Radix menus only move focus up and down; the tray is horizontal, so add left and right. */
function moveAlongTray(event: KeyboardEvent<HTMLDivElement>) {
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
  if (!step) return;
  const keys = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  const at = keys.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  keys[(at + step + keys.length) % keys.length]?.focus();
}

export function EngagementModeMenu({
  mode,
  onSelect,
}: {
  mode: AIEngagementMode;
  onSelect: (mode: AIEngagementMode) => void;
}) {
  const current = ENGAGEMENT_MODES.find((option) => option.mode === mode);
  // The latched key is already explained by the readout beneath the tray, so
  // only the other keys carry a tooltip.
  const [hinted, setHinted] = useState<AIEngagementMode | null>(null);
  return (
    <>
      <DropdownMenu.Label className="app-engagement-heading">Crew activity</DropdownMenu.Label>
      <p className="app-engagement-intro">How much your gezellen do on their own.</p>
      <Tooltip.Provider delayDuration={200}>
        <DropdownMenu.RadioGroup
          className={`gz-tray gz-tray--described app-engagement-tray engagement-mode-${mode}`}
          aria-label="Crew activity"
          value={mode}
          onKeyDown={moveAlongTray}
        >
          {ENGAGEMENT_MODES.map((option) => (
            <Tooltip.Root
              key={option.mode}
              open={hinted === option.mode && option.mode !== mode}
              onOpenChange={(open) =>
                setHinted((was) => (open ? option.mode : was === option.mode ? null : was))
              }
            >
              <Tooltip.Trigger asChild>
                <DropdownMenu.RadioItem
                  value={option.mode}
                  textValue={option.label}
                  className={`gz-key app-engagement-key${option.mode === mode ? ' gz-key-active' : ''}`}
                  onSelect={(event) => {
                    // Stay open so the readout can confirm what was applied.
                    event.preventDefault();
                    onSelect(option.mode);
                  }}
                >
                  <EngagementModeIcon mode={option.mode} />
                  <span className="gz-key-label">{option.label}</span>
                </DropdownMenu.RadioItem>
              </Tooltip.Trigger>
              <Tooltip.Content>{option.description}</Tooltip.Content>
            </Tooltip.Root>
          ))}
        </DropdownMenu.RadioGroup>
      </Tooltip.Provider>
      {current && (
        <p className="gz-tray-description app-engagement-readout">
          <strong>{current.label}</strong> — {current.description}
        </p>
      )}
    </>
  );
}
