import type { GithubIdentity } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { GithubDeviceCodeModal } from './GithubDeviceCodeModal.js';

/**
 * Inline pill rendered next to anything that needs a GitHub identity
 * (today: the GitHub URL row in the New Project dialog; soon: Settings,
 * the per-project GitHub tab, etc.). Three states:
 *
 *   - **Loading** while we hit `/api/system/github-identity`. A short
 *     placeholder so the row doesn't reflow when the answer arrives.
 *   - **Signed out** → shows `Sign in` as a button. Clicking opens the
 *     device-code modal; on success the chip flips to signed-in.
 *   - **Signed in** → shows `@login` (with avatar if we have one). Click
 *     reveals a small "Sign out" affordance.
 *
 * Parents that care about the identity for their own logic (the New
 * Project dialog uses it to gate auto-fill) pass `onChange` and read
 * the latest identity from there.
 */
export function GithubSignInChip({
  onChange,
  compact = false,
}: {
  onChange?: (identity: GithubIdentity | null) => void;
  /** Smaller chip variant for tight rows. */
  compact?: boolean;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'signed-out' }
    | { kind: 'signed-in'; identity: GithubIdentity }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [showSignIn, setShowSignIn] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.getGithubIdentity();
      if (res.signedIn) {
        const identity: GithubIdentity = {
          login: res.login,
          ...(res.name ? { name: res.name } : {}),
          ...(res.avatarUrl ? { avatarUrl: res.avatarUrl } : {}),
        };
        setState({ kind: 'signed-in', identity });
        onChange?.(identity);
      } else {
        setState({ kind: 'signed-out' });
        onChange?.(null);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
      onChange?.(null);
    }
  }, [onChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSignedIn = useCallback(
    (identity: GithubIdentity) => {
      setState({ kind: 'signed-in', identity });
      onChange?.(identity);
      setShowSignIn(false);
    },
    [onChange],
  );

  const signOut = useCallback(async () => {
    setShowMenu(false);
    try {
      await api.githubLogout();
    } finally {
      setState({ kind: 'signed-out' });
      onChange?.(null);
    }
  }, [onChange]);

  const className = `gz-github-chip${compact ? ' compact' : ''}`;

  if (state.kind === 'loading') {
    return <span className={`${className} muted`}>…</span>;
  }
  if (state.kind === 'error') {
    return (
      <button
        type="button"
        className={`${className} signed-out`}
        title={state.message}
        onClick={() => void refresh()}
      >
        retry
      </button>
    );
  }
  if (state.kind === 'signed-out') {
    return (
      <>
        <button
          type="button"
          className={`${className} signed-out`}
          onClick={() => setShowSignIn(true)}
          title="Sign in to GitHub"
        >
          Sign in
        </button>
        {showSignIn && (
          <GithubDeviceCodeModal onClose={() => setShowSignIn(false)} onSignedIn={handleSignedIn} />
        )}
      </>
    );
  }
  // signed in
  const { identity } = state;
  return (
    <span className={`${className} signed-in`}>
      <button
        type="button"
        className="gz-github-chip-id"
        onClick={() => setShowMenu((v) => !v)}
        title={identity.name ?? identity.login}
      >
        {identity.avatarUrl ? (
          <img src={identity.avatarUrl} alt="" className="gz-github-chip-avatar" />
        ) : null}
        <span>@{identity.login}</span>
      </button>
      {showMenu && (
        <span className="gz-github-chip-menu" role="menu">
          <button type="button" onClick={() => void signOut()}>
            Sign out
          </button>
        </span>
      )}
    </span>
  );
}
