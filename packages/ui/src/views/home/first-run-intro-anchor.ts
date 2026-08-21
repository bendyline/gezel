/**
 * DOM id of the embedded "What is gezel?" intro on the Home view.
 *
 * Shared so the first-run download banner can point a waiting user at the
 * article without importing the view it lives in (which would be a cycle:
 * HomeView renders the banner).
 */
export const FIRST_RUN_INTRO_ANCHOR_ID = 'gezel-first-run-intro';
