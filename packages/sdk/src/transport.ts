/** Initialization supplied by the sandbox host before a script starts. */
export interface ScriptInit {
  input: unknown;
  runId: string;
  projectId: string;
  engagementMode: 'proactive' | 'scheduled' | 'reactive' | 'off';
  engagementFlags: {
    llmAllowed: boolean;
  };
}

/**
 * Host boundary shared by the Node fd-3 and embedded interpreter runtimes.
 * Implementations must dispatch through the host's capability checks, reject
 * outstanding calls when a run is cancelled or disposed, and deliver a
 * notification before returning (or throw if delivery fails). Script runtimes
 * may terminate immediately after `gezel.output()` returns.
 */
export interface ScriptTransport {
  readonly init: ScriptInit;
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void;
}
