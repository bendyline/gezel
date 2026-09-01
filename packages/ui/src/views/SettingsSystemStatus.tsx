import type { SystemDiagnostics } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ReportErrorLink } from '../components/ReportErrorLink.js';
import { type SystemNotice, serviceNotice, updateNotice } from '../system-notices.js';
import { useUpdateState } from '../update-state.js';

/** Human form of the daemon's start time — raw ISO reads as a dev artifact. */
export function formatStartedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

export function AutostartToggle() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'unsupported' }
    | { kind: 'ready'; installed: boolean; busy: boolean; error: string | null }
  >({ kind: 'loading' });

  const autostartApi = window.__GEZEL__?.autostart;

  const refresh = useCallback(async () => {
    if (!autostartApi) {
      setState({ kind: 'unsupported' });
      return;
    }
    const res = await autostartApi.status();
    if (res.ok) {
      setState({ kind: 'ready', installed: res.installed, busy: false, error: null });
    } else {
      setState({ kind: 'ready', installed: false, busy: false, error: res.error });
    }
  }, [autostartApi]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (state.kind === 'loading') return <p className="muted small">Checking autostart…</p>;
  if (state.kind === 'unsupported') {
    return (
      <p className="muted small">
        Background autostart is managed from the gezel desktop app — open this page there to keep
        the service running at login.
      </p>
    );
  }

  const toggle = async () => {
    if (!autostartApi || state.kind !== 'ready') return;
    setState({ ...state, busy: true, error: null });
    const op = state.installed ? autostartApi.uninstall : autostartApi.install;
    const res = await op();
    if (res.ok) {
      await refresh();
    } else {
      setState({ ...state, busy: false, error: res.error });
    }
  };

  return (
    <div className="autostart-toggle" style={{ marginTop: '0.75rem' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <input
          type="checkbox"
          checked={state.installed}
          disabled={state.busy}
          onChange={() => void toggle()}
        />
        <span>
          <strong>Run gezel service in the background at login.</strong>{' '}
          <span className="muted small">
            (Installs as a {autostartLabel()} so Gezel starts even when the app window isn't open.)
          </span>
        </span>
      </label>
      {state.error && (
        <p className="error small" style={{ marginTop: '0.5rem' }}>
          {state.error}
        </p>
      )}
    </div>
  );
}

function autostartLabel(): string {
  const platform = window.__GEZEL__?.platform;
  if (platform === 'darwin') return 'LaunchAgent configuration';
  if (platform === 'linux') return 'systemd --user unit';
  if (platform === 'win32') return 'Task Scheduler task';
  return 'startup item';
}

/**
 * The quiet form every install-health notice takes here: a headline, the
 * plain-language explanation, and the raw diagnostic behind a disclosure.
 * This page is the notice's only full home — the navigation rail carries at
 * most a one-line label pointing back here.
 */
function SystemNoticeNote({ notice }: { notice: SystemNotice }) {
  return (
    <div className="settings-notice" data-testid={`settings-notice-${notice.id}`}>
      <strong>{notice.title}</strong>
      <span>
        {notice.body}
        {notice.link ? (
          <>
            {' '}
            <a href={notice.link.href} rel="noreferrer">
              {notice.link.label}
            </a>
          </>
        ) : null}
      </span>
      {notice.technical && (
        <details>
          <summary>Technical details</summary>
          <p>{notice.technical}</p>
        </details>
      )}
      {notice.reportable && (
        <ReportErrorLink
          className="gz-link-button"
          report={{
            surface: 'install-health',
            message: notice.title,
            // Already on screen behind the disclosure above, so this adds no
            // new exposure — and it is the single most useful line to a
            // maintainer reading the issue.
            stack: notice.technical,
          }}
        />
      )}
    </div>
  );
}

/**
 * The live local engines and — the load-bearing number — the context
 * window each one ACTUALLY granted at launch. A model looping or "acting
 * dumb" on a small machine is very often a window smaller than its
 * standing prompt; surfacing the grant here turns that diagnosis into one
 * glance instead of a log hunt through `~/.gezel/logs/`.
 */
export function LocalEngineStatus() {
  const [engines, setEngines] = useState<NonNullable<SystemDiagnostics['localEngines']>>([]);
  const [hardStopOpen, setHardStopOpen] = useState(false);
  const [hardStopping, setHardStopping] = useState(false);
  const [hardStopError, setHardStopError] = useState<string | null>(null);
  const [hardStopNotice, setHardStopNotice] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    void api.getSystemDiagnostics().then(
      (diagnostics) => {
        if (mountedRef.current) setEngines(diagnostics.localEngines ?? []);
      },
      () => {
        if (mountedRef.current) setEngines([]);
      },
    );
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hardStop = async () => {
    if (hardStopping) return;
    setHardStopping(true);
    setHardStopError(null);
    setHardStopNotice(null);
    try {
      const result = await api.emergencyStopChats();
      window.dispatchEvent(
        new CustomEvent('gezel:config-updated', {
          detail: { aiEngagementMode: 'reactive' },
        }),
      );
      if (!mountedRef.current) return;
      setEngines([]);
      setHardStopNotice(
        `Stopped ${result.cancelledTurns} ${result.cancelledTurns === 1 ? 'chat' : 'chats'}${
          result.clearedQueuedMessages > 0
            ? ` and discarded ${result.clearedQueuedMessages} queued ${result.clearedQueuedMessages === 1 ? 'message' : 'messages'}`
            : ''
        }. Local engines unloaded. Gezel is Reactive.`,
      );
      setHardStopOpen(false);
    } catch (error) {
      if (mountedRef.current) {
        setHardStopError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (mountedRef.current) setHardStopping(false);
    }
  };

  if (engines.length === 0 && !hardStopNotice) return null;
  return (
    <>
      {engines.length > 0 && (
        <dl>
          <dt>Local engine processes</dt>
          <dd>
            {engines.map((engine, idx) => {
              const parts: string[] = [];
              if (engine.contextPerSlot !== undefined) {
                parts.push(`${engine.contextPerSlot.toLocaleString()}-token context window`);
              }
              if (engine.slots !== undefined && engine.slots > 1) {
                parts.push(`${engine.slots} slots`);
              }
              if (engine.kvCacheType) parts.push(`${engine.kvCacheType} KV`);
              if (engine.backend) parts.push(engine.backend);
              return (
                <div key={`${engine.provider}-${engine.pid ?? idx}`}>
                  <strong>{localEngineProcessName(engine.provider)}:</strong>{' '}
                  {engine.model ?? engine.provider}
                  {parts.length > 0 ? ` — ${parts.join(', ')}` : ''}
                  {engine.pid !== undefined ? (
                    <span className="muted small">{` · pid ${engine.pid}`}</span>
                  ) : null}
                </div>
              );
            })}
          </dd>
        </dl>
      )}
      <div className="engine-pill-emergency-stop">
        <div className="engine-pill-emergency-copy">
          <strong>Need everything to pause?</strong>
          <span>Stop every chat, unload local engines, and switch Gezel to Reactive.</span>
        </div>
        <button
          type="button"
          className="danger engine-pill-emergency-button"
          disabled={hardStopping}
          onClick={() => {
            setHardStopError(null);
            setHardStopOpen(true);
          }}
        >
          {hardStopping ? 'Stopping…' : 'Hard Stop'}
        </button>
        {hardStopNotice && (
          <output className="engine-pill-emergency-notice">{hardStopNotice}</output>
        )}
      </div>
      <ConfirmDialog
        open={hardStopOpen}
        title="Hard stop all chats?"
        message={
          <>
            Every chat in progress will stop, queued chat messages will be discarded, local engines
            will be unloaded, and Gezel will switch to Reactive. It will only respond when you
            initiate a chat.
            {hardStopError && (
              <span className="engine-pill-emergency-error" role="alert">
                {hardStopError}
              </span>
            )}
          </>
        }
        confirmLabel="Hard stop"
        danger
        onConfirm={hardStop}
        onCancel={() => {
          if (!hardStopping) setHardStopOpen(false);
        }}
      />
    </>
  );
}

/** Canonical process labels shown by the OS; platform suffixes are omitted. */
function localEngineProcessName(
  provider: NonNullable<SystemDiagnostics['localEngines']>[number]['provider'],
): string {
  switch (provider) {
    case 'llama-cpp':
      return 'gezel-llama-server';
    case 'mlx':
      return 'gezel_mlx_server.py';
    case 'ds4':
      return 'gezel-ds4-server';
  }
}

/**
 * Whether gezeld is running as a real background service this launch. The
 * degraded answer used to be a banner across Home; it is neither urgent nor
 * fixable without the installer, so it lives here and only leaves a one-line
 * pointer in the rail.
 */
export function BackgroundServiceStatus() {
  const [logsError, setLogsError] = useState<string | null>(null);
  const notice = serviceNotice({
    reason: window.__GEZEL__?.fallbackReason ?? null,
    code: window.__GEZEL__?.fallbackCode ?? null,
    ...(window.__GEZEL__?.platform ? { platform: window.__GEZEL__.platform } : {}),
  });

  if (!notice) {
    return (
      <p className="muted small" style={{ marginTop: '0.75rem' }}>
        The background service is running normally.
      </p>
    );
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <SystemNoticeNote notice={notice} />
      <p className="muted small" style={{ marginTop: '0.5rem' }}>
        Service logs are under <code>~/.gezel/logs/</code>.{' '}
        <button
          type="button"
          className="subtle"
          onClick={() => {
            const open = window.__GEZEL__?.openLogsFolder;
            if (!open) {
              setLogsError('Opening the folder needs the Gezel desktop app.');
              return;
            }
            void open()
              .then((err) => setLogsError(err || null))
              .catch((err: unknown) => setLogsError(String(err)));
          }}
        >
          Open logs folder
        </button>
      </p>
      {logsError && <p className="error small">{logsError}</p>}
    </div>
  );
}

/** Where the last update attempt got to. Silent unless there is news. */
export function UpdateStatus() {
  const state = useUpdateState();
  const platform = window.__GEZEL__?.platform;
  const notice =
    state?.kind === 'error' || state?.kind === 'available' ? updateNotice(state, platform) : null;
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  if (notice) {
    return (
      <div style={{ marginTop: '0.75rem' }}>
        <SystemNoticeNote notice={notice} />
      </div>
    );
  }

  if (state?.kind === 'checking') {
    return (
      <output className="update-status" data-testid="update-status-checking">
        Checking for updates…
      </output>
    );
  }

  if (state?.kind === 'up-to-date') {
    return (
      <output className="update-status update-status-success" data-testid="update-status-current">
        Gezel {state.version} is up to date.
      </output>
    );
  }

  if (state?.kind === 'downloading') {
    return (
      <output className="update-status" data-testid="update-status-downloading">
        <span className="update-status-head">
          <span>Downloading Gezel {state.version}…</span>
          {state.percent !== undefined && <strong>{state.percent}%</strong>}
        </span>
        {state.percent !== undefined && (
          <progress
            className="update-status-progress"
            max={100}
            value={state.percent}
            aria-label={`Update download ${state.percent}% complete`}
          />
        )}
        {state.transferred !== undefined && state.total !== undefined && (
          <span className="muted small">
            {formatUpdateBytes(state.transferred)} of {formatUpdateBytes(state.total)}
            {state.bytesPerSecond !== undefined
              ? ` · ${formatUpdateBytes(state.bytesPerSecond)}/s`
              : ''}
          </span>
        )}
      </output>
    );
  }

  if (state?.kind === 'ready') {
    return (
      <output className="update-status update-status-ready" data-testid="update-status-ready">
        <strong>Gezel {state.version} is ready to install.</strong>
        <span className="muted small">
          {platform === 'darwin'
            ? 'Open the verified installer when you are ready.'
            : 'It will install automatically after you quit Gezel completely. Closing the window may leave Gezel running in the system tray.'}
        </span>
        <span>
          <button
            type="button"
            className="primary"
            disabled={installing}
            onClick={() => {
              setInstalling(true);
              setInstallError(null);
              const install = window.__GEZEL__?.update?.install;
              if (!install) {
                setInstallError('Installing updates needs the Gezel desktop app.');
                setInstalling(false);
                return;
              }
              void install()
                .then((result) => {
                  if (!result.ok) {
                    setInstallError(result.error);
                    setInstalling(false);
                  }
                })
                .catch((err: unknown) => {
                  setInstallError(err instanceof Error ? err.message : String(err));
                  setInstalling(false);
                });
            }}
          >
            {installing
              ? platform === 'darwin'
                ? 'Opening installer…'
                : 'Restarting…'
              : platform === 'darwin'
                ? 'Open installer'
                : 'Install and restart'}
          </button>
        </span>
        {installError && <span className="error small">{installError}</span>}
      </output>
    );
  }

  return null;
}

function formatUpdateBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
