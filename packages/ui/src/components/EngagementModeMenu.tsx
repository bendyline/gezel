import type { AIEngagementMode } from '@bendyline/gezel';
import { DropdownMenu } from '../primitives/index.js';
import { EngagementModeIcon } from './EngagementModeIcon.js';
import { ENGAGEMENT_MODES } from './engagement-modes.js';

export function EngagementModeMenu({
  mode,
  onSelect,
}: {
  mode: AIEngagementMode;
  onSelect: (mode: AIEngagementMode) => void;
}) {
  return (
    <>
      <DropdownMenu.Label className="app-engagement-heading">Crew activity</DropdownMenu.Label>
      <p className="app-engagement-intro">How independently your gezels work.</p>
      <DropdownMenu.RadioGroup
        className="gz-tray gz-tray--stops"
        aria-label="Crew activity"
        value={mode}
      >
        {ENGAGEMENT_MODES.map((option) => (
          <DropdownMenu.RadioItem
            key={option.mode}
            value={option.mode}
            textValue={option.label}
            className="gz-key gz-key--stop"
            onSelect={() => onSelect(option.mode)}
          >
            <span className="gz-stop-marker" aria-hidden="true">
              <DropdownMenu.ItemIndicator>
                <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="m4 8 2.5 2.5L12 5" />
                </svg>
              </DropdownMenu.ItemIndicator>
            </span>
            <EngagementModeIcon mode={option.mode} />
            <span className="gz-stop-copy">
              <span className="gz-key-label">{option.label}</span>
              <span className="gz-key-hint">{option.hint}</span>
            </span>
          </DropdownMenu.RadioItem>
        ))}
      </DropdownMenu.RadioGroup>
    </>
  );
}
