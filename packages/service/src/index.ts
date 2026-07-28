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
export { evaluateGate, gateCheckLabel } from './tasks/gate-eval.js';
export type { GateCheckOutcome, GateCheckResult, GateEvalDeps } from './tasks/gate-eval.js';
export { parseScriptMeta } from './scripts/meta.js';
export {
  reuseVerifiedElectronNativeBinaries,
  type ElectronNativeReuseOptions,
  type ElectronNativeReuseResult,
} from './engines/electron-native-reuse.js';
