import type { HealthResponse, MlxRuntimeStatus, SystemBootstrapStatus } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import { streamMlxRuntimeStatus, streamSystemToolsetStatus } from '@bendyline/gezel-client';
import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * One-line strip of "is the local setup healthy?" pills — service
 * version, Node version, OS platform, and (when applicable) the
 * system-toolset bootstrap phase. Rendered during onboarding on Home
 * and again on Settings → General so the same signals stay reachable
 * after the Home strip has been collapsed.
 *
 * Each mount pulls health + system status once on its own. Cheap;
 * tolerates both being offline.
 */
export function HealthStrip({ label }: { label?: string } = {}) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [systemStatus, setSystemStatus] = useState<SystemBootstrapStatus | null>(null);
  const [mlxStatus, setMlxStatus] = useState<MlxRuntimeStatus | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch(() => {});
    api
      .getSystemToolsetStatus()
      .then(setSystemStatus)
      .catch(() => {});
    api
      .getMlxRuntimeStatus()
      .then(setMlxStatus)
      .catch(() => {});
    api
      .getConfig()
      .then(setConfig)
      .catch(() => {});
  }, []);

  // Live-track system-toolset bootstrap transitions so the pill shows
  // the current phase (installing / downloading / ready / error)
  // without requiring a refresh.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const status of streamSystemToolsetStatus({
          url: api.systemToolsetStatusStreamUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          setSystemStatus(status);
        }
      } catch {
        /* aborted or stream ended */
      }
    })();
    return () => ctrl.abort();
  }, []);

  // Same shape for the MLX venv lifecycle — flips the "MLX runtime"
  // pill from orange (provisioning) to green (ready) live as `uv`
  // finishes installing torch / mlx-vlm wheels.
  useEffect(() => {
    const ctrl = new AbortController();
    void (async () => {
      try {
        for await (const status of streamMlxRuntimeStatus({
          url: api.mlxRuntimeStatusStreamUrl(),
          headers: api.authHeader(),
          signal: ctrl.signal,
          fetch: api.getFetch(),
        })) {
          setMlxStatus(status);
        }
      } catch {
        /* aborted or stream ended */
      }
    })();
    return () => ctrl.abort();
  }, []);

  const nodeOk = Boolean(health?.nodeVersion);
  const daemonOk = Boolean(health?.ok);

  return (
    <div className="home-env-checks">
      {label && <span className="home-env-label">{label}</span>}
      <StatusPill
        ok={daemonOk}
        label={
          health?.version && health.version !== '0.0.0'
            ? `Gezel service v${health.version}`
            : 'Gezel service · dev build'
        }
      />
      <StatusPill ok={nodeOk} label={`Node ${health?.nodeVersion ?? 'unknown'}`} />
      {health?.platform && <StatusPill ok label={`${humanPlatform(health.platform)} platform`} />}
      {systemStatus && (
        <StatusPill ok={systemStatus.phase === 'ready'} label={systemStatusLabel(systemStatus)} />
      )}
      {config?.provider === 'llama-cpp' && health && <LlamaCppEnginePill health={health} />}
      {config?.provider === 'mlx' && mlxStatus && mlxStatus.phase !== 'idle' && (
        <MlxRuntimePill status={mlxStatus} />
      )}
      {config?.debugMode === true && (
        <span
          className="gz-status-pill gz-status-pill--debug"
          title="Verbose diagnostics are being written to ~/.gezel/logs/. Turn off under Settings → General when you're done troubleshooting."
        >
          ⚙ Debug mode on
        </span>
      )}
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`gz-status-pill gz-status-pill--${ok ? 'ok' : 'warn'}`}>
      {ok ? '✓' : '!'} {label}
    </span>
  );
}

function humanPlatform(p: string): string {
  if (p === 'darwin') return 'Mac';
  if (p === 'win32') return 'Windows';
  if (p === 'linux') return 'Linux';
  return p;
}

function systemStatusLabel(s: SystemBootstrapStatus): string {
  if (s.phase === 'ready') return 'Runtime ready';
  if (s.phase === 'installing-toolsets') {
    return s.currentToolset
      ? `Installing ${prettyToolsetName(s.currentToolset)}…`
      : 'Installing runtime toolset…';
  }
  if (s.phase === 'downloading-browser') {
    const p = s.browserProgress;
    if (p?.bytesTotal && p.bytesTotal > 0) {
      const pct = Math.min(100, Math.floor((p.bytesDownloaded / p.bytesTotal) * 100));
      const mb = (n: number) => (n / (1024 * 1024)).toFixed(0);
      return `Downloading Chromium ${pct}% (${mb(p.bytesDownloaded)}/${mb(p.bytesTotal)} MB)`;
    }
    return 'Downloading Chromium…';
  }
  if (s.phase === 'setup-incomplete')
    return `Runtime toolsets not pinned${s.error ? `: ${s.error.slice(0, 140)}` : ''}`;
  if (s.phase === 'error')
    return `Runtime setup failed${s.error ? `: ${s.error.slice(0, 140)}` : ''}`;
  return 'Runtime setup pending';
}

function prettyToolsetName(id: string): string {
  if (id === '@playwright/mcp') return 'Playwright';
  if (id === '@github/copilot-sdk') return 'GitHub Copilot';
  return id;
}

/**
 * Honest signal about whether a llama-server binary was actually
 * resolved on this launch. The supervisor publishes
 * `health.llamaCppBackend` only when it found a binary matching the
 * detected backend (CUDA / Vulkan / Metal / CPU); absence means the
 * service will throw "no local engine is available on this machine"
 * the moment anything tries to chat. Without this pill the strip
 * reads all-green even in that broken state — chat then fails with
 * a long actionable error at the bottom of the screen.
 */
function LlamaCppEnginePill({ health }: { health: HealthResponse }) {
  if (health.llamaCppBackend) {
    return <StatusPill ok label={`On-device engine (${humanBackend(health.llamaCppBackend)})`} />;
  }
  // Detected hardware backend present but no binary bundled for it,
  // OR no probe ran at all. Either way the user can't chat on-device
  // until they install a build that ships the engine or point at an
  // external llama-server.
  const detected = health.llamaCppDetectedBackend;
  const title = detected
    ? `No bundled llama-server for ${humanBackend(detected)} on this build. Install a Gezel build that bundles the engine, or set an External engine URL under Settings → On-device → Advanced.`
    : 'No llama-server binary bundled with this build. Install a Gezel build that bundles the engine, or set an External engine URL under Settings → On-device → Advanced.';
  return (
    <span className="gz-status-pill gz-status-pill--warn" title={title}>
      ✗ On-device engine missing
    </span>
  );
}

function humanBackend(b: NonNullable<HealthResponse['llamaCppBackend']>): string {
  if (b === 'cuda') return 'CUDA';
  if (b === 'vulkan') return 'Vulkan';
  if (b === 'metal') return 'Metal';
  return 'CPU';
}

function MlxRuntimePill({ status }: { status: MlxRuntimeStatus }) {
  const label = mlxStatusLabel(status);
  if (status.phase === 'ready') {
    return <StatusPill ok label={label} />;
  }
  if (status.phase === 'error') {
    return (
      <span
        className="gz-status-pill gz-status-pill--warn"
        title={status.error ?? 'MLX runtime failed to provision'}
      >
        ✗ {label}
      </span>
    );
  }
  // 'provisioning' — orange spinner-ish pill. We reuse the warn style
  // (amber) so it reads as "in flight, not ready yet" without being
  // alarming. The optional message goes in the title attribute.
  return (
    <span
      className="gz-status-pill gz-status-pill--warn"
      title={status.message ?? 'Installing MLX runtime…'}
    >
      ⏳ {label}
    </span>
  );
}

function mlxStatusLabel(s: MlxRuntimeStatus): string {
  if (s.phase === 'ready') return 'MLX runtime ready';
  if (s.phase === 'provisioning') return 'MLX runtime warming up…';
  if (s.phase === 'error') return 'MLX runtime failed';
  return 'MLX runtime idle';
}
