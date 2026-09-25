import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { requestBackupRestore } from '../components/BackupRestoreDialog.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import { takePendingSettingsSection } from '../settings-nav.js';
import { AudioEngineSettings } from './AudioEngineSettings.js';
import { SidebarSidePicker, ThemePicker } from './SettingsAppearance.js';

/** Model management is supplied by the host; navigation and preferences stay shared. */
export function HostModelSettings() {
  const [section, setSection] = useState(() => hostSection(takePendingSettingsSection()));
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const navigate = (event: Event) => {
      const detail = (event as CustomEvent<{ view?: string; section?: string }>).detail;
      if (detail?.view === 'settings' && detail.section) {
        takePendingSettingsSection();
        setSection(hostSection(detail.section));
      }
    };
    window.addEventListener('gezel:navigate', navigate);
    return () => window.removeEventListener('gezel:navigate', navigate);
  }, []);
  useEffect(() => {
    void api
      .getConfig()
      .then((config) => setAdvanced(config.showAdvancedFeatures === true))
      .catch((error) => setError(String(error)));
  }, []);
  const saveAdvanced = async (showAdvancedFeatures: boolean) => {
    setSaving(true);
    setError('');
    try {
      const config = await api.updateConfig({ showAdvancedFeatures });
      setAdvanced(config.showAdvancedFeatures === true);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: config }));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        <h2>Settings</h2>
        <ul>
          {[
            { id: 'models', label: 'Artificial Intelligence' },
            { id: 'general', label: 'General' },
            ...(runtimeCapabilities().audio ? [{ id: 'audio', label: 'Audio' }] : []),
            ...(runtimeCapabilities().backups
              ? [{ id: 'backups', label: 'Backup and restore' }]
              : []),
          ].map((item) => (
            <li key={item.id} className="settings-nav-li">
              <button
                type="button"
                aria-current={section === item.id ? 'page' : undefined}
                className={`settings-nav-item${section === item.id ? ' settings-nav-item-active' : ''}`}
                onClick={() => setSection(item.id)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <div className="settings-panel" data-testid={`settings-section-${section}`}>
        {section === 'models' ? (
          window.__GEZEL__?.renderModelSettings?.()
        ) : section === 'audio' ? (
          <AudioEngineSettings />
        ) : section === 'backups' ? (
          <section>
            <h3>Keep a copy of your work</h3>
            <p>
              Back up your projects, gezels, conversations, and documents to a file. You can review
              a backup before restoring it.
            </p>
            <button type="button" onClick={() => requestBackupRestore({ tab: 'backup' })}>
              Back up content…
            </button>{' '}
            <button type="button" onClick={() => requestBackupRestore({ tab: 'restore' })}>
              Restore from a backup…
            </button>
          </section>
        ) : (
          <>
            <section>
              <h3>Appearance</h3>
              <ThemePicker />
            </section>
            <section>
              <h3>Sidebar position</h3>
              <SidebarSidePicker />
            </section>
            <section>
              <h3>Advanced</h3>
              <label>
                <input
                  type="checkbox"
                  checked={advanced}
                  disabled={saving}
                  onChange={(event) => void saveAdvanced(event.target.checked)}
                />{' '}
                Show advanced features
              </label>
              <p className="muted small">Show Scripts and other advanced tools in the sidebar.</p>
              {error && <p role="alert">{error}</p>}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function hostSection(section: string | null): string {
  if (section === 'general') return section;
  if (section === 'audio' && runtimeCapabilities().audio) return section;
  if (section === 'backups' && runtimeCapabilities().backups) return section;
  return 'models';
}
