import 'hono';
declare module 'hono' {
  interface ContextVariableMap {
    /**
     * Set by {@link bearerAuth} once the request's bearer token is
     * resolved to a known {@link import('./token-store.js').TokenRecord}.
     * Route handlers (and the {@link requireScope} middleware) read this
     * to audit per-app calls and gate scope-sensitive endpoints. Absent
     * on the unauthenticated `/api/health` path.
     */
    auth: {
      appId: string;
      /** Human-readable connected-app name, used for audit and queue labels. */
      appName?: string;
      scopes: readonly string[];
      /** Present on session-scoped tokens (a gezel's MCP subprocess); the
       *  scope-guard confines them to this project unless `team`. */
      projectId?: string;
      gezelId?: string;
      team?: boolean;
      /**
       * The signed-in account behind an account session (ADR 0029, the
       * principal from ADR 0004). Absent for app, device and owner
       * credentials.
       */
      account?: { id: string; source: 'password' | 'device' | 'os'; label: string };
      /** The account session this request came in on, for "sign out this browser". */
      accountSessionId?: string;
    };
  }
}
