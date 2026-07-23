export {
  type FolderScope,
  FOLDER_SCOPES,
  defaultRootForScope,
  sourceRootForScope,
  backupRootForScope,
  makeScopeFilter,
} from './scope.js';
export { type ValidationResult, validateExternalPath } from './validation.js';
export { type MovePlan, planMove } from './plan.js';
export {
  type MoveJob,
  type MoveJobPhase,
  type MoveJobStatus,
  JobManager,
} from './job-manager.js';
export { type RunMoveOpts, runMove } from './move-worker.js';
export {
  type ActiveMoveSentinel,
  detectInterruptedMove,
  readSentinel,
} from './recovery.js';
