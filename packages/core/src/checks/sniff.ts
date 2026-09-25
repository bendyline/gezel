/**
 * Lightweight content sniffs for a step's `advanceWhen` deliverable and the
 * `sniff` gate check: "is this plausibly the real thing, not an empty or
 * half-written placeholder". Cheap and dependency-free by design; a full
 * quality judgement is the gate's job. Both hosts and the script stdlib
 * consume this, so "html-game" means exactly one thing everywhere.
 */
import { htmlCompleteSniff, htmlGameSniff } from './html.js';
import { dataTableSniff } from './records.js';
import { jsonValid } from './text.js';

export type StepSniffName =
  | 'html-complete'
  | 'html-game'
  | 'nonempty'
  | 'json-valid'
  | 'data-table';

export function runSniff(name: StepSniffName, content: string): boolean {
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
