import type {
  ScriptExecutionOptions,
  ScriptExecutionResult,
} from '@bendyline/gezel-script-runtime';

export interface QuickJSWorkerData {
  source: string;
  scriptName: string;
  init: ScriptExecutionOptions['init'];
  timeoutMs: number;
  sdkModuleSource: string;
  checksModuleSource: string;
}

export type QuickJSWorkerMessage = { runId: string } & (
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
