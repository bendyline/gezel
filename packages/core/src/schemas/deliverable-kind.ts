import { z } from 'zod';

/**
 * The CLASS of artifact a step produces — the single enum shared by the
 * `deliverable` blueprint field, the `set_step_deliverable` MCP tool, and
 * the kind→gate mapping in `deliverable.ts` (which lives outside the
 * schemas layer). Its own file so both the craftbook and the book-level
 * contract schemas can import it without a cycle.
 */
export const DeliverableKindSchema = z.enum([
  'html-game',
  'html-multiscreen-game',
  'html-page',
  'html-marketing-site',
  'markdown-doc',
  'markdown-report',
  'markdown-notes',
  'json',
  'yaml-spec',
  'code-module',
  'code-with-tests',
  'security-report',
  'image-set',
  'audio-file',
  'slide-deck',
  'data-file',
  'generic-file',
]);
