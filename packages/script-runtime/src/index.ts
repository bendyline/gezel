import type { ScriptInit } from '@bendyline/gezel-sdk/portable';

export interface ScriptExecutionOptions {
  source: string;
  scriptName: string;
  init: ScriptInit;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Host-verified provenance, used only by desktop sandbox fallback policy. */
  provenanceTrusted: boolean;
  trustedReadOnlyStandard: boolean;
  onRequest(method: string, params: unknown): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  onStdout(line: string): void;
  onStderr(line: string): void;
}

export interface ScriptExecutionResult {
  exitCode: number;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  sandboxFallback?: 'trusted-readonly-macos-seatbelt-startup';
}

/** Selected by the host, never by script metadata or a model-supplied invocation. */
export interface ScriptExecutor {
  execute(options: ScriptExecutionOptions): Promise<ScriptExecutionResult>;
}
