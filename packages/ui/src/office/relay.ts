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
  /** The gezel the pane talks to: the only one offered the tools. */
  gezelId: string;
  /** The pane's chat surface: only threads it is driving are offered the tools. */
  surfaceId: string;
  label: string;
  tools: AppToolDefinition[];
  onStatus: (status: RelayStatus) => void;
  /** The token stopped working (revoked in Gezel). */
  onUnauthorized: () => void;
  register?: typeof registerAppTools;
}

/**
 * The pane's document tools, offered while the pane is open to the one
 * gezel it talks to, and only in the threads the pane's own chat is driving.
 * Offering them to the gezel's every session put a live document writer in
 * its other chats too — the Meester's front-door chat in the desktop app
 * when the pane talks to the Meester, and its background work. `keepalive`
 * lets the closing DELETE leave while the pane is being torn down; the
 * daemon's short grace window covers the rest.
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
        gezelIds: [opts.gezelId],
        surfaceId: opts.surfaceId,
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
