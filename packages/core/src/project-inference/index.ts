export * from './types.js';
export * from './path-compare.js';
export * from './document-names.js';
export * from './well-known-folders.js';
export * from './forbidden-roots.js';
export {
  containsExistingProject,
  deepestContainingProject,
  depthBelowWellKnown,
  inferProjectRoot,
  scoreContainerName,
  scoreDepth,
  scoreMarker,
} from './infer-root.js';
export type { InferInput } from './infer-root.js';
export { memoryFsProbe } from './memory-probe.js';
