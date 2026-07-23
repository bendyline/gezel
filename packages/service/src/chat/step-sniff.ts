import {
  dataTableSniff,
  htmlCompleteSniff,
  htmlGameSniff,
  jsonValid,
} from '@bendyline/gezel/checks';

/**
 * Lightweight content sniffs for the craftbook `advanceWhen` gate (the
 * observable-progress auto-advance). The runtime runs the named sniff over a
 * step's declared deliverable before auto-advancing — so a stub or a
 * truncated file does NOT trip the advance. Deliberately cheap and
 * dependency-free (no Playwright, no parser): the goal is "is this plausibly
 * the real deliverable, not an empty/half-written placeholder", not a full
 * quality judgment (that's the gate's job).
 *
 * The sniff implementations live in `@bendyline/gezel/checks` — the shared
 * module the gate engine, script stdlib, and eval harness all consume — so
 * "html-game" means exactly the same thing everywhere.
 */

export type StepSniffName =
  | 'html-complete'
  | 'html-game'
  | 'nonempty'
  | 'json-valid'
  | 'data-table';

export function runStepSniff(name: StepSniffName, content: string): boolean {
  switch (name) {
    case 'nonempty':
      return content.trim().length > 0;
    case 'json-valid':
      return jsonValid(content).ok;
    case 'html-complete':
      return htmlCompleteSniff(content);
    case 'html-game':
      return htmlGameSniff(content);
    case 'data-table':
      return dataTableSniff(content);
  }
}
