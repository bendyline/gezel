import type { ProjectDetail } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { setVisibleInterval } from '../visible-interval.js';
import { AddConnectionDialog, type AddedConnection } from './AddConnectionDialog.js';
import { RemoveConnectionDialog } from './RemoveConnectionDialog.js';
import { WebsiteBindingRow } from './WebsiteBindingRow.js';
import { CameraBindingCard } from './cameras/CameraBindingCard.js';
import { connectorItemCount, connectorItemNoun, connectorWaitingLine } from './connector-items.js';

type ConnStatus = Awaited<ReturnType<typeof api.listConnectors>>;
type ConnBinding = ConnStatus['bindings'][number];

/**
 * One line per data table under a binding.
 *
 * Deliberately plain sentences rather than a stat grid. Someone reading this
 * wants to know their data arrived and is current — "4.3 million rows,
 * 6 Jul → 4 Aug" answers that; a dashboard of counters does not. The
 * compaction note only appears while there is something pending, so a healthy
 * corpus says nothing about internals the user never has to think about.
 */
function TableStats({ tables }: { tables: NonNullable<ConnBinding['tables']> }) {
  return (
    <ul className="gz-connector-tables">
      {tables.map((t) => {
        const span =
          t.earliestPartition && t.latestPartition
            ? t.earliestPartition === t.latestPartition
              ? t.earliestPartition
              : `${t.earliestPartition} → ${t.latestPartition}`
            : null;
        return (
          <li key={t.table} className="small muted">
            <strong>{t.table}</strong> · {t.rows.toLocaleString()} {t.rows === 1 ? 'row' : 'rows'}
            {span ? ` · ${span}` : ''}
            {t.retentionDays ? ` · keeps ${t.retentionDays} days` : ''}
            {t.schemaInferred ? ' · schema inferred' : ''}
            {t.pendingParts > 0 ? ' · tidying up tonight' : ''}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Project Connections tab — manage bound connectors (per-binding status,
 * sync, check, pause, unbind) and add new ones through AddConnectionDialog,
 * which is data-driven off the connector-type catalog, so new driver types
 * appear automatically.
 */
export function ProjectConnectionsTab({
  project,
  onProjectChange,
  onOpenFolder,
}: {
  project: ProjectDetail;
  onProjectChange?: (p: ProjectDetail) => void;
  /** Show a connection's folder (artifact-relative) in the project's Artifacts tab. */
  onOpenFolder?: (path: string) => void;
}) {
  const [status, setStatus] = useState<ConnStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmUnbind, setConfirmUnbind] = useState<string | null>(null);
  const [pending, setPending] = useState<
    Awaited<ReturnType<typeof api.listConnectorActions>>['pending']
  >([]);

  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        api.listConnectors(project.id),
        api.listConnectorActions(project.id),
      ]);
      setStatus(s);
      setPending(a.pending);
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [project.id]);

  // While a connection syncs its count climbs: read the status every second.
  const syncingNow = (status?.bindings ?? []).some((b) => b.syncing || b.id === busy);
  useEffect(() => {
    if (!syncingNow) return;
    let live = true;
    const stop = setVisibleInterval(() => {
      api
        .listConnectors(project.id)
        .then((next) => {
          if (live) setStatus(next);
        })
        .catch(() => {});
    }, 1000);
    return () => {
      live = false;
      stop();
    };
  }, [syncingNow, project.id]);

  const handleCommit = useCallback(
    async (draftId: string) => {
      setBusy(draftId);
      setError('');
      setNotice('');
      try {
        const r = await api.commitConnectorAction(project.id, draftId);
        setNotice(r.status === 'committed' ? 'Action committed.' : 'Held in the outbox.');
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleDiscardAction = useCallback(
    async (draftId: string) => {
      setBusy(draftId);
      try {
        await api.discardConnectorAction(project.id, draftId);
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const openAdd = useCallback(() => {
    setError('');
    setNotice('');
    setAdding(true);
  }, []);

  const handleSync = useCallback(
    async (bindingId: string, type: string) => {
      setBusy(bindingId);
      setError('');
      setNotice('');
      try {
        const res = await api.syncConnector(project.id, bindingId);
        const r = res.result as { written?: number; quarantined?: number; error?: string };
        const added = (r.written ?? 0) + (r.quarantined ?? 0);
        setNotice(
          r.error
            ? `Sync error: ${r.error}`
            : added === 0
              ? 'Synced. Nothing new.'
              : `Synced ${added.toLocaleString()} new or changed ${connectorItemNoun(type, added)}.`,
        );
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleCheck = useCallback(
    async (bindingId: string) => {
      setBusy(bindingId);
      setError('');
      try {
        const { check } = await api.checkConnector(project.id, bindingId);
        const problem =
          check.error ??
          check.failedScopes?.map((f) => `${f.scope}: ${f.message}`).join('; ') ??
          (check.rateLimited ? 'the service asked to wait before more requests' : '');
        setNotice(
          check.ok && !problem
            ? `The connection works: a trial read found ${check.records} item(s). Nothing was saved.`
            : `The check found a problem: ${problem}`,
        );
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id],
  );

  const handlePause = useCallback(
    async (bindingId: string, pause: boolean) => {
      setBusy(bindingId);
      setError('');
      try {
        await api.patchConnector(project.id, bindingId, { disabled: pause });
        setNotice(
          pause
            ? 'Paused. It will not sync until you resume it.'
            : 'Resumed. It syncs again on its usual schedule.',
        );
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
      }
    },
    [project.id, refresh],
  );

  const handleUnbind = useCallback(
    async (bindingId: string, deleteData = false) => {
      setBusy(bindingId);
      setError('');
      setNotice('');
      try {
        const result = await api.unbindConnector(project.id, bindingId, { deleteData });
        if (deleteData) {
          const files = (result && 'deleted' in result ? result.deleted?.files : 0) ?? 0;
          setNotice(
            `Removed, and deleted ${files.toLocaleString()} downloaded ${files === 1 ? 'file' : 'files'}.`,
          );
        }
        await refresh();
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
        setConfirmUnbind(null);
      }
    },
    [project.id, refresh],
  );

  const handleAdded = useCallback(
    async ({ bindingId, type, device }: AddedConnection) => {
      setAdding(false);
      setError('');
      setNotice(device ? 'Camera added. It starts watching in a moment.' : 'Connector added.');
      await refresh();
      if (device) return;
      try {
        const fresh = await api.getProject(project.id);
        if (fresh) onProjectChange?.(fresh);
      } catch {
        /* best-effort project refetch */
      }
      // The background loop only syncs under the most permissive posture, so a
      // freshly added connector would otherwise sit empty until someone found
      // the Sync button. A first sync is what the person just asked for.
      if (bindingId) await handleSync(bindingId, type);
    },
    [project.id, refresh, onProjectChange, handleSync],
  );

  const bindings = status?.bindings ?? [];
  const offline = bindings.some((b) => b.unreachable?.offline && !b.disabled);

  return (
    <div className="settings-section">
      <div className="gz-mail-header">
        <h3>Connections</h3>
        <button type="button" onClick={openAdd}>
          Add connection
        </button>
      </div>

      {bindings.length === 0 ? (
        <p className="muted">
          No connectors yet. Add one to mirror an external source (email, issues, a data source)
          into this project as searchable files.
        </p>
      ) : (
        <>
          {offline ? (
            <p className="muted small" aria-live="polite">
              This computer is offline. Everything already downloaded is here, and connections catch
              up on their own when you're back online.
            </p>
          ) : null}
          <ul className="settings-list">
            {bindings.map((b) =>
              b.type === 'website' ? (
                <WebsiteBindingRow
                  key={b.id}
                  projectId={project.id}
                  binding={b}
                  onChanged={() => void refresh()}
                  onRemove={(id) => setConfirmUnbind(id)}
                  onNotice={(text, isError) => {
                    if (isError) {
                      setError(text);
                      setNotice('');
                    } else {
                      setNotice(text);
                      setError('');
                    }
                  }}
                />
              ) : b.driver === 'device' ? (
                <li key={b.id} className="camera-card-item">
                  <CameraBindingCard
                    projectId={project.id}
                    binding={b}
                    onChanged={() => void refresh()}
                    onRemove={(id) => setConfirmUnbind(id)}
                  />
                </li>
              ) : (
                <li key={b.id} className="connected-app-row">
                  <div>
                    <strong>{b.displayName || b.type}</strong>
                    <span className="muted small"> · {b.type}</span>
                    {b.account ? <div className="small muted">Signed in as {b.account}</div> : null}
                    <div className="small">
                      {b.items !== undefined && !b.syncing && busy !== b.id ? (
                        <span className="muted">{connectorItemCount(b.type, b.items)} · </span>
                      ) : null}
                      {b.syncing || busy === b.id ? (
                        <span className="muted" aria-live="polite">
                          Syncing…
                          {b.items !== undefined
                            ? ` ${connectorItemCount(b.type, b.items)} so far`
                            : ''}
                        </span>
                      ) : b.disabled ? (
                        <span className="muted">
                          {b.disabledReason === 'emergency-stop'
                            ? 'Stopped by the emergency stop. Resume it when you are ready.'
                            : 'Paused. It does not sync until you resume it.'}
                        </span>
                      ) : b.unreachable ? (
                        <span
                          className="muted"
                          title={
                            b.lastSyncedAt
                              ? `Last synced ${formatAbsoluteTime(b.lastSyncedAt)}`
                              : undefined
                          }
                        >
                          {connectorWaitingLine(b.unreachable)}
                        </span>
                      ) : b.lastError ? (
                        <span className="error">Error: {b.lastError}</span>
                      ) : b.lastSyncedAt ? (
                        <span className="muted" title={formatAbsoluteTime(b.lastSyncedAt)}>
                          Last synced {formatRelativeTime(b.lastSyncedAt)}
                        </span>
                      ) : (
                        <span className="muted">Not synced yet</span>
                      )}
                    </div>
                    {b.tables && b.tables.length > 0 ? <TableStats tables={b.tables} /> : null}
                  </div>
                  <div className="gz-mail-link-actions">
                    {onOpenFolder && b.corpusDir ? (
                      <button
                        type="button"
                        onClick={() => onOpenFolder(b.corpusDir!)}
                        title="Show what it downloaded in Artifacts"
                      >
                        Open
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleSync(b.id, b.type)}
                      disabled={busy === b.id || Boolean(b.disabled)}
                    >
                      {busy === b.id ? 'Working…' : 'Sync now'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCheck(b.id)}
                      disabled={busy === b.id || Boolean(b.disabled)}
                    >
                      Check
                    </button>
                    <button
                      type="button"
                      onClick={() => void handlePause(b.id, !b.disabled)}
                      disabled={busy === b.id}
                    >
                      {b.disabled ? 'Resume' : 'Pause'}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setConfirmUnbind(b.id)}
                      disabled={busy === b.id}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ),
            )}
          </ul>
        </>
      )}

      {pending.length > 0 && (
        <div className="settings-subsection">
          <h4>Pending actions</h4>
          <p className="muted small">
            Drafted by your crew. Review each one, then commit it to send it. Anything your crew
            tried to send or post while you weren't directing it waits here.
          </p>
          <ul className="settings-list">
            {pending.map((a) => (
              <li key={a.draftId} className="connected-app-row">
                <div>
                  <strong>{a.action}</strong>
                  <span className="muted small"> · {a.connectorType}</span>
                  {a.status === 'queued' && <span className="badge"> waiting for you</span>}
                  {a.status === 'uncertain' && <span className="badge"> may have been sent</span>}
                  {a.status === 'uncertain' ? (
                    <p className="muted small">
                      Sending started and did not finish, so it may already have gone out. Check the
                      account before sending it again; Discard removes it here.
                      {a.error ? ` (${a.error})` : ''}
                    </p>
                  ) : (
                    a.error && <p className="muted small">{a.error}</p>
                  )}
                </div>
                <div className="gz-mail-link-actions">
                  {/* Commit refuses an uncertain send, so it is not offered. */}
                  {a.status !== 'uncertain' && (
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void handleCommit(a.draftId)}
                      disabled={busy === a.draftId}
                    >
                      {busy === a.draftId ? 'Working…' : 'Commit'}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void handleDiscardAction(a.draftId)}
                    disabled={busy === a.draftId}
                  >
                    Discard
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {adding && (
        <AddConnectionDialog
          projectId={project.id}
          onClose={() => setAdding(false)}
          onAdded={(added) => void handleAdded(added)}
        />
      )}

      {error && <p className="error small">{error}</p>}
      {notice && <p className="muted small">{notice}</p>}

      <RemoveConnectionDialog
        projectId={project.id}
        binding={
          confirmUnbind
            ? (bindings.find((b) => b.id === confirmUnbind) ?? { id: confirmUnbind })
            : null
        }
        onConfirm={async (deleteData) => {
          if (confirmUnbind) await handleUnbind(confirmUnbind, deleteData);
        }}
        onCancel={() => setConfirmUnbind(null)}
      />
    </div>
  );
}
