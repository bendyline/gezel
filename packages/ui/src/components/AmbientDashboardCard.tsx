import type { AmbientDashboardStatusResponse, AmbientDashboardTheme } from '@bendyline/gezel';
import { GezelApiError } from '@bendyline/gezel-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { AmbientDashboardThemeSelect } from './AmbientDashboardThemeSelect.js';
import { SettingCheck, SettingsSection } from './SettingsSection.js';

/**
 * Settings → "Ambient display": the opt-in toggle for the meester's
 * hourly dashboard PNG, a Generate-now button with a live preview, and
 * (inside Electron) the wallpaper auto-apply toggle backed by the
 * `window.__GEZEL__.ambient` bridge. The generator lives in the daemon;
 * the wallpaper applier lives in the Electron main process.
 */

type AmbientBridge = NonNullable<NonNullable<Window['__GEZEL__']>['ambient']>;
type AmbientBridgeStatus = Extract<Awaited<ReturnType<AmbientBridge['status']>>, { ok: true }>;

function platformInstructions(platform: string | undefined): { title: string; lines: string[] } {
  if (platform === 'darwin') {
    return {
      title: 'Point macOS at the folder yourself',
      lines: [
        'System Settings → Wallpaper → Add Folder or Album… → choose the ambient folder, then pick a rotation interval.',
        'The macOS lock screen follows the desktop wallpaper automatically.',
      ],
    };
  }
  if (platform === 'win32') {
    return {
      title: 'Point Windows at the folder yourself',
      lines: [
        'Settings → Personalization → Background → Slideshow → choose the ambient folder.',
        'Lock screen: Settings → Personalization → Lock screen → Slideshow → add the ambient folder (turn off Windows Spotlight first).',
      ],
    };
  }
  return {
    title: 'Point your desktop at the folder yourself',
    lines: [
      'GNOME and KDE are handled by the automatic toggle above when available.',
      "On other desktops, point your environment's wallpaper slideshow at the ambient folder (e.g. XFCE: Desktop settings → Background → Folder).",
    ],
  };
}

export function AmbientDashboardCard() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<AmbientDashboardStatusResponse | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<AmbientBridgeStatus | null>(null);
  const [wallpaperOn, setWallpaperOn] = useState(false);
  const [themeSaving, setThemeSaving] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const previewRef = useRef<string | null>(null);

  const ambient = window.__GEZEL__?.ambient;
  const platform = window.__GEZEL__?.platform;

  const refreshPreview = useCallback(async () => {
    try {
      const res = await api.getFetch()(api.ambientDashboardLatestUrl(), {
        headers: api.authHeader(),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const next = URL.createObjectURL(blob);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
      previewRef.current = next;
      setPreviewUrl(next);
    } catch {
      /* no preview yet */
    }
  }, []);

  const refreshStatus = useCallback(async (): Promise<AmbientDashboardStatusResponse | null> => {
    try {
      const next = await api.getAmbientDashboard();
      setStatus(next);
      setEnabled(next.enabled);
      return next;
    } catch {
      return null;
    }
  }, []);

  const refreshBridge = useCallback(async () => {
    if (!ambient) return;
    try {
      const next = await ambient.status();
      if (next.ok) {
        setBridgeStatus(next);
        setWallpaperOn(next.enabled);
      }
    } catch {
      /* bridge unavailable */
    }
  }, [ambient]);

  // Follow an in-flight generation to its end. Bounded so a wedged
  // daemon can't leave the card polling forever.
  const pollUntilIdle = useCallback(() => {
    if (pollTimer.current !== null) return;
    // Manual runs have an intentionally generous deadline: they may be
    // waiting for a single-lane local model turn to finish before dispatch.
    let remaining = 480;
    const tick = async () => {
      pollTimer.current = null;
      const next = await refreshStatus();
      remaining -= 1;
      if (next?.running && remaining > 0) {
        pollTimer.current = window.setTimeout(() => void tick(), 2000);
      } else {
        void refreshPreview();
      }
    };
    pollTimer.current = window.setTimeout(() => void tick(), 2000);
  }, [refreshStatus, refreshPreview]);

  useEffect(() => {
    void refreshStatus().then((initial) => {
      if (initial?.running) pollUntilIdle();
    });
    void refreshPreview();
    void refreshBridge();
    return () => {
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [refreshStatus, refreshPreview, refreshBridge, pollUntilIdle]);

  const saveEnabled = useCallback(
    async (next: boolean) => {
      const previous = enabled;
      setEnabled(next);
      setError(null);
      try {
        await api.updateConfig({ ambientDashboard: { enabled: next } });
        void refreshStatus();
      } catch (err) {
        setEnabled(previous);
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [enabled, refreshStatus],
  );

  const generateNow = useCallback(async () => {
    setError(null);
    try {
      await api.runAmbientDashboard();
    } catch (err) {
      // 409: a run already holds the slot (often a scheduled one, or a
      // manual run still waiting on a busy local model). Follow it.
      if (!(err instanceof GezelApiError && err.status === 409)) {
        setError(apiErrorMessage(err));
        return;
      }
    }
    setStatus((current) => (current ? { ...current, running: true } : current));
    pollUntilIdle();
  }, [pollUntilIdle]);

  const saveTheme = useCallback(
    async (nextId: string) => {
      if (!status?.themeId || !status.themes?.some((theme) => theme.id === nextId)) return;
      const themeId = nextId as AmbientDashboardTheme;
      const previous = status.themeId;
      if (themeId === previous) return;
      setThemeSaving(true);
      setError(null);
      setStatus((current) => (current ? { ...current, themeId } : current));
      try {
        await api.updateConfig({ ambientDashboard: { themeId } });
        await refreshStatus();
      } catch (err) {
        setStatus((current) => (current ? { ...current, themeId: previous } : current));
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setThemeSaving(false);
      }
    },
    [refreshStatus, status],
  );

  const toggleWallpaper = useCallback(
    async (next: boolean) => {
      if (!ambient) return;
      const previous = wallpaperOn;
      setWallpaperOn(next);
      setError(null);
      const result = next ? await ambient.enable() : await ambient.disable();
      if (!result.ok) {
        setWallpaperOn(previous);
        setError(result.error);
        return;
      }
      if (!next && 'reason' in result && result.reason === 'nothing-captured') {
        setError('No previous wallpaper was captured, so the current one was left in place.');
      }
      void refreshBridge();
    },
    [ambient, wallpaperOn, refreshBridge],
  );

  const capability = bridgeStatus?.capability;
  const wallpaperUnavailable = !ambient
    ? 'Available in the Gezel desktop app.'
    : capability && !capability.supported
      ? capability.reason === 'unknown-desktop'
        ? `Automatic wallpaper is not supported on this desktop (${capability.desktop ?? 'unknown'}).`
        : capability.reason === 'command-missing'
          ? 'The desktop wallpaper tool was not found on this system.'
          : 'Automatic wallpaper is not supported on this platform.'
      : !enabled
        ? 'Turn on dashboard generation first.'
        : null;

  const instructions = platformInstructions(platform);
  const selectedTheme = status?.themes?.find((theme) => theme.id === status.themeId);
  const latestGenerationFailed = Boolean(
    status?.lastError &&
      status.lastFailedAt &&
      (!status.lastGeneratedAt ||
        Date.parse(status.lastFailedAt) >= Date.parse(status.lastGeneratedAt)),
  );
  const visibleError =
    error ?? (latestGenerationFailed ? `Dashboard generation failed: ${status?.lastError}` : null);

  return (
    <SettingsSection
      id="settings-ambient-display"
      title="Ambient display"
      hint="When on, your meester composes a dashboard of what moved across your projects — roughly once an hour while the workshop changes — and renders it as an image made to be shown as a wallpaper or lock screen. Images land in the ambient folder; the newest one is always available as latest.png."
    >
      <SettingCheck
        label="Generate an ambient dashboard"
        checked={enabled}
        onChange={(checked) => void saveEnabled(checked)}
      />
      {enabled && status?.themeId && status.themes && (
        <div className="gz-setting">
          <span id="ambient-dashboard-theme-label" className="gz-setting-label">
            Dashboard theme
          </span>
          <AmbientDashboardThemeSelect
            value={status.themeId}
            themes={status.themes}
            disabled={themeSaving || status.running}
            labelledBy="ambient-dashboard-theme-label"
            onValueChange={(value) => void saveTheme(value)}
          />
          <p className="gz-setting-hint">
            {themeSaving
              ? 'Saving theme…'
              : `${selectedTheme?.description ?? 'Squisq dashboard theme.'} Applies to the next generated image.`}
          </p>
        </div>
      )}
      {enabled && (
        <div className="gz-setting">
          <p
            className="gz-setting-hint"
            title={status?.lastGeneratedAt ? formatAbsoluteTime(status.lastGeneratedAt) : undefined}
          >
            {status?.running
              ? 'The meester is composing a dashboard…'
              : status?.lastGeneratedAt
                ? `Last generated ${formatRelativeTime(status.lastGeneratedAt)}`
                : 'Nothing generated yet. The first image may wait for the browser runtime download to finish.'}
          </p>
          <button type="button" onClick={() => void generateNow()} disabled={status?.running}>
            Generate now
          </button>
          {previewUrl && (
            <img
              className="ambient-dashboard-preview"
              src={previewUrl}
              alt="Latest ambient dashboard"
            />
          )}
        </div>
      )}
      <SettingCheck
        label="Keep my desktop wallpaper set to the latest dashboard"
        hint={
          wallpaperUnavailable ??
          (capability?.canRestore
            ? 'Turning this on changes your wallpaper right away; turning it off restores the previous one.'
            : 'Turning this on changes your wallpaper right away. On this desktop the previous wallpaper cannot be restored automatically.')
        }
        checked={wallpaperOn}
        disabled={wallpaperUnavailable !== null}
        onChange={(checked) => void toggleWallpaper(checked)}
      />
      {ambient && (
        <div className="gz-setting-row">
          <button type="button" onClick={() => void ambient.openFolder()}>
            Open ambient folder
          </button>
          {bridgeStatus?.folder && <code>{bridgeStatus.folder}</code>}
        </div>
      )}
      <details className="ambient-dashboard-instructions">
        <summary>{instructions.title}</summary>
        <ul>
          {instructions.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
      {visibleError && (
        <p className="error small" role="alert">
          {visibleError}
        </p>
      )}
    </SettingsSection>
  );
}
