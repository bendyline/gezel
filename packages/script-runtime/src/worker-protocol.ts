import type { ScriptExecutionOptions, ScriptExecutionResult } from './index.js';

export interface QuickJSWorkerData {
  source: string;
  scriptName: string;
  init: ScriptExecutionOptions['init'];
  timeoutMs: number;
  sdkModuleSource: string;
  checksModuleSource: string;
}

export type QuickJSWorkerMessage = {
  runId: string;
} /** Sent the moment the worker has its instructions, before QuickJS starts. */ & (
  | { kind: 'started' }
  | { kind: 'request'; id: number; method: string; params?: unknown }
  | { kind: 'notification'; method: string; params?: unknown }
  | { kind: 'stderr'; line: string }
  | { kind: 'result'; result: ScriptExecutionResult }
);

export interface QuickJSHostReply {
  runId: string;
  id: number;
  result?: unknown;
  error?: { message: string; code?: string };
}

export const QUICKJS_MAX_MESSAGE_CHARS = 1_000_000;
export const QUICKJS_MAX_TOTAL_MESSAGE_CHARS = 4_000_000;
export const QUICKJS_MAX_CALLS = 1_000;
export const QUICKJS_MAX_PENDING_CALLS = 32;
/**
 * How long a host waits for the worker's first frame.
 *
 * A worker the platform kills before it runs — memory pressure on a phone is
 * the usual reason — fires no error event anywhere, so without this the host
 * would wait out the script's whole deadline for a run that never began.
 * Death partway through is still bounded by that deadline.
 */
export const QUICKJS_START_TIMEOUT_MS = 10_000;
