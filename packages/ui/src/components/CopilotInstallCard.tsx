import type { CopilotAvailability, SystemToolsetInstallEvent } from '@bendyline/gezel';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { refreshCopilotAvailability } from './useCopilotAvailability.js';

const COPILOT_TOOLSET_ID = '@github/copilot-sdk';

type Phase = Extract<SystemToolsetInstallEvent, { type: 'phase' }>['phase'];

type State =
  | { kind: 'idle' }
  | { kind: 'installing'; phase: Phase; bytesWritten: number; totalBytes: number; log: string[] }
  | { kind: 'failed'; error: string; log: string[] };

/**
 * Install / update surface for the GitHub Copilot SDK.
 *
 * Copilot is the one provider whose runtime we do not ship: it needs
 * GitHub's proprietary CLI, which is a large download and a license nobody
 * should be made to accept just by launching the app. So this card is the
 * only place it gets fetched, and only when the user asks.
 *
 * Five states, driven entirely by {@link CopilotAvailability}:
 *
 *   - `source: 'path'` or `'env'` — the user already has a Copilot CLI.
 *     **No install button.** Offering a second copy of the same proprietary
 *     binary to someone who ran `npm i -g @github/copilot` would be both
 *     wasteful and baffling.
 *   - `managed: 'current'` — installed by us and up to date. One line, no
 *     control.
 *   - `managed: 'outdated'` — installed and working, but this build pins a
 *     different version. Offer an update, never a warning: the on-disk copy
 *     is fine.
 *   - `managed: 'damaged'` — the install directory exists but won't load
 *     (broken links from an old installer, truncated tree). This card is
 *     the only repair surface there is: the provider's error says "choose
 *     Repair" and points here, so a damaged state with no button would
 *     strand the user in a loop between two contradicting screens.
 *   - not available — explain what will be downloaded, then one button.
 */
export function CopilotInstallCard({
  availability,
  onInstalled,
}: {
  availability: CopilotAvailability | null;
  onInstalled?: () => void;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [showLog, setShowLog] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const paneRef = useRef<HTMLPreElement | null>(null);

  // Aborting only detaches this listener — the install is a server-owned job
  // and keeps running, which is what lets the user leave Settings mid-install
  // and come back to live progress. Cancelling for real is a separate call.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: `state` is the trigger — we re-scroll on every change even though the body doesn't read it.
  useEffect(() => {
    if (paneRef.current) paneRef.current.scrollTop = paneRef.current.scrollHeight;
  }, [state]);

  const start = async () => {
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const log: string[] = [];
    let phase: Phase = 'resolving';
    let bytesWritten = 0;
    let totalBytes = 0;
    setState({ kind: 'installing', phase, bytesWritten, totalBytes, log: [] });
    try {
      await api.installSystemToolset(
        COPILOT_TOOLSET_ID,
        (event) => {
          if (event.type === 'phase') phase = event.phase;
          else if (event.type === 'progress') {
            bytesWritten = event.bytesWritten;
            totalBytes = event.totalBytes;
          } else if (event.type === 'log') {
            log.push(event.line);
            if (log.length > 200) log.splice(0, log.length - 200);
          } else if (event.type === 'error') {
            setState({ kind: 'failed', error: event.error, log: [...log] });
            return;
          } else if (event.type === 'done') {
            setState({ kind: 'idle' });
            refreshCopilotAvailability();
            onInstalled?.();
            return;
          }
          setState({ kind: 'installing', phase, bytesWritten, totalBytes, log: [...log] });
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setState({
        kind: 'failed',
        error: err instanceof Error ? err.message : String(err),
        log,
      });
    }
  };

  const cancel = async () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ kind: 'idle' });
    await api.cancelSystemToolsetInstall(COPILOT_TOOLSET_ID).catch(() => {
      /* already finished — nothing to stop */
    });
  };

  return (
    <section className="provider-card">
      <h3>Copilot runtime</h3>

      {state.kind === 'installing' ? (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            Downloading the GitHub Copilot SDK and CLI. You can leave this page — the download keeps
            going.
          </p>
          <InstallProgress
            phase={state.phase}
            bytesWritten={state.bytesWritten}
            totalBytes={state.totalBytes}
          />
          <div className="home-copilot-login-actions">
            <button type="button" className="home-link" onClick={() => void cancel()}>
              Cancel
            </button>
            <button type="button" className="home-link" onClick={() => setShowLog((v) => !v)}>
              {showLog ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {showLog && state.log.length > 0 && (
            <pre ref={paneRef} className="home-copilot-login-output">
              {state.log.join('')}
            </pre>
          )}
        </>
      ) : (
        <IdleBody availability={availability} state={state} onInstall={() => void start()} />
      )}
    </section>
  );
}

function IdleBody({
  availability,
  state,
  onInstall,
}: {
  availability: CopilotAvailability | null;
  state: State;
  onInstall: () => void;
}) {
  const failed = state.kind === 'failed' ? state : null;

  if (!availability) {
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        Checking what's installed…
      </p>
    );
  }

  // The user brought their own CLI. Say so plainly and offer nothing to
  // download — this is a finished state, not a degraded one.
  if (availability.source === 'path' || availability.source === 'env') {
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        Using the Copilot CLI already installed on this device
        {availability.cliPath ? (
          <>
            {' '}
            (<code>{availability.cliPath}</code>)
          </>
        ) : null}
        .
      </p>
    );
  }

  if (availability.managed === 'damaged') {
    return (
      <>
        <p className="error small" style={{ marginTop: 0 }}>
          GitHub Copilot SDK {availability.installedVersion} is installed but its files are damaged
          {availability.damagedReason ? <> — {availability.damagedReason}</> : null}. Repairing
          downloads a fresh copy and replaces the broken install.
        </p>
        {failed && <InstallError error={failed.error} />}
        <div className="home-copilot-login-actions">
          <button type="button" className="primary" onClick={onInstall}>
            {failed ? 'Try repair again' : 'Repair'}
          </button>
        </div>
      </>
    );
  }

  if (availability.managed === 'current') {
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        Installed — GitHub Copilot SDK {availability.installedVersion}.
      </p>
    );
  }

  if (availability.managed === 'outdated') {
    return (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          Installed — GitHub Copilot SDK {availability.installedVersion}. This version of Gezel
          ships with {availability.pinnedVersion}.
        </p>
        {failed && <InstallError error={failed.error} />}
        <div className="home-copilot-login-actions">
          <button type="button" className="home-link" onClick={onInstall}>
            Update to {availability.pinnedVersion}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="muted small" style={{ marginTop: 0 }}>
        GitHub Copilot runs through GitHub's own CLI, which isn't part of Gezel. Install it here and
        Copilot becomes available as a provider — no restart needed.
      </p>
      {failed && <InstallError error={failed.error} />}
      <div className="home-copilot-login-actions">
        <button type="button" className="primary" onClick={onInstall}>
          {failed ? 'Try again' : 'Install'}
        </button>
      </div>
    </>
  );
}

function InstallError({ error }: { error: string }) {
  return (
    <p className="error small" style={{ marginTop: 0 }}>
      Install failed — {error}
    </p>
  );
}

function InstallProgress({
  phase,
  bytesWritten,
  totalBytes,
}: {
  phase: Phase;
  bytesWritten: number;
  totalBytes: number;
}) {
  const known = phase === 'downloading' && totalBytes > 0;
  const pct = known ? Math.min(100, Math.round((bytesWritten / totalBytes) * 100)) : 0;
  const label = known
    ? `${formatBytes(bytesWritten)} of ${formatBytes(totalBytes)} · ${pct}%`
    : PHASE_LABELS[phase];
  return (
    <div className="first-run-banner-progress">
      <div
        className={
          known ? 'first-run-banner-bar' : 'first-run-banner-bar first-run-banner-bar-indeterminate'
        }
      >
        <div
          className="first-run-banner-bar-fill"
          style={known ? { width: `${pct}%` } : undefined}
        />
      </div>
      <span className="first-run-banner-progress-label">{label}</span>
    </div>
  );
}

const PHASE_LABELS: Record<Phase, string> = {
  resolving: 'Looking up the package…',
  downloading: 'Downloading…',
  extracting: 'Unpacking…',
  'installing-deps': 'Installing dependencies…',
  publishing: 'Finishing up…',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}
