import type { JSX } from 'react';
import { AreaIcon } from './AreaIcon.js';

export type SectionIconName =
  | 'output'
  | 'chat'
  | 'overview'
  | 'tasks'
  | 'tools'
  | 'workspace'
  | 'artifacts'
  | 'proposals'
  | 'github'
  | 'mail'
  | 'village'
  | 'settings'
  | 'skills'
  | 'references';

/**
 * Glyphs for the sections inside a project and a conversation — the tabs that
 * collapse to icons when their labels no longer fit. Same drawing rules as
 * {@link AreaIcon}: 24×24, stroke-only, `currentColor`. Tasks and Settings
 * delegate to the navigation rail's own glyphs so one concept keeps one
 * picture across the app.
 */
export function SectionIcon({
  name,
  size = 18,
  className,
}: {
  name: SectionIconName;
  size?: number;
  className?: string;
}) {
  if (name === 'tasks' || name === 'settings') {
    return <AreaIcon area={name} size={size} className={className} />;
  }
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
      data-section-icon={name}
    >
      {SECTION_PATHS[name]}
    </svg>
  );
}

const SECTION_PATHS: Record<Exclude<SectionIconName, 'tasks' | 'settings'>, JSX.Element> = {
  // A browser window with a play mark — the rendered page the project produces
  output: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M3 8.5h18" />
      <path d="M10.5 11.5l4 2.5-4 2.5z" />
    </>
  ),
  // Speech bubble
  chat: (
    <path d="M5 4.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-4.5 3.5v-3.5H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z" />
  ),
  // Dashboard of uneven panels
  overview: (
    <>
      <rect x="3.5" y="3.5" width="7" height="8" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="14.5" width="7" height="6" rx="1.5" />
    </>
  ),
  // Open-ended wrench
  tools: (
    <path d="M15.5 3.5a5 5 0 0 0-4.6 6.9L4 17.3a2 2 0 0 0 2.8 2.8l6.9-6.9a5 5 0 0 0 6.8-4.6L16.8 7.2z" />
  ),
  // Folder — the files the project works in
  workspace: (
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.5l2 2.5H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" />
  ),
  // Two-drawer cabinet — the artifacts drawer
  artifacts: (
    <>
      <rect x="3.5" y="4" width="17" height="16" rx="2" />
      <path d="M3.5 12h17" />
      <path d="M10 8h4" />
      <path d="M10 16h4" />
    </>
  ),
  // Page carrying a plus and a minus — a proposed diff
  proposals: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M12 9v5M9.5 11.5h5" />
      <path d="M9.5 17h5" />
    </>
  ),
  // Branch
  github: (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="9" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M17.5 11.2c0 3.3-5.5 2.3-8.5 4.3" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
      <path d="M4.5 7l7.5 6 7.5-6" />
    </>
  ),
  // Two houses on a street
  village: (
    <>
      <path d="M3 20.5h18" />
      <path d="M4.5 20.5v-7l4-3.5 4 3.5v7" />
      <path d="M12.5 20.5V11l3.5-3 3.5 3v9.5" />
      <path d="M7.5 20.5v-3h2v3" />
    </>
  ),
  // Sparkle — something the crew knows how to do
  skills: (
    <>
      <path d="M11 3.5l1.9 5.1 5.1 1.9-5.1 1.9L11 17.5l-1.9-5.1L4 10.5l5.1-1.9z" />
      <path d="M18.5 15v4.5M16.25 17.25h4.5" />
    </>
  ),
  // Stacked pages — material the conversation pulled in
  references: (
    <>
      <path d="M8 3.5h8.5L20 7v11a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 18V5A1.5 1.5 0 0 1 8 3.5z" />
      <path d="M4 7.5v12A1.5 1.5 0 0 0 5.5 21H15" />
      <path d="M10 10h6.5M10 13.5h6.5" />
    </>
  ),
};
