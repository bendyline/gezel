import type { SignInState } from '@bendyline/gezel';

/**
 * What to show before the app, on a daemon that requires accounts (a Gezel
 * container, or `gezel start --web --accounts`; ADR 0029). The desktop app
 * and embedded surfaces bring their own credential and never see this.
 */
export type GateView =
  | { kind: 'checking' }
  | { kind: 'open' }
  | { kind: 'setup'; code: string; codeAvailable: boolean }
  | { kind: 'sign-in'; notice?: string };

/** Account session tokens start with this; nothing else the browser holds does. */
export const ACCOUNT_SESSION_PREFIX = 'gzs_';
export const TOKEN_STORAGE_KEY = 'gezel:token';
/** Fired by the API client when a signed-in session stops being accepted. */
export const SIGNED_OUT_EVENT = 'gezel:signed-out';

export interface GateInputs {
  /** A credential the host page injected (Electron, VS Code, Office). */
  injectedToken: string | undefined;
  /** `?setup=` from the setup link, if the page was opened with one. */
  setupParam: string | null;
  storedToken: string | null;
  /** The daemon's sign-in state; null when it has none (an older daemon) or did not answer. */
  fetchState: () => Promise<SignInState | null>;
  /** Whether the daemon still accepts this session; null when it could not say. */
  checkSession: (token: string) => Promise<boolean | null>;
}

export async function decideGate(inputs: GateInputs): Promise<GateView> {
  if (inputs.injectedToken) return { kind: 'open' };
  const state = await inputs.fetchState();
  if (!state || !state.accountsRequired) return { kind: 'open' };
  if (state.setupRequired) {
    return {
      kind: 'setup',
      code: inputs.setupParam ?? '',
      codeAvailable: state.setupCodeAvailable,
    };
  }
  const token = inputs.storedToken;
  if (!token || !token.startsWith(ACCOUNT_SESSION_PREFIX)) return { kind: 'sign-in' };
  const accepted = await inputs.checkSession(token);
  if (accepted === false) {
    return { kind: 'sign-in', notice: 'You were signed out. Sign in again.' };
  }
  return { kind: 'open' };
}

/** True when a 401 means "this browser's account session ended". */
export function isSignedOutResponse(status: number, url: string, token: string | null): boolean {
  if (status !== 401 || !token?.startsWith(ACCOUNT_SESSION_PREFIX)) return false;
  try {
    const path = new URL(url, 'http://localhost').pathname;
    return path.startsWith('/api/') || path.startsWith('/events/');
  } catch {
    return false;
  }
}
