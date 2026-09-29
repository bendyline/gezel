import { useRef, useState } from 'react';

/**
 * Search for a gallery dialog's catalog. Wide dialogs always show the field; a
 * narrow one shows only a magnifier key until it is pressed, so the header does
 * not spend a whole row on a control most people never use. A query in
 * progress keeps the field open.
 */
export function GallerySearch({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const open = opened || value.length > 0;
  return (
    <div className="gz-npd-search" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="gz-npd-search-toggle"
        aria-label="Show search"
        aria-expanded={open}
        onClick={() => {
          setOpened(true);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            d="M7 1.8a5.2 5.2 0 1 0 0 10.4A5.2 5.2 0 0 0 7 1.8zm3.8 8.9 3.4 3.4"
          />
        </svg>
      </button>
      <label className="gz-npd-search-field">
        <span className="sr-only">{label}</span>
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={() => {
            if (!value) setOpened(false);
          }}
          placeholder={placeholder}
        />
      </label>
    </div>
  );
}
