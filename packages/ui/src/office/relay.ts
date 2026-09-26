import {
  type AppToolDefinition,
  type AppToolsRegistration,
  registerAppTools,
} from '@bendyline/gezel-app-sdk/browser';

export type RelayStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface OfficeRelay {
  /** Replace the offered tools (edits switched on or off). */
  update(tools: AppToolDefinition[]): Promise<void>;
  close(): Promise<void>;
}

export interface StartRelayOptions {
  baseUrl: string;
  token: string;
  projectId: string;
  label: string;
  tools: AppToolDefinition[];
  onStatus: (status: RelayStatus) => void;
  /** The token stopped working (revoked in Gezel). */
  onUnauthorized: () => void;
  register?: typeof registerAppTools;
}

/**
 * The pane's document tools, offered to every gezel on the project while
 * the pane is open. `keepalive` lets the closing DELETE leave while the
 * pane is being torn down; the daemon's short grace window covers the rest.
 */
export async function startOfficeRelay(opts: StartRelayOptions): Promise<OfficeRelay> {
  const register = opts.register ?? registerAppTools;
  const keepaliveFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, ...(init?.method === 'DELETE' ? { keepalive: true } : {}) });
  opts.onStatus('connecting');
  let registration: AppToolsRegistration;
  try {
    registration = await register(
      { baseUrl: opts.baseUrl, token: opts.token, fetch: keepaliveFetch },
      {
        projectId: opts.projectId,
        tools: opts.tools,
        label: opts.label,
        onStatus: (status) => opts.onStatus(status),
      },
    );
  } catch (err) {
    if ((err as { status?: number }).status === 401) opts.onUnauthorized();
    opts.onStatus('closed');
    throw err;
  }
  registration.ready.catch((err: unknown) => {
    if ((err as { status?: number }).status === 401) opts.onUnauthorized();
  });
  return {
    update: (tools) => registration.update(tools),
    close: () => registration.close(),
  };
}
