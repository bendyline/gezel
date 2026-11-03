import type { Account, AccountSession } from '@bendyline/gezel';
import { apiErrorMessage } from '@bendyline/gezel-client';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { writeStoredToken } from '../sign-in/SignInGate.js';
import { SettingField, SettingsSection } from './SettingsSection.js';

/**
 * Settings → Accounts (ADR 0029): who can sign in to this Gezel from a
 * browser. Shown when the daemon requires accounts (a container) or has
 * some. Every account can do everything for now, and the panel says so
 * wherever people are added.
 */
export function AccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [me, setMe] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.accounts.listAccounts();
      setAccounts(list.accounts);
      setMe(list.me ?? null);
      setSessions(list.me ? (await api.accounts.listMySessions()).sessions : []);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await run();
        await refresh();
        return true;
      } catch (err) {
        setError(apiErrorMessage(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const signOut = async () => {
    await api.accounts.signOut().catch(() => undefined);
    writeStoredToken(null);
    window.location.replace(`${window.location.origin}/`);
  };

  return (
    <div className="accounts-panel">
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}

      {me && (
        <SettingsSection
          id="accounts-me"
          title="Your account"
          hint={`You are signed in as ${me.name}.`}
          actions={
            <button type="button" className="secondary" onClick={() => void signOut()}>
              Sign out
            </button>
          }
        >
          <PasswordForm
            label="Change your password"
            askCurrent
            busy={busy}
            onSubmit={(password, currentPassword) =>
              act(() => api.accounts.changeMyPassword(password, currentPassword ?? ''))
            }
          />
        </SettingsSection>
      )}

      <SettingsSection
        id="accounts-people"
        title="People who can sign in"
        hint="Everyone here can do everything you can, including open a terminal."
      >
        <ul className="settings-list">
          {accounts.map((account) => (
            <li key={account.id} className="connected-app-row">
              <div className="connected-app-meta">
                <div className="connected-app-name">
                  {account.name}
                  {account.id === me?.id && <span className="accounts-status">(you)</span>}
                  {account.disabledAt && <span className="accounts-status">(cannot sign in)</span>}
                </div>
                <div className="muted small">
                  {account.lastSignInAt
                    ? `Last signed in ${new Date(account.lastSignInAt).toLocaleDateString()}`
                    : 'Has not signed in yet'}
                </div>
                {resetting === account.id && (
                  <PasswordForm
                    label={`New password for ${account.name}`}
                    busy={busy}
                    onCancel={() => setResetting(null)}
                    onSubmit={async (password) => {
                      const ok = await act(() =>
                        api.accounts.setAccountPassword(account.id, password),
                      );
                      if (ok) setResetting(null);
                      return ok;
                    }}
                  />
                )}
              </div>
              {account.id !== me?.id && (
                <div className="connected-app-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => setResetting(account.id)}
                  >
                    Set password
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void act(() =>
                        api.accounts.updateAccount(account.id, { disabled: !account.disabledAt }),
                      )
                    }
                  >
                    {account.disabledAt ? 'Let them sign in' : 'Stop them signing in'}
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${account.name}? This cannot be undone.`)) {
                        void act(() => api.accounts.removeAccount(account.id));
                      }
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        <AddPersonForm
          busy={busy}
          onAdd={(name, password) => act(() => api.accounts.createAccount(name, password))}
        />
      </SettingsSection>

      {me && sessions.length > 0 && (
        <SettingsSection
          id="accounts-sessions"
          title="Where you are signed in"
          hint="Sign out a browser you no longer use."
        >
          <ul className="settings-list">
            {sessions.map((session) => (
              <li key={session.id} className="connected-app-row">
                <div className="connected-app-meta">
                  <div className="connected-app-name">
                    {session.label ?? 'A browser'}
                    {session.current && <span className="accounts-status">(this browser)</span>}
                  </div>
                  <div className="muted small">
                    {[session.address, `last used ${new Date(session.lastSeenAt).toLocaleString()}`]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                {!session.current && (
                  <div className="connected-app-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => void act(() => api.accounts.revokeMySession(session.id))}
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}
    </div>
  );
}

function AddPersonForm({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (name: string, password: string) => Promise<boolean>;
}) {
  const nameId = useId();
  const passwordId = useId();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(name, password)) {
      setName('');
      setPassword('');
    }
  };
  return (
    <form className="accounts-add" onSubmit={(event) => void submit(event)}>
      <SettingField label="Name" controlId={nameId}>
        <input
          id={nameId}
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
      </SettingField>
      <SettingField
        label="Password"
        controlId={passwordId}
        hint="At least 8 characters. Tell them yourself; Gezel sends no email."
      >
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </SettingField>
      <button type="submit" disabled={busy}>
        Add person
      </button>
    </form>
  );
}

function PasswordForm({
  label,
  askCurrent,
  busy,
  onSubmit,
  onCancel,
}: {
  label: string;
  askCurrent?: boolean;
  busy: boolean;
  onSubmit: (password: string, currentPassword?: string) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const currentId = useId();
  const newId = useId();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    if (await onSubmit(password, askCurrent ? current : undefined)) {
      setCurrent('');
      setPassword('');
      setDone(true);
    }
  };
  return (
    <form className="accounts-password" onSubmit={(event) => void submit(event)}>
      {askCurrent && (
        <SettingField label="Current password" controlId={currentId}>
          <input
            id={currentId}
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </SettingField>
      )}
      <SettingField
        label={label}
        controlId={newId}
        hint={
          askCurrent
            ? 'Your other browsers are signed out when it changes.'
            : 'They are signed out everywhere when it changes.'
        }
      >
        <input
          id={newId}
          type="password"
          autoComplete="new-password"
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </SettingField>
      <div className="accounts-form-actions">
        <button type="submit" disabled={busy}>
          Change password
        </button>
        {onCancel && (
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
        {done && <output className="muted small">Changed.</output>}
      </div>
    </form>
  );
}
