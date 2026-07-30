import type { GezelSummary } from '@bendyline/gezel';
import { Select } from '../primitives/index.js';
import { GezelIcon } from './GezelIcon.js';

const NO_GEZEL_VALUE = '__GEZEL_PICKER_NONE__';

interface GezelPickerProps {
  gezels: readonly GezelSummary[];
  value?: string | null;
  onValueChange: (gezelId: string | null) => void;
  /** Adds a choice that clears the selection. */
  noneLabel?: string;
  /** Text shown in the trigger when no gezel is selected. */
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Shared single-gezel picker.
 *
 * Keep gezel identity consistent in both halves of the select: the closed
 * trigger and every option show the same poppetje, name, and role.
 */
export function GezelPicker({
  gezels,
  value,
  onValueChange,
  noneLabel,
  placeholder = 'Select a gezel…',
  ariaLabel,
  disabled,
  className,
}: GezelPickerProps) {
  const selected = gezels.find((gezel) => gezel.id === value);
  const triggerClassName = ['gezel-picker-trigger', className].filter(Boolean).join(' ');

  return (
    <Select.Root
      value={selected?.id ?? NO_GEZEL_VALUE}
      disabled={disabled}
      onValueChange={(next) => onValueChange(next === NO_GEZEL_VALUE ? null : next)}
    >
      <Select.Trigger className={triggerClassName} aria-label={ariaLabel}>
        <Select.Value>
          {selected ? (
            <GezelPickerRow gezel={selected} />
          ) : (
            <span className="gezel-picker-empty">{noneLabel ?? placeholder}</span>
          )}
        </Select.Value>
      </Select.Trigger>
      <Select.Content className="gezel-picker-menu">
        {noneLabel && <Select.Item value={NO_GEZEL_VALUE}>{noneLabel}</Select.Item>}
        {gezels.map((gezel) => (
          <Select.Item key={gezel.id} value={gezel.id} textValue={gezelTextValue(gezel)}>
            <GezelPickerRow gezel={gezel} />
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}

function GezelPickerRow({ gezel }: { gezel: GezelSummary }) {
  return (
    <span className="gezel-picker-option">
      <GezelIcon
        svg={gezel.icon ?? null}
        poppetje={gezel.poppetje}
        iconOverride={gezel.iconOverride}
        name={gezel.name}
        size={26}
      />
      <span className="gezel-picker-option-text">
        <span className="gezel-picker-option-name">{gezel.name}</span>
        {gezel.role && <span className="gezel-picker-option-role">— {gezel.role}</span>}
      </span>
    </span>
  );
}

function gezelTextValue(gezel: GezelSummary): string {
  return gezel.role ? `${gezel.name} — ${gezel.role}` : gezel.name;
}
