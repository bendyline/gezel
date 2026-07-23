/**
 * Hand-authored SVG icons for the BUILTIN_TOOLSETS groups. Inlined as
 * string constants so the catalog package bundles cleanly with no
 * asset-copy step.
 *
 * Visual vocabulary:
 *   - 24×24 viewBox
 *   - `fill="none"`, `stroke="currentColor"`, `stroke-width="1.5"`
 *   - rounded line caps + joins
 *   - one simple geometric metaphor per group, no detailed art
 *
 * Icons pick up theme color from CSS via `currentColor`, so the
 * tile container controls hue/state (muted-when-inherited etc.)
 * without per-svg edits.
 *
 * Third-party toolsets bring their own `manifest.logo`; this file
 * is only the source of truth for our 14 built-in groups. Add a new
 * key here whenever a new entry is added to BUILTIN_TOOLSETS.
 */

const SVG_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const BUILTIN_TOOLSET_ICONS: Record<string, string> = {
  // Constellation of nodes — recall as a network of remembered points.
  memory: `<svg ${SVG_ATTRS}><circle cx="6" cy="8" r="1.5"/><circle cx="12" cy="5" r="1.5"/><circle cx="18" cy="8" r="1.5"/><circle cx="9" cy="14" r="1.5"/><circle cx="15" cy="14" r="1.5"/><circle cx="12" cy="20" r="1.5"/><path d="M6 8l3 6M12 5l-3 9M12 5l3 9M18 8l-3 6M9 14l3 6M15 14l-3 6"/></svg>`,

  // Folder + magnifying glass — read/inspect, no mutation.
  'workspace-fs-read': `<svg ${SVG_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><circle cx="14" cy="13" r="2"/><path d="M15.5 14.5L17 16"/></svg>`,
  // Folder + pencil — mutate.
  'workspace-fs-write': `<svg ${SVG_ATTRS}><path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/><path d="M11 14l4-4 2 2-4 4h-2v-2z"/></svg>`,
  // Code braces + locator dot — navigate symbols.
  'code-intel': `<svg ${SVG_ATTRS}><path d="M8 4C6 4 6 8 4 8c2 0 2 4 4 4M16 4c2 0 2 4 4 4-2 0-2 4-4 4"/><circle cx="12" cy="17" r="3"/><path d="M14.5 19.5L18 22"/></svg>`,
  // Shield + magnifier — inspect the codebase for weaknesses.
  'security-intel': `<svg ${SVG_ATTRS}><path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><circle cx="11" cy="10" r="2.5"/><path d="M12.8 11.8L15 14"/></svg>`,
  // Document + magnifier — search/read converted docs.
  'doc-intel': `<svg ${SVG_ATTRS}><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7"/><path d="M13 3v5h5"/><circle cx="16" cy="15" r="3"/><path d="M18 17l2.5 2.5"/></svg>`,
  // Picture frame + mountains — image library.
  'image-intel': `<svg ${SVG_ATTRS}><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.5"/><path d="M21 16l-5-5-4 4-2-2-7 7"/></svg>`,
  // Person node linked to mentions — cross-file entities.
  'entity-intel': `<svg ${SVG_ATTRS}><circle cx="7" cy="8" r="2.5"/><path d="M3 19a4 4 0 0 1 8 0"/><circle cx="18" cy="6" r="1.5"/><circle cx="18" cy="12" r="1.5"/><circle cx="18" cy="18" r="1.5"/><path d="M9.5 8H16M11 17h5.5M12 12h4.5"/></svg>`,

  // Stacked rectangles + a zip-pull notch.
  archives: `<svg ${SVG_ATTRS}><rect x="3" y="6" width="18" height="5" rx="1"/><rect x="3" y="13" width="18" height="6" rx="1"/><path d="M10 16h4"/></svg>`,

  // Page with corner fold + body lines.
  documents: `<svg ${SVG_ATTRS}><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h6"/></svg>`,

  // Cube/package — outputs you produce and bundle.
  artifacts: `<svg ${SVG_ATTRS}><path d="M21 8L12 3 3 8v8l9 5 9-5V8z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/></svg>`,

  // Checkbox + list lines.
  tasks: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="6" height="6" rx="1"/><path d="M4.5 7L6 8.5 8 5.5"/><rect x="3" y="14" width="6" height="6" rx="1"/><path d="M12 7h9M12 17h9"/></svg>`,

  // Three connected nodes — a small team.
  'team-management': `<svg ${SVG_ATTRS}><circle cx="12" cy="6" r="2.5"/><circle cx="6" cy="17" r="2.5"/><circle cx="18" cy="17" r="2.5"/><path d="M10.5 8L7.5 14.5M13.5 8l3 6.5M8.5 17h7"/></svg>`,

  // Terminal-like frame with a prompt arrow.
  'code-execution': `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 10l3 2-3 2M13 14h4"/></svg>`,

  // Browser window + a tiny pointer.
  'browser-automation': `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18"/><circle cx="6" cy="6.5" r="0.5" fill="currentColor"/><circle cx="8" cy="6.5" r="0.5" fill="currentColor"/><circle cx="10" cy="6.5" r="0.5" fill="currentColor"/><path d="M11 13l3 6 1-3 3-1z"/></svg>`,

  // Branch graph — two nodes on a trunk + a side node.
  git: `<svg ${SVG_ATTRS}><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8"/><path d="M6 12c0-3 3-6 6-6 2 0 4 2 4 4"/></svg>`,

  // Globe with meridian + equator.
  web: `<svg ${SVG_ATTRS}><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></svg>`,

  // Picture frame — sun + mountain.
  images: `<svg ${SVG_ATTRS}><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9" r="1.5"/><path d="M4 18l5-5 3 3 4-4 4 4"/></svg>`,

  // Clock + back arrow — looking back over time.
  history: `<svg ${SVG_ATTRS}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/></svg>`,

  // Speech bubble with a question mark.
  interaction: `<svg ${SVG_ATTRS}><path d="M21 12a8 8 0 0 1-12.5 6.5L3 20l1.5-5.5A8 8 0 1 1 21 12z"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 3.5"/><circle cx="12" cy="16" r="0.6" fill="currentColor"/></svg>`,
};
