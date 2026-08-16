import type { JSX } from 'react';
import type { FileViewMode } from './file-view-modes.js';

/* Same glyph contract as TaskStatusKeys: one 16 viewBox, one stroke weight,
   so every key reads at the same density. */
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

const TreeAlphaIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M1.8 4.6h3.6l1.4 1.5h7.4v6.9H1.8Z" />
    <path d="M6.3 11.2 7.9 7.4l1.6 3.8" strokeWidth="1.3" />
    <path d="M6.9 10h2" strokeWidth="1.3" />
  </svg>
);

const TreeModifiedIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M1.8 4.6h3.6l1.4 1.5h7.4v6.9H1.8Z" />
    <circle cx="8" cy="9.5" r="2.2" strokeWidth="1.3" />
    <path d="M8 8.5v1l0.9 0.6" strokeWidth="1.3" />
  </svg>
);

const FlatModifiedIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M2.4 3.6h11.2" />
    <path d="M2.4 7.4h5" />
    <path d="M2.4 11.2h5" />
    <circle cx="11.4" cy="10.4" r="3" strokeWidth="1.3" />
    <path d="M11.4 9v1.4l1.1 0.7" strokeWidth="1.3" />
  </svg>
);

const FlatIssuesIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M2.4 3.9h7" />
    <path d="M2.4 7.7h7" />
    <path d="M2.4 11.5h7" />
    <path d="M12.6 3.4v5.2" />
    <path d="M12.6 11.6v0.01" strokeWidth="2.4" />
  </svg>
);

const FlatCriticalityIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M2.8 11.8a5.2 5.2 0 0 1 10.4 0" />
    <path d="M8 11.8 10.7 8" />
    <path d="M8 11.8v0.01" strokeWidth="2.4" />
  </svg>
);

const HiddenFilesIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M1.4 8S3.8 3.8 8 3.8 14.6 8 14.6 8 12.2 12.2 8 12.2 1.4 8 1.4 8Z" />
    <circle cx="8" cy="8" r="1.9" strokeWidth="1.3" />
  </svg>
);

const HiddenFilesOffIcon = () => (
  <svg {...ICON_PROPS} aria-hidden="true">
    <path d="M1.4 8S3.8 3.8 8 3.8 14.6 8 14.6 8 12.2 12.2 8 12.2 1.4 8 1.4 8Z" />
    <circle cx="8" cy="8" r="1.9" strokeWidth="1.3" />
    <path d="M2.6 13.4 13.4 2.6" />
  </svg>
);

const MODE_KEYS: Record<FileViewMode, { label: string; hint: string; icon: () => JSX.Element }> = {
  'tree-alpha': {
    label: 'Folders, A to Z',
    hint: 'Folder view — folders and files sorted by name.',
    icon: TreeAlphaIcon,
  },
  'tree-modified': {
    label: 'Folders, newest first',
    hint: 'Folder view — folders by name, files with the newest changes on top.',
    icon: TreeModifiedIcon,
  },
  'flat-modified': {
    label: 'All files by last modified',
    hint: 'Every file across all folders, newest changes on top.',
    icon: FlatModifiedIcon,
  },
  'flat-issues': {
    label: 'Files by issues',
    hint: 'Files with open review issues, most issues on top.',
    icon: FlatIssuesIcon,
  },
  'flat-criticality': {
    label: 'Files by criticality',
    hint: 'Files with open review issues, weighted so major issues rank first.',
    icon: FlatCriticalityIcon,
  },
};

/**
 * The file panel's view-mode switch: icon-only keys in a tray, one shared
 * component for the Workspace and Artifacts tabs so the two panels can
 * never drift apart — the tabs differ only in which `modes` they pass.
 */
export function FileViewModeKeys({
  value,
  modes,
  onChange,
}: {
  value: FileViewMode;
  modes: readonly FileViewMode[];
  onChange: (mode: FileViewMode) => void;
}) {
  return (
    <div className="gz-tray file-view-tray" role="radiogroup" aria-label="File list view">
      {modes.map((mode) => {
        const meta = MODE_KEYS[mode];
        const Icon = meta.icon;
        const selected = mode === value;
        return (
          <button
            key={mode}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={selected}
            className={`gz-key gz-key--icon${selected ? ' gz-key-active' : ''}`}
            title={meta.hint}
            aria-label={meta.label}
            onClick={() => {
              if (!selected) onChange(mode);
            }}
          >
            <Icon />
          </button>
        );
      })}
    </div>
  );
}

/**
 * "Show hidden files" — a latching key in its own tray beside the view-mode
 * switch. Separate tray because it is a toggle, not a member of the mode
 * radiogroup. In the Workspace it reveals dotfiles and vendor folders; in
 * Artifacts it additionally reveals the reserved `shadow/` cache.
 */
export function FileHiddenKey({
  kind,
  value,
  onChange,
}: {
  kind: 'workspace' | 'artifacts' | 'documents';
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  const Icon = value ? HiddenFilesIcon : HiddenFilesOffIcon;
  const hint = value
    ? 'Hide hidden files again.'
    : kind === 'workspace'
      ? 'Show hidden files — dot-files and folders like node_modules.'
      : kind === 'artifacts'
        ? 'Show hidden files — dot-files and the generated shadow folder.'
        : 'Show hidden files — dot-files and companion folders.';
  return (
    <div className="gz-tray file-hidden-tray">
      <button
        type="button"
        aria-pressed={value}
        className={`gz-key gz-key--icon${value ? ' gz-key-active' : ''}`}
        title={hint}
        aria-label="Show hidden files"
        onClick={() => onChange(!value)}
      >
        <Icon />
      </button>
    </div>
  );
}
