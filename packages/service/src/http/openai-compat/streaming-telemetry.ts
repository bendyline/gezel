export type StreamingProviderActivity =
  | 'content'
  | 'reasoning'
  | 'tool_arguments'
  | 'wire_pulse'
  | 'heartbeat';

export type StreamingOutboundKind =
  | 'opener'
  | 'content'
  | 'reasoning'
  | 'keepalive'
  | 'tool_calls'
  | 'finish'
  | 'usage'
  | 'done';

/**
 * Mutable, request-local counters shared with the HTTP boundary. They contain
 * timings and counts only — never prompt, reasoning, tool arguments, or reply
 * text — so an abort can be diagnosed without logging user content.
 */
export interface StreamingDiagnostics {
  responseId?: string;
  startedAtMs: number;
  lastProviderActivityAtMs?: number;
  lastProviderActivity?: StreamingProviderActivity;
  lastOutboundAtMs?: number;
  lastOutbound?: StreamingOutboundKind;
  maxOutboundSilenceMs: number;
  firstContentAtMs?: number;
  firstReasoningAtMs?: number;
  firstToolArgumentsAtMs?: number;
  contentChunks: number;
  reasoningChunks: number;
  toolArgumentChunks: number;
  wirePulses: number;
  providerHeartbeats: number;
  keepalives: number;
  capturedToolCalls: number;
}

export function createStreamingDiagnostics(startedAtMs = Date.now()): StreamingDiagnostics {
  return {
    startedAtMs,
    maxOutboundSilenceMs: 0,
    contentChunks: 0,
    reasoningChunks: 0,
    toolArgumentChunks: 0,
    wirePulses: 0,
    providerHeartbeats: 0,
    keepalives: 0,
    capturedToolCalls: 0,
  };
}

export function noteStreamingProviderActivity(
  diagnostics: StreamingDiagnostics | undefined,
  activity: StreamingProviderActivity,
  atMs = Date.now(),
): void {
  if (!diagnostics) return;
  diagnostics.lastProviderActivity = activity;
  diagnostics.lastProviderActivityAtMs = atMs;
  switch (activity) {
    case 'content':
      diagnostics.contentChunks += 1;
      diagnostics.firstContentAtMs ??= atMs;
      break;
    case 'reasoning':
      diagnostics.reasoningChunks += 1;
      diagnostics.firstReasoningAtMs ??= atMs;
      break;
    case 'tool_arguments':
      diagnostics.toolArgumentChunks += 1;
      diagnostics.firstToolArgumentsAtMs ??= atMs;
      break;
    case 'wire_pulse':
      diagnostics.wirePulses += 1;
      break;
    case 'heartbeat':
      diagnostics.providerHeartbeats += 1;
      break;
  }
}

export function noteStreamingOutbound(
  diagnostics: StreamingDiagnostics | undefined,
  kind: StreamingOutboundKind,
  atMs = Date.now(),
): void {
  if (!diagnostics) return;
  const previousAtMs = diagnostics.lastOutboundAtMs ?? diagnostics.startedAtMs;
  diagnostics.maxOutboundSilenceMs = Math.max(
    diagnostics.maxOutboundSilenceMs,
    Math.max(0, atMs - previousAtMs),
  );
  diagnostics.lastOutbound = kind;
  diagnostics.lastOutboundAtMs = atMs;
  if (kind === 'keepalive') diagnostics.keepalives += 1;
}

function relativeMs(value: number | undefined, startedAtMs: number): number | undefined {
  return value === undefined ? undefined : Math.max(0, value - startedAtMs);
}

export function snapshotStreamingDiagnostics(
  diagnostics: StreamingDiagnostics,
  atMs = Date.now(),
): Record<string, unknown> {
  const lastOutboundAtMs = diagnostics.lastOutboundAtMs ?? diagnostics.startedAtMs;
  const currentOutboundIdleMs = Math.max(0, atMs - lastOutboundAtMs);
  const lastProviderActivityAtMs = diagnostics.lastProviderActivityAtMs;
  return {
    ...(diagnostics.responseId ? { responseId: diagnostics.responseId } : {}),
    elapsedMs: Math.max(0, atMs - diagnostics.startedAtMs),
    currentOutboundIdleMs,
    maxOutboundSilenceMs: Math.max(diagnostics.maxOutboundSilenceMs, currentOutboundIdleMs),
    ...(diagnostics.lastOutbound ? { lastOutbound: diagnostics.lastOutbound } : {}),
    ...(diagnostics.lastProviderActivity
      ? { lastProviderActivity: diagnostics.lastProviderActivity }
      : { phase: 'awaiting_first_provider_delta' }),
    ...(lastProviderActivityAtMs !== undefined
      ? { providerIdleMs: Math.max(0, atMs - lastProviderActivityAtMs) }
      : {}),
    ...(diagnostics.firstContentAtMs !== undefined
      ? { firstContentMs: relativeMs(diagnostics.firstContentAtMs, diagnostics.startedAtMs) }
      : {}),
    ...(diagnostics.firstReasoningAtMs !== undefined
      ? { firstReasoningMs: relativeMs(diagnostics.firstReasoningAtMs, diagnostics.startedAtMs) }
      : {}),
    ...(diagnostics.firstToolArgumentsAtMs !== undefined
      ? {
          firstToolArgumentsMs: relativeMs(
            diagnostics.firstToolArgumentsAtMs,
            diagnostics.startedAtMs,
          ),
        }
      : {}),
    contentChunks: diagnostics.contentChunks,
    reasoningChunks: diagnostics.reasoningChunks,
    toolArgumentChunks: diagnostics.toolArgumentChunks,
    wirePulses: diagnostics.wirePulses,
    providerHeartbeats: diagnostics.providerHeartbeats,
    keepalives: diagnostics.keepalives,
    capturedToolCalls: diagnostics.capturedToolCalls,
  };
}
