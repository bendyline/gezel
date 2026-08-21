import type { ProjectDetail } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import {
  MAIL_PROVIDERS,
  type MailProviderId,
  connectMailboxOAuth,
  linkImapMailbox,
  looksLikeEmail,
} from './mail-link.js';

type ConnStatus = Awaited<ReturnType<typeof api.listConnectors>>;
type MailBinding = ConnStatus['bindings'][number];

const isMailBinding = (b: MailBinding): boolean => b.type.startsWith('mail-');

/**
 * Project Mail tab — a mail-flavored setup surface over the generic connector
 * APIs. Mail accounts are `mail-*` connector bindings; this tab shows the
 * linked ones + last-sync state, a "Sync now" button, and a connect form
 * (IMAP inline, or the loopback OAuth flow for Gmail / Microsoft).
 */
export function ProjectMailTab({
  project,
  onProjectChange,
}: {
  project: ProjectDetail;
  onProjectChange?: (p: ProjectDetail) => void;
}) {
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const [showLink, setShowLink] = useState(false);
  const [provider, setProvider] = useState<MailProviderId>('imap');
  const [address, setAddress] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [pass, setPass] = useState('');
  const [secure, setSecure] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.listConnectors(project.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const resetForm = useCallback(() => {
    setProvider('imap');
    setAddress('');
    setHost('');
    setPort('');
    setPass('');
    setSecure(true);
  }, []);

  const handleSync = useCallback(async () => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const mailBindings = (status?.bindings ?? []).filter(isMailBinding);
      const results: { written?: number; quarantined?: number }[] = await Promise.all(
        mailBindings.map((b) =>
          api
            .syncConnector(project.id, b.id)
            .then((r) => r.result as { written?: number; quarantined?: number })
            .catch(() => ({}) as { written?: number; quarantined?: number }),
        ),
      );
      const n = results.reduce((sum, r) => sum + (r.written ?? 0) + (r.quarantined ?? 0), 0);
      setNotice(n > 0 ? `Synced ${n} new message(s).` : 'Synced — no new mail.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [project.id, status, refresh]);

  const handleLink = useCallback(async () => {
    setError('');
    setNotice('');
    const addr = address.trim();
    if (!looksLikeEmail(addr)) {
      setError('Enter a valid email address.');
      return;
    }
    if (provider === 'imap' && (!host.trim() || !pass)) {
      setError('IMAP needs a host and a password.');
      return;
    }
    setBusy(true);
    try {
      if (provider === 'imap') {
        await linkImapMailbox(project.id, {
          address: addr,
          host: host.trim(),
          ...(port.trim() ? { port: Number(port.trim()) } : {}),
          secure,
          pass,
        });
      } else {
        await connectMailboxOAuth(project.id, provider, addr);
      }
      setNotice('Mailbox linked.');
      setShowLink(false);
      resetForm();
      await refresh();
      try {
        const fresh = await api.getProject(project.id);
        if (fresh) onProjectChange?.(fresh);
      } catch {
        /* status already refreshed; project refetch is best-effort */
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    project.id,
    provider,
    address,
    host,
    port,
    pass,
    secure,
    refresh,
    onProjectChange,
    resetForm,
  ]);

  const accounts = (status?.bindings ?? []).filter(isMailBinding);

  return (
    <div className="gz-mail-tab">
      <div className="gz-mail-header">
        <h3>Mail</h3>
        {accounts.length > 0 && (
          <button type="button" onClick={() => void handleSync()} disabled={busy}>
            {busy ? 'Working…' : 'Sync now'}
          </button>
        )}
      </div>

      {accounts.length === 0 ? (
        <p className="muted">
          No mailbox linked yet. Connect one to start syncing mail into this project as searchable
          files.
        </p>
      ) : (
        <ul className="gz-mail-accounts">
          {accounts.map((a) => (
            <li key={a.id} className="gz-mail-account">
              <div>
                <strong>{a.displayName ?? a.id}</strong>
                <span className="muted small"> · {a.type.replace(/^mail-/, '')}</span>
              </div>
              <div className="small">
                {a.lastError ? (
                  <span className="error">Error: {a.lastError}</span>
                ) : a.lastSyncedAt ? (
                  <span className="muted" title={formatAbsoluteTime(a.lastSyncedAt)}>
                    Last synced {formatRelativeTime(a.lastSyncedAt)}
                  </span>
                ) : (
                  <span className="muted">Not synced yet</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!showLink ? (
        <button
          type="button"
          className="gz-mail-connect"
          onClick={() => {
            setShowLink(true);
            setError('');
            setNotice('');
          }}
        >
          Connect a mailbox
        </button>
      ) : (
        <div className="gz-mail-link-form">
          <div className="gz-type-field">
            <span className="gz-type-field-label">Provider</span>
            <div className="gz-type-picker" role="radiogroup" aria-label="Mail provider">
              {MAIL_PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: chip in a role="radiogroup"; a native radio input would break the chip styling and rich content.
                  role="radio"
                  aria-checked={p.id === provider}
                  className={`gz-type-chip${p.id === provider ? ' active' : ''}`}
                  onClick={() => setProvider(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label>
            Email address
            <input
              type="email"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
            />
          </label>
          {provider === 'imap' ? (
            <>
              <label>
                IMAP host
                <input
                  value={host}
                  onChange={(e) => setHost(e.target.value)}
                  placeholder="imap.example.com"
                />
              </label>
              <div className="gz-imap-row">
                <label className="gz-imap-port">
                  Port <span className="muted">(optional)</span>
                  <input
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="993"
                    inputMode="numeric"
                  />
                </label>
                <label className="gz-imap-tls">
                  <input
                    type="checkbox"
                    checked={secure}
                    onChange={(e) => setSecure(e.target.checked)}
                  />
                  Use TLS
                </label>
              </div>
              <label>
                Password / app password
                <input
                  type="password"
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </>
          ) : (
            <p className="muted small">
              You'll authorize {MAIL_PROVIDERS.find((p) => p.id === provider)?.label} in your
              browser — a window opens when you click Connect.
            </p>
          )}
          <div className="gz-mail-link-actions">
            <button
              type="button"
              onClick={() => {
                setShowLink(false);
                resetForm();
                setError('');
              }}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void handleLink()}
              disabled={busy}
            >
              {busy ? 'Connecting…' : provider === 'imap' ? 'Link' : 'Connect'}
            </button>
          </div>
        </div>
      )}

      {error && <p className="error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}
    </div>
  );
}
