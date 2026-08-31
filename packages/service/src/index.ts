export { startService } from './service.js';
export type { RunningService, StartServiceOptions } from './service.js';
export type {
  UnexpectedHttpErrorEvent,
  UnexpectedHttpErrorHandler,
} from './http/server.js';
export { Store } from './fs/store.js';
export { TaskManager } from './tasks/manager.js';
export { TaskScheduler } from './tasks/scheduler.js';
export { runInSandbox } from './sandbox/runner.js';
export type { SandboxRunOptions, SandboxRunResult } from './sandbox/runner.js';
export { MemoryManager } from './memory/manager.js';
export { MemoryCompactor } from './memory/compaction.js';
// Embedding utilities — the same pipeline every index/memory vector rides.
// Exported for tooling (the evals embed-calibration harness) and embedders;
// query-side callers must use embedQuery (asymmetric instruction prefix).
export { embed, embedBatch, embedQuery, warmEmbeddings } from './memory/embeddings.js';
export { embedModelId } from './memory/embed-core.js';
export { evaluateGate, gateCheckLabel, taskSuppliedCitationPaths } from './tasks/gate-eval.js';
export type { GateCheckOutcome, GateCheckResult, GateEvalDeps } from './tasks/gate-eval.js';
export { parseScriptMeta } from './scripts/meta.js';
export {
  reuseVerifiedElectronNativeBinaries,
  type ElectronNativeReuseOptions,
  type ElectronNativeReuseResult,
} from './engines/electron-native-reuse.js';
