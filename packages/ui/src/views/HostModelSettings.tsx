import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { requestBackupRestore } from '../components/BackupRestoreDialog.js';
import { UserMemoriesEditor } from '../components/MemoriesTree.js';
import { NotificationsSetting } from '../components/NotificationsSetting.js';
import { SocialModeToggle } from '../components/SocialModeToggle.js';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import {
  clearPendingSettingsSection,
  peekPendingSettingsSection,
  takePendingSettingsSection,
} from '../settings-nav.js';
import { AudioEngineSettings } from './AudioEngineSettings.js';
import { SidebarSidePicker, ThemePicker } from './SettingsAppearance.js';
import { SettingsLegalSection } from './SettingsLegal.js';
import { SettingsSectionPicker } from './SettingsSectionPicker.js';

/** Model management is supplied by the host; navigation and preferences stay shared. */
export function HostModelSettings() {
  const [section, setSection] = useState(() => hostSection(peekPendingSettingsSection()));
  // Clear only once this mount has committed — see settings-nav.ts.
  useEffect(() => clearPendingSettingsSection(), []);
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
  const sections = [
    { id: 'models', label: 'Artificial Intelligence' },
    { id: 'general', label: 'General' },
    ...(runtimeCapabilities().memories ? [{ id: 'aboutYou', label: 'About you' }] : []),
    ...(runtimeCapabilities().audio ? [{ id: 'audio', label: 'Audio' }] : []),
    ...(runtimeCapabilities().backups ? [{ id: 'backups', label: 'Backup and restore' }] : []),
    { id: 'about', label: 'About' },
  ];
  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        <h2>Settings</h2>
        <SettingsSectionPicker sections={sections} value={section} onChange={setSection} />
        <ul>
          {sections.map((item) => (
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
        ) : section === 'aboutYou' ? (
          <UserMemoriesEditor />
        ) : section === 'audio' ? (
          <AudioEngineSettings />
        ) : section === 'about' ? (
          <HostAbout />
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
            <section className="settings-sidebar-side">
              <h3>Sidebar position</h3>
              <SidebarSidePicker />
            </section>
            <section>
              <h3>Social mode</h3>
              <SocialModeToggle />
            </section>
            <section>
              <h3>Notifications</h3>
              <NotificationsSetting />
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

/** What this app is, and the terms it ships under. Engine and service management stays desktop-only. */
function HostAbout() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    void api
      .health()
      .then((health) => setVersion(health.version))
      .catch(() => setVersion(null));
  }, []);
  return (
    <>
      <section>
        <h3>About</h3>
        <dl className="settings-facts">
          <dt>Version</dt>
          <dd>{version === null ? '…' : version === '0.0.0' ? 'development build' : version}</dd>
        </dl>
      </section>
      <SettingsLegalSection />
    </>
  );
}

function hostSection(section: string | null): string {
  if (section === 'general' || section === 'about') return section;
  if (section === 'aboutYou' && runtimeCapabilities().memories) return section;
  if (section === 'audio' && runtimeCapabilities().audio) return section;
  if (section === 'backups' && runtimeCapabilities().backups) return section;
  return 'models';
}
