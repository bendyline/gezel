import type { Craftbook } from '../../core/src/browser.js';
import { craftbookHostGap } from '../../core/src/runtime/craftbook-host-gap.js';
import { PORTABLE_GATE_CHECK_KINDS } from '../../core/src/runtime/task-gates.js';
import { supportsPortableScriptSource } from './portable-script-support.js';

const checks = new Set(PORTABLE_GATE_CHECK_KINDS);
const scripts = new Set([
  'checkFileExists',
  'checkJsonValid',
  'checkContains',
  'checkWordBand',
  'checkFileMinBytes',
  'checkFileMinLines',
  'checkFileCount',
  'checkOrderedSections',
  'checkTableShape',
  'checkTaskNoteContains',
  'storeRecords',
  'publishCorpusBatches',
]);

/** Why the phone cannot run this book, or null when it can (see `craftbookHostGap`). */
export function portableContentGap(
  book: Craftbook,
  availableTools: ReadonlySet<string>,
): string | null {
  return craftbookHostGap(book, {
    tools: availableTools,
    standardScripts: scripts,
    gateCheckKinds: checks,
    supportsScript: supportsPortableScriptSource,
  });
}

export function supportsPortableContent(
  book: Craftbook,
  availableTools: ReadonlySet<string>,
): boolean {
  return portableContentGap(book, availableTools) === null;
}
