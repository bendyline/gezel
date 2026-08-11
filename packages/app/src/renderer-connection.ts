export interface RendererConnectionSource {
  state: 'ready' | 'restarting' | 'failed';
  token: string;
  baseUrl: string;
  fallbackReason: { code: string; message: string } | null;
  mode: string;
}

export interface RendererConnectionSnapshot {
  token: string;
  baseUrl: string;
  fallbackReason: string | null;
  fallbackCode: string | null;
  mode: string;
}

/**
 * Never expose the previous daemon's bearer token while an owned-service
 * replacement is in flight or after recovery failed. A fresh preload on the
 * reconnect page therefore receives no connection rather than stale secrets.
 */
export function rendererConnectionSnapshot(
  connection: RendererConnectionSource | null,
): RendererConnectionSnapshot | null {
  if (!connection || connection.state !== 'ready' || !connection.token) return null;
  return {
    token: connection.token,
    baseUrl: connection.baseUrl,
    fallbackReason: connection.fallbackReason?.message ?? null,
    fallbackCode: connection.fallbackReason?.code ?? null,
    mode: connection.mode,
  };
}
