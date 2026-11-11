/**
 * Gezel-tinted Squisq reading surfaces for rendered-markdown panes: the
 * transformation dialog (thinking feed, before view) and the chat reference
 * rail's previewer. Warm parchment by day and charcoal by night, rather than
 * Squisq's stock cool slate. Squisq takes literal colors here, so the dark
 * values repeat foundation.css's dark panel, inset and cream inks.
 */

export const GEZEL_DARK_SURFACE = {
  id: 'gezel-dark',
  background: '#1f1e1d',
  backgroundLight: '#252423',
  text: '#f3ede0',
  textMuted: '#a8a49e',
} as const;

export const GEZEL_LIGHT_SURFACE = {
  id: 'gezel-light',
  background: '#f3eddf',
  backgroundLight: '#eae5d6',
  text: '#1c1c1c',
  textMuted: '#666666',
} as const;
