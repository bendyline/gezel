import type { TaskStatus } from '@bendyline/gezel';
import type { JSX } from 'react';

/* One 14×14 viewBox, stroke width, and cap/join across the glyphs so all four
   read at the same weight inside a key. Play and pause take a solid fill the
   way media controls always have; check and circle-slash stay stroked. */
const ICON_PROPS = {
  width: 14,
  height: 14,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
} as const;

const ActiveIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M5.2 3.4 12.2 8 5.2 12.6Z" fill="currentColor" />
  </svg>
);

const PausedIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M6 3.6V12.4" strokeWidth="2.4" />
    <path d="M10 3.6V12.4" strokeWidth="2.4" />
  </svg>
);

const CompleteIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M3.2 8.6 6.4 11.8 12.8 4.6" />
  </svg>
);

const CanceledIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <circle cx="8" cy="8" r="5.2" />
    <path d="M4.4 11.6 11.6 4.4" />
  </svg>
);

const STATUS_KEYS: Record<
  Exclude<TaskStatus, 'draft'>,
  { label: string; hint: string; icon: () => JSX.Element }
> = {
  active: {
    label: 'Active',
    hint: 'Active — work runs and gezels pick it up.',
    icon: ActiveIcon,
  },
  paused: {
    label: 'Paused',
    hint: 'Paused — held where it stands until you resume it.',
    icon: PausedIcon,
  },
  complete: {
    label: 'Complete',
    hint: 'Complete — the work is done and filed.',
    icon: CompleteIcon,
  },
  canceled: {
    label: 'Canceled',
    hint: 'Canceled — closed without finishing.',
    icon: CanceledIcon,
  },
};

export const TASK_STATUS_KEY_ORDER: Array<Exclude<TaskStatus, 'draft'>> = [
  'active',
  'paused',
  'complete',
  'canceled',
];

/**
 * The task's lifecycle state as a row of keys rather than a dropdown: the
 * current state is readable without opening anything, and each key carries
 * the glyph its state is already understood by (play / pause / check /
 * circle-slash). Drafts don't appear here — they get the Fire/Discard pair.
 */
export function TaskStatusKeys({
  value,
  options = TASK_STATUS_KEY_ORDER,
  disabled = false,
  onChange,
}: {
  value: TaskStatus;
  options?: Array<Exclude<TaskStatus, 'draft'>>;
  disabled?: boolean;
  onChange: (status: TaskStatus) => void;
}) {
  return (
    <div className="gz-tray task-status-tray" role="radiogroup" aria-label="Task status">
      {options.map((status) => {
        const meta = STATUS_KEYS[status];
        const Icon = meta.icon;
        const selected = status === value;
        return (
          <button
            key={status}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={selected}
            data-status={status}
            disabled={disabled}
            className={`gz-key task-status-key${selected ? ' gz-key-active' : ''}`}
            title={meta.hint}
            onClick={() => {
              if (!selected) onChange(status);
            }}
          >
            <Icon />
            <span>{meta.label}</span>
          </button>
        );
      })}
    </div>
  );
}
