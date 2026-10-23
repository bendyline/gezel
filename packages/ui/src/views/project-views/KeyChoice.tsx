import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';

/**
 * The Views' toolbar keys (ux.md "keys in trays"): one choice among a few
 * as a radio tray, and an on/off key.
 */

export interface KeyOption<T> {
  value: T;
  label: string;
  title?: string;
  disabled?: boolean;
}

export function KeyChoice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly KeyOption<T>[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="gz-tray" role="radiogroup" aria-label={label} onKeyDown={onRadioKeyDown}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={`gz-key${on ? ' gz-key-active' : ''}`}
            title={o.title}
            disabled={o.disabled}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleKey({
  label,
  title,
  pressed,
  onChange,
}: {
  label: string;
  title: string;
  pressed: boolean;
  onChange: (pressed: boolean) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={`gz-key${pressed ? ' gz-key-active' : ''}`}
      title={title}
      onClick={() => onChange(!pressed)}
    >
      {label}
    </button>
  );
}
