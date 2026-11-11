import { ACCOUNT_PASSWORD_MIN_LENGTH, type Account, type AccountSession } from '@bendyline/gezel';
import { apiErrorMessage } from '@bendyline/gezel-client';
import { type ReactNode, useCallback, useEffect, useId, useState } from 'react';
import { api } from '../api.js';
import { Dialog, DropdownMenu } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { writeStoredToken } from '../sign-in/SignInGate.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { SettingsSection } from './SettingsSection.js';

/**
 * Settings → Accounts (ADR 0029): who can sign in to this Gezel from a
 * browser. Shown when the daemon requires accounts (a container) or has
 * some. Every account can do everything for now, and the panel says so
 * wherever people are added (docs/ux.md → "Signing in").
 *
 * Actions follow the app pattern: the section's key opens a dialog, each
 * person's row carries its own menu, and a removal asks first.
 */

type DialogKind = 'add' | 'set-password' | 'change-password' | 'remove';

/** `open` is kept apart from the target so a closing dialog keeps its title. */
interface DialogState {
  kind: DialogKind;
  account?: Account;
  open: boolean;
}

type SectionId = 'people' | 'me';

interface Message {
  section: SectionId;
  text: string;
  tone: 'notice' | 'error';
}

export function AccountsPanel() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [me, setMe] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.accounts.listAccounts();
      setAccounts(list.accounts);
      setMe(list.me ?? null);
      setSessions(list.me ? (await api.accounts.listMySessions()).sessions : []);
    } catch (err) {
      setAccounts((current) => current ?? []);
      setMessage({ section: 'people', text: apiErrorMessage(err), tone: 'error' });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openDialog = (kind: DialogKind, account?: Account) => {
    setMessage(null);
    setDialog({ kind, account, open: true });
  };
  const closeDialog = () => setDialog((current) => (current ? { ...current, open: false } : null));
  const isOpen = (kind: DialogKind) => dialog?.kind === kind && dialog.open;
  const target = dialog?.account;

  /** A row action that needs no dialog. The outcome is said in its section. */
  const act = async (section: SectionId, run: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await run();
      setMessage({ section, text: done, tone: 'notice' });
      await refresh();
    } catch (err) {
      setMessage({ section, text: apiErrorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** A dialog's save. A failure throws back into the dialog, which keeps what was typed. */
  const saved = async (section: SectionId, done: string) => {
    closeDialog();
    setMessage({ section, text: done, tone: 'notice' });
    await refresh();
  };

  const signOut = async () => {
    await api.accounts.signOut().catch(() => undefined);
    writeStoredToken(null);
    window.location.replace(`${window.location.origin}/`);
  };

  const messageFor = (section: SectionId) =>
    message?.section === section ? (
      <p
        className={message.tone === 'error' ? 'accounts-message error' : 'accounts-message'}
        role={message.tone === 'error' ? 'alert' : 'status'}
      >
        {message.text}
      </p>
    ) : null;

  return (
    <div className="accounts-panel">
      <SettingsSection
        id="accounts-people"
        title="People who can sign in"
        hint={
          <>
            Accounts let people use this Gezel from a web browser, such as when it runs in a
            container or on a server. Each person signs in with their own name and password; the
            desktop app and the command line on this computer don't need one. Everyone here can do
            everything you can, including open a terminal.
          </>
        }
        actions={
          <button type="button" onClick={() => openDialog('add')}>
            Add account
          </button>
        }
      >
        {messageFor('people')}
        {accounts === null ? (
          <p className="accounts-empty">Loading…</p>
        ) : accounts.length === 0 ? (
          <p className="accounts-empty">
            No one can sign in yet. Add an account for each person who should.
          </p>
        ) : (
          <ul className="accounts-list" aria-label="People who can sign in">
            {accounts.map((account) => (
              <AccountRow
                key={account.id}
                account={account}
                isMe={account.id === me?.id}
                busy={busy}
                onSetPassword={() => openDialog('set-password', account)}
                onToggleSignIn={() =>
                  void act(
                    'people',
                    () => api.accounts.updateAccount(account.id, { disabled: !account.disabledAt }),
                    account.disabledAt
                      ? `${account.name} can sign in again.`
                      : `${account.name} can no longer sign in, and any browser they were using is signed out.`,
                  )
                }
                onRemove={() => openDialog('remove', account)}
              />
            ))}
          </ul>
        )}
      </SettingsSection>

      {me && (
        <SettingsSection
          id="accounts-me"
          title="Your account"
          hint={
            <>
              You're signed in as <strong>{me.name}</strong>.
            </>
          }
          actions={
            <>
              <button
                type="button"
                className="secondary"
                onClick={() => openDialog('change-password')}
              >
                Change password
              </button>
              <button type="button" className="secondary" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          }
        >
          {messageFor('me')}
          {sessions.length > 0 && <SessionList sessions={sessions} busy={busy} onRevoke={act} />}
        </SettingsSection>
      )}

      <AddAccountDialog
        open={isOpen('add')}
        onClose={closeDialog}
        onSubmit={async (name, password) => {
          await api.accounts.createAccount(name, password);
          await saved('people', `Added ${name}. You'll need to share the password with them.`);
        }}
      />

      <PasswordDialog
        open={isOpen('set-password')}
        title={target ? `New password for ${target.name}` : 'New password'}
        description="They're signed out everywhere when it changes. Tell them the new one yourself."
        submitLabel="Set password"
        onClose={closeDialog}
        onSubmit={async (password) => {
          if (!target) return;
          await api.accounts.setAccountPassword(target.id, password);
          await saved('people', `${target.name} has a new password and is signed out everywhere.`);
        }}
      />

      <PasswordDialog
        open={isOpen('change-password')}
        title="Change your password"
        description="Your other browsers are signed out when it changes."
        submitLabel="Change password"
        askCurrent
        onClose={closeDialog}
        onSubmit={async (password, currentPassword) => {
          await api.accounts.changeMyPassword(password, currentPassword ?? '');
          await saved('me', 'Your password is changed. Your other browsers are signed out.');
        }}
      />

      <ConfirmDialog
        open={isOpen('remove')}
        title={target ? `Remove ${target.name}?` : 'Remove this account?'}
        message="They can no longer sign in, and any browser they're using is signed out. This can't be undone."
        confirmLabel="Remove"
        danger
        onCancel={closeDialog}
        onConfirm={async () => {
          if (!target) return;
          try {
            await api.accounts.removeAccount(target.id);
            await saved('people', `Removed ${target.name}.`);
          } catch (err) {
            closeDialog();
            setMessage({ section: 'people', text: apiErrorMessage(err), tone: 'error' });
          }
        }}
      />
    </div>
  );
}

function AccountRow({
  account,
  isMe,
  busy,
  onSetPassword,
  onToggleSignIn,
  onRemove,
}: {
  account: Account;
  isMe: boolean;
  busy: boolean;
  onSetPassword: () => void;
  onToggleSignIn: () => void;
  onRemove: () => void;
}) {
  const detail = [
    account.disabledAt ? 'Sign-in turned off' : null,
    account.lastSignInAt
      ? `Last signed in ${formatRelativeTime(account.lastSignInAt, { style: 'long' })}`
      : "Hasn't signed in yet",
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <li className={account.disabledAt ? 'accounts-row accounts-row-off' : 'accounts-row'}>
      <div className="accounts-row-meta">
        <span className="accounts-row-name">
          {account.name}
          {isMe && <span className="accounts-row-tag">You</span>}
        </span>
        <span
          className="accounts-row-detail"
          title={account.lastSignInAt ? formatAbsoluteTime(account.lastSignInAt) : undefined}
        >
          {detail}
        </span>
      </div>
      {!isMe && (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className="accounts-row-menu"
              aria-label={`Actions for ${account.name}`}
              title="Account actions"
              disabled={busy}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                <circle cx="12" cy="5" r="1.6" />
                <circle cx="12" cy="12" r="1.6" />
                <circle cx="12" cy="19" r="1.6" />
              </svg>
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="app-nav-menu" sideOffset={4} align="end">
              <DropdownMenu.Item className="app-nav-menu-item" onSelect={onSetPassword}>
                Set a new password…
              </DropdownMenu.Item>
              <DropdownMenu.Item className="app-nav-menu-item" onSelect={onToggleSignIn}>
                {account.disabledAt ? 'Let them sign in again' : 'Stop them signing in'}
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="app-nav-menu-separator" />
              <DropdownMenu.Item className="app-nav-menu-item danger" onSelect={onRemove}>
                Remove…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </li>
  );
}

function SessionList({
  sessions,
  busy,
  onRevoke,
}: {
  sessions: AccountSession[];
  busy: boolean;
  onRevoke: (section: SectionId, run: () => Promise<unknown>, done: string) => Promise<void>;
}) {
  const labelId = useId();
  return (
    <div className="gz-setting accounts-sessions">
      <p id={labelId} className="gz-setting-label">
        Where you're signed in
      </p>
      <ul className="accounts-list" aria-labelledby={labelId}>
        {sessions.map((session) => {
          const label = session.label ?? 'A browser';
          return (
            <li key={session.id} className="accounts-row">
              <div className="accounts-row-meta">
                <span className="accounts-row-name">
                  {label}
                  {session.current && <span className="accounts-row-tag">This browser</span>}
                </span>
                <span
                  className="accounts-row-detail"
                  title={formatAbsoluteTime(session.lastSeenAt)}
                >
                  {[
                    session.address,
                    `Last used ${formatRelativeTime(session.lastSeenAt, { style: 'long' })}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {!session.current && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void onRevoke(
                      'me',
                      () => api.accounts.revokeMySession(session.id),
                      `Signed out ${label === 'A browser' ? 'that browser' : label}.`,
                    )
                  }
                >
                  Sign out
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="gz-setting-hint">Sign out a browser you no longer use.</p>
    </div>
  );
}

/**
 * The one dialog shape on this page (docs/handboek/technical/gezel-app-ux-guide.md
 * B4): the title is the action, fields in one column, Cancel before the
 * verb. A failed save keeps the dialog open with what was typed.
 */
function AccountFormDialog({
  open,
  title,
  description,
  submitLabel,
  canSubmit,
  onClose,
  onSubmit,
  children,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  submitLabel: string;
  canSubmit: boolean;
  onClose: () => void;
  onSubmit: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    if (busy || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="accounts-dialog">
          <form
            className="accounts-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <Dialog.Title asChild>
              <h3>{title}</h3>
            </Dialog.Title>
            <Dialog.Description className="accounts-dialog-description">
              {description}
            </Dialog.Description>
            {children}
            {error && (
              <p className="gz-dialog-error" role="alert">
                {error}
              </p>
            )}
            <Dialog.Actions>
              <button type="button" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={busy || !canSubmit}>
                {busy ? 'Working…' : submitLabel}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function AddAccountDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, password: string) => Promise<void>;
}) {
  const nameId = useId();
  const passwordId = useId();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
      setPassword('');
      setShowPassword(false);
    }
  }, [open]);

  return (
    <AccountFormDialog
      open={open}
      title="Add an account"
      description="They can do everything you can, including open a terminal. Add only people you trust."
      submitLabel="Add account"
      canSubmit={name.trim().length > 0 && password.length >= ACCOUNT_PASSWORD_MIN_LENGTH}
      onClose={onClose}
      onSubmit={() => onSubmit(name.trim(), password)}
    >
      <DialogField id={nameId} label="Name" hint="What they type to sign in.">
        <input
          id={nameId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-describedby={`${nameId}-hint`}
          required
        />
      </DialogField>
      <DialogField
        id={passwordId}
        label="Password"
        hint={`At least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters. You'll need to share the password with the users.`}
      >
        <input
          id={passwordId}
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          minLength={ACCOUNT_PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={`${passwordId}-hint`}
          required
        />
      </DialogField>
      <ShowPasswordCheck checked={showPassword} onChange={setShowPassword} />
    </AccountFormDialog>
  );
}

function PasswordDialog({
  open,
  title,
  description,
  submitLabel,
  askCurrent = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description: string;
  submitLabel: string;
  askCurrent?: boolean;
  onClose: () => void;
  onSubmit: (password: string, currentPassword?: string) => Promise<void>;
}) {
  const currentId = useId();
  const newId = useId();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    if (open) {
      setCurrent('');
      setPassword('');
      setShowPassword(false);
    }
  }, [open]);

  return (
    <AccountFormDialog
      open={open}
      title={title}
      description={description}
      submitLabel={submitLabel}
      canSubmit={
        password.length >= ACCOUNT_PASSWORD_MIN_LENGTH && (!askCurrent || current.length > 0)
      }
      onClose={onClose}
      onSubmit={() => onSubmit(password, askCurrent ? current : undefined)}
    >
      {askCurrent && (
        <DialogField id={currentId} label="Current password">
          <input
            id={currentId}
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </DialogField>
      )}
      <DialogField
        id={newId}
        label="New password"
        hint={`At least ${ACCOUNT_PASSWORD_MIN_LENGTH} characters.`}
      >
        <input
          id={newId}
          type={showPassword ? 'text' : 'password'}
          autoComplete="new-password"
          minLength={ACCOUNT_PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-describedby={`${newId}-hint`}
          required
        />
      </DialogField>
      <ShowPasswordCheck checked={showPassword} onChange={setShowPassword} />
    </AccountFormDialog>
  );
}

function DialogField({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="accounts-dialog-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && (
        <p id={`${id}-hint`} className="accounts-dialog-hint">
          {hint}
        </p>
      )}
    </div>
  );
}

function ShowPasswordCheck({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="accounts-dialog-check">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Show password
    </label>
  );
}
