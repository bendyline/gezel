import { useCallback, useEffect, useState } from 'react';
import { AlertDialog } from '../primitives/index.js';

export const SHOW_MAC_UNINSTALL_EVENT = 'gezel:show-mac-uninstall';

export function requestMacUninstall(): void {
  window.dispatchEvent(new Event(SHOW_MAC_UNINSTALL_EVENT));
}

export function MacUninstallDialog() {
  const uninstall = window.__GEZEL__?.uninstall;
  const supported = window.__GEZEL__?.platform === 'darwin' && Boolean(uninstall);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removeMachineData, setRemoveMachineData] = useState(false);
  const [removeSharedData, setRemoveSharedData] = useState(false);
  const [removeCurrentUserData, setRemoveCurrentUserData] = useState(false);

  const show = useCallback(() => {
    if (!supported) return;
    setRemoveMachineData(false);
    setRemoveSharedData(false);
    setRemoveCurrentUserData(false);
    setError(null);
    setOpen(true);
  }, [supported]);

  useEffect(() => {
    window.addEventListener(SHOW_MAC_UNINSTALL_EVENT, show);
    const removeNativeListener = uninstall?.onShowRequested(show);
    return () => {
      window.removeEventListener(SHOW_MAC_UNINSTALL_EVENT, show);
      removeNativeListener?.();
    };
  }, [show, uninstall]);

  if (!supported || !uninstall) return null;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await uninstall.start({
      removeMachineData,
      removeSharedData,
      removeCurrentUserData,
    });
    if (result.ok) return;
    setBusy(false);
    if (result.canceled) {
      setOpen(false);
    } else {
      setError(result.error);
    }
  };

  const deletesUserWork = removeSharedData || removeCurrentUserData;
  const deletesSelectedData = removeMachineData || deletesUserWork;

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) setOpen(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay />
        <AlertDialog.Content className="gz-dialog-wide gz-uninstall-dialog">
          <AlertDialog.Title asChild>
            <h3>Uninstall Gezel?</h3>
          </AlertDialog.Title>
          <AlertDialog.Description className="muted small">
            Gezel will remove the application, its machine-wide background service, every user’s
            Gezel startup item, and its macOS installer receipt. Choose whether its data should stay
            for a later reinstall.
          </AlertDialog.Description>

          <fieldset className="gz-uninstall-choices" disabled={busy}>
            <legend>Also remove</legend>
            <label>
              <input
                type="checkbox"
                checked={removeMachineData}
                onChange={(event) => setRemoveMachineData(event.target.checked)}
              />
              <span>
                <strong>Downloaded models and machine-engine data</strong>
                <small>
                  Deletes shared model downloads, engine caches, logs, and service state from{' '}
                  <code>/Library/Application Support/Gezel</code>.
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={removeSharedData}
                onChange={(event) => setRemoveSharedData(event.target.checked)}
              />
              <span>
                <strong>Machine-shared projects and gezels</strong>
                <small>
                  Permanently deletes the shared crew and project definitions in{' '}
                  <code>/Users/Shared/Gezel</code> for everyone on this Mac.
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={removeCurrentUserData}
                onChange={(event) => setRemoveCurrentUserData(event.target.checked)}
              />
              <span>
                <strong>My projects, chats, credentials, and settings</strong>
                <small>
                  Permanently deletes this account’s <code>~/.gezel</code> data and desktop
                  preferences, and asks macOS Keychain to delete its Gezel credentials. Other users’
                  private data stays untouched.
                </small>
              </span>
            </label>
          </fieldset>

          {!removeMachineData && !deletesUserWork && (
            <p className="gz-uninstall-preserve muted small">
              Your downloaded models, projects, gezels, chats, credentials, and settings will be
              ready if you reinstall Gezel later.
            </p>
          )}
          {deletesUserWork && (
            <p className="gz-uninstall-warning small" role="alert">
              Selected projects, chats, or credentials cannot be recovered after uninstalling.
            </p>
          )}
          <p className="muted small gz-uninstall-auth-note">
            macOS will ask for an administrator password. Gezel will quit when the uninstaller is
            ready.
          </p>
          {error && (
            <p className="gz-dialog-error" role="alert">
              {error}
            </p>
          )}

          <AlertDialog.Actions>
            <AlertDialog.Cancel asChild>
              <button type="button" className="secondary" disabled={busy}>
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={(event) => {
                  event.preventDefault();
                  void start();
                }}
              >
                {busy
                  ? 'Preparing uninstaller…'
                  : deletesSelectedData
                    ? 'Uninstall and delete selected data'
                    : 'Uninstall Gezel'}
              </button>
            </AlertDialog.Action>
          </AlertDialog.Actions>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
