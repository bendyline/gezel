/**
 * The renderer's data layer. Server state is read through here and nowhere
 * else: `useApiRead` in components, `peekRead` to paint a first frame from
 * memory, `setRead` / `dataChanged` after a write. See docs/ui-architecture.md.
 */
export { installApiReads, peekRead, resetReads, setRead } from './api-reads.js';
export {
  dataChanged,
  streamEventChangedData,
  watchProductChangeEvents,
  withReadInvalidation,
} from './invalidation.js';
export { queryClient } from './query-client.js';
export { READS, type ReadArgs, type ReadName, type ReadScope, type ReadValue } from './reads.js';
export { type ApiReadResult, useApiRead, useConfig } from './use-api-read.js';
