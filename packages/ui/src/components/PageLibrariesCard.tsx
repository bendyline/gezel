import type { PageLibrariesResponse, PageLibraryLineStatus } from '@bendyline/gezel/pages';
import { useCallback, useEffect, useState } from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { SettingCheck, SettingsSection } from './SettingsSection.js';
import { formatBytes } from './model-memory-copy.js';

/**
 * Settings → Page libraries (docs/page-libraries.md): the libraries pages
 * the crew builds can load from this computer, which of them are here, and
 * whether Gezel fetches one when a page needs it. The downloads themselves
 * run in the daemon; this card lists them and starts or removes one.
 */

const FORM_WORDS: Record<PageLibraryLineStatus['forms'][number], string> = {
  module: 'import',
  classic: 'script tag',
  style: 'stylesheet',
};

function lineState(line: PageLibraryLineStatus): string {
  if (line.downloading) return 'Downloading…';
  if (line.installed) {
    const size = line.bytes ? formatBytes(line.bytes) : '';
    return line.removable ? `On this computer${size ? ` · ${size}` : ''}` : 'Came with Gezel';
  }
  return 'Not downloaded';
}

export function PageLibrariesCard() {
  const [status, setStatus] = useState<PageLibrariesResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getPageLibraries());
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (library: string, version: string, action: 'install' | 'remove') => {
      const key = `${library}@${version}`;
      setBusy(key);
      setError(null);
      try {
        if (action === 'install') await api.installPageLibrary(library, version);
        else await api.removePageLibrary(library, version);
      } catch (err) {
        setError(apiErrorMessage(err));
      } finally {
        setBusy(null);
        await refresh();
      }
    },
    [refresh],
  );

  const saveAutoDownload = useCallback(
    async (next: boolean) => {
      setError(null);
      setStatus((current) => (current ? { ...current, autoDownload: next } : current));
      try {
        await api.updateConfig({ pageLibraries: { autoDownload: next } });
      } catch (err) {
        setError(apiErrorMessage(err));
      }
      await refresh();
    },
    [refresh],
  );

  const canDownload = status?.downloads.person ?? false;

  return (
    <SettingsSection
      id="settings-page-libraries"
      title="Page libraries"
      hint="Ready-made code that web pages your crew builds can use without the internet: 3D graphics, charts, interface building blocks. A page names one the usual way and Gezel loads it from this computer."
    >
      {canDownload ? (
        <SettingCheck
          label="Download a library the first time a page needs it"
          hint="Gezel fetches the exact version it lists from the npm registry and checks it before any page uses it."
          checked={status?.autoDownload ?? true}
          onChange={(checked) => void saveAutoDownload(checked)}
        />
      ) : null}
      {status?.downloads.refusal && status.downloads.blocked !== 'setting' ? (
        <p className="gz-setting-hint">{status.downloads.refusal}</p>
      ) : null}
      {status && status.libraries.length === 0 ? (
        <p className="gz-setting-hint">No page libraries are available in this version of Gezel.</p>
      ) : null}
      {status && status.libraries.length > 0 ? (
        <ul className="gz-page-libraries" aria-label="Page libraries">
          {status.libraries.map((library) => (
            <li key={library.library} className="gz-page-library">
              <div className="gz-page-library-name">
                <span className="gz-setting-label">{library.name}</span>
                {library.description ? (
                  <span className="gz-setting-hint">{library.description}</span>
                ) : null}
              </div>
              <ul className="gz-page-library-lines">
                {library.lines.map((line) => {
                  const key = `${library.library}@${line.version}`;
                  return (
                    <li key={key} className="gz-page-library-line">
                      <span className="gz-page-library-version">{line.version}</span>
                      <span className="gz-setting-hint">
                        {line.forms.map((form) => FORM_WORDS[form]).join(', ')} · {lineState(line)}
                        {line.error ? ` · Last download failed: ${line.error}` : ''}
                      </span>
                      {line.installed && line.removable ? (
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => void act(library.library, line.version, 'remove')}
                        >
                          {busy === key ? 'Removing…' : 'Remove'}
                        </button>
                      ) : null}
                      {!line.installed && canDownload ? (
                        <button
                          type="button"
                          disabled={busy !== null || line.downloading}
                          onClick={() => void act(library.library, line.version, 'install')}
                        >
                          {busy === key ? 'Downloading…' : 'Download'}
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="error small" role="alert">
          {error}
        </p>
      ) : null}
    </SettingsSection>
  );
}
