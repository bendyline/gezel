import type { SignInResponse, SignInState } from '@bendyline/gezel';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { type GateView, SIGNED_OUT_EVENT, TOKEN_STORAGE_KEY, decideGate } from './gate.js';
import './sign-in.css';

/**
 * Stands in front of the app on a daemon that requires accounts (a Gezel
 * container, or `gezel start --web --accounts`; ADR 0029): the first-account
 * setup, sign-in, and sign-in again when a session ends. Everywhere else it
 * renders the app straight away.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  // A host that injected a credential (the desktop app, VS Code) opens on the
  // first frame: the startup screen hands over to the live app without a gap.
  const [view, setView] = useState<GateView>(() =>
    window.__GEZEL__?.token ? { kind: 'open' } : { kind: 'checking' },
  );

  useEffect(() => {
    if (window.__GEZEL__?.token) return;
    let cancelled = false;
    void decideGate({
      injectedToken: window.__GEZEL__?.token,
      setupParam: new URLSearchParams(window.location.search).get('setup'),
      storedToken: readStoredToken(),
      fetchState,
      checkSession,
    }).then((next) => {
      if (!cancelled) setView(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onSignedOut = () => {
      writeStoredToken(null);
      setView({ kind: 'sign-in', notice: 'You were signed out. Sign in again.' });
    };
    window.addEventListener(SIGNED_OUT_EVENT, onSignedOut);
    return () => window.removeEventListener(SIGNED_OUT_EVENT, onSignedOut);
  }, []);

  if (view.kind === 'open') return <>{children}</>;
  if (view.kind === 'checking') return <div className="gz-sign-in" aria-busy="true" />;
  return (
    <div className="gz-sign-in">
      <div className="gz-sign-in-card">
        <p className="gz-sign-in-brand">Gezel</p>
        {view.kind === 'setup' ? (
          <SetupForm initialCode={view.code} codeAvailable={view.codeAvailable} />
        ) : (
          <SignInForm notice={view.notice} />
        )}
      </div>
    </div>
  );
}

function SetupForm({
  initialCode,
  codeAvailable,
}: { initialCode: string; codeAvailable: boolean }) {
  const ids = { code: useId(), name: useId(), password: useId(), again: useId() };
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const { busy, error, setError, run } = useSubmit();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== again) {
      setError('The two passwords do not match.');
      return;
    }
    void run(() => postJson('/v1/apps/signin/setup', { code, name, password }));
  };

  return (
    <form className="gz-sign-in-form" onSubmit={submit}>
      <h1>Create your account</h1>
      <p className="gz-sign-in-lede">
        This Gezel has no account yet. The first one you make can add others later.
      </p>
      {!initialCode && (
        <div className="gz-sign-in-field">
          <label htmlFor={ids.code}>Setup code</label>
          <input
            id={ids.code}
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
          />
          <p className="gz-sign-in-hint">
            {codeAvailable
              ? 'The setup link and its code are in the log. Run docker logs with the name of the container, then open the link it shows.'
              : 'Get a new setup link from the container with: docker exec <container> gezel account setup-link'}
          </p>
        </div>
      )}
      <div className="gz-sign-in-field">
        <label htmlFor={ids.name}>Your name</label>
        <input
          id={ids.name}
          type="text"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <p className="gz-sign-in-hint">You sign in with it, and others see it.</p>
      </div>
      <div className="gz-sign-in-field">
        <label htmlFor={ids.password}>Password</label>
        <input
          id={ids.password}
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <p className="gz-sign-in-hint">At least 8 characters.</p>
      </div>
      <div className="gz-sign-in-field">
        <label htmlFor={ids.again}>Password again</label>
        <input
          id={ids.again}
          type="password"
          autoComplete="new-password"
          value={again}
          onChange={(e) => setAgain(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="gz-sign-in-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? 'Creating…' : 'Create account'}
      </button>
    </form>
  );
}

function SignInForm({ notice }: { notice?: string }) {
  const ids = { name: useId(), password: useId() };
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useSubmit();

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => postJson('/v1/apps/signin', { name, password }));
  };

  return (
    <form className="gz-sign-in-form" onSubmit={submit}>
      <h1>Sign in</h1>
      {notice && <p className="gz-sign-in-notice">{notice}</p>}
      <div className="gz-sign-in-field">
        <label htmlFor={ids.name}>Name</label>
        <input
          id={ids.name}
          type="text"
          autoComplete="username"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </div>
      <div className="gz-sign-in-field">
        <label htmlFor={ids.password}>Password</label>
        <input
          id={ids.password}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </div>
      {error && (
        <p className="gz-sign-in-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="gz-sign-in-hint">
        Forgot your password? Someone who can sign in can set a new one in Settings, then Accounts.
        From the container: docker exec &lt;container&gt; gezel account reset-password &lt;name&gt;
      </p>
    </form>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (send: () => Promise<SignInResponse>) => {
    setBusy(true);
    setError(null);
    try {
      const result = await send();
      writeStoredToken(result.token);
      // The API client reads its credential once, at load: start it again
      // with the session, at the app's root rather than the setup link.
      window.location.replace(`${window.location.origin}/`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

async function postJson(path: string, body: unknown): Promise<SignInResponse> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<SignInResponse> & {
    message?: string;
  };
  if (!res.ok || !data.token) {
    throw new Error(
      res.status === 429
        ? 'Too many tries. Wait a moment and try again.'
        : (data.message ?? 'That did not work. Try again.'),
    );
  }
  return data as SignInResponse;
}

async function fetchState(): Promise<SignInState | null> {
  try {
    const res = await fetch('/v1/apps/signin/state');
    if (!res.ok) return null;
    return (await res.json()) as SignInState;
  } catch {
    return null;
  }
}

async function checkSession(token: string): Promise<boolean | null> {
  try {
    const res = await fetch('/api/accounts/me', { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) return false;
    return res.ok ? true : null;
  } catch {
    return null;
  }
}

function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function writeStoredToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage disabled: the session lasts for this page only */
  }
}
