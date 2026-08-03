/**
 * Gezel-tinted Squisq reading surfaces for the transformation dialog's
 * rendered-markdown panes (thinking feed, before view). Same values as
 * the chat reference rail's previewer — warm parchment/charcoal rather
 * than Squisq's stock cool slate.
 */

export const GEZEL_DARK_SURFACE = {
  id: 'gezel-dark',
  background: '#1c1f1c',
  backgroundLight: '#252925',
  text: '#f0ede4',
  textMuted: '#9da195',
} as const;

export const GEZEL_LIGHT_SURFACE = {
  id: 'gezel-light',
  background: '#f3eddf',
  backgroundLight: '#eae5d6',
  text: '#1c1c1c',
  textMuted: '#666666',
} as const;
