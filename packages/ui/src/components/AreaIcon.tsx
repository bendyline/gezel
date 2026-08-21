import type { RecentTabArea } from '@bendyline/gezel';
import type { JSX } from 'react';

interface AreaIconProps {
  area: RecentTabArea;
  size?: number;
  className?: string;
}

/**
 * Distinct SVG glyph for each top-level area. Stroke-only, drawn in
 * `currentColor` so the icon inherits whatever color its surrounding
 * text/menu uses. Sized at 14px to match the tab bar's glyph slot by
 * default; override via `size` for the dropdown menu (16–18px reads
 * better next to the label there).
 */
export function AreaIcon({ area, size = 14, className }: AreaIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {AREA_PATHS[area]}
    </svg>
  );
}

const AREA_PATHS: Record<RecentTabArea, JSX.Element> = {
  // Briefcase — the workspace where projects live
  projects: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </>
  ),
  // Two crew silhouettes — gezels are the team
  gezels: (
    <>
      <circle cx="9" cy="9" r="3.2" />
      <path d="M3 19c0-3 2.7-5.5 6-5.5s6 2.5 6 5.5" />
      <path d="M16 4.5a3 3 0 0 1 0 6" />
      <path d="M21 19c0-2.4-1.7-4.5-4-5.2" />
    </>
  ),
  // Document with corner fold
  documents: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h6" />
    </>
  ),
  // Checklist clipboard
  tasks: (
    <>
      <rect x="6" y="4" width="12" height="17" rx="2" />
      <path d="M9 4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1z" />
      <path d="M9 12l2 2 4-4" />
      <path d="M9 17h6" />
    </>
  ),
  // Globe — knowledge catalogs are world reference material
  knowledge: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3c2.8 2.4 4.2 5.6 4.2 9S14.8 18.6 12 21c-2.8-2.4-4.2-5.6-4.2-9S9.2 5.4 12 3z" />
    </>
  ),
  // Open recipe book — craftbooks are step-by-step procedures
  craftbooks: (
    <>
      <path d="M12 5c-1.5-1.2-3.5-1.8-5.5-1.8C5 3.2 4 3.5 3 4v14c1-.5 2-.8 3.5-.8 2 0 4 .6 5.5 1.8" />
      <path d="M12 5c1.5-1.2 3.5-1.8 5.5-1.8 1.5 0 2.5.3 3.5.8v14c-1-.5-2-.8-3.5-.8-2 0-4 .6-5.5 1.8z" />
      <path d="M12 5v14" />
    </>
  ),
  // Code brackets — `< />`
  scripts: (
    <>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
      <path d="M14 4l-4 16" />
    </>
  ),
  // Clock with rewind arrow
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <polyline points="3 3 3 8 8 8" />
      <polyline points="12 7 12 12 15 14" />
    </>
  ),
  // Gear / cog
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  // Bar chart — benchmarks compare runs across models / hardware
  benchmarks: (
    <>
      <line x1="3" y1="20" x2="21" y2="20" />
      <rect x="5" y="11" width="3" height="8" />
      <rect x="10.5" y="7" width="3" height="12" />
      <rect x="16" y="14" width="3" height="5" />
    </>
  ),
  // Closed book with bookmark ribbon — the Handboek (documentation).
  // Distinct from `craftbooks`, which draws an open two-page spread.
  handboek: (
    <>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <path d="M10 2v7l2.5-1.8L15 9V2" />
    </>
  ),
};
