import {
  type ClaudePermissionMode,
  type CodexPermissionMode,
  type GezelSummary,
  type HealthResponse,
  type ProviderName,
  isOllamaReasoningModel,
  normalizeCodexPermissionMode,
} from '@bendyline/gezel';
import type { SystemDiagnostics } from '@bendyline/gezel';
import type {
  ConfigResponse,
  ProviderUsage,
  QuotaBucket,
  UsageResponse,
} from '@bendyline/gezel-client';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AmbientDashboardCard } from '../components/AmbientDashboardCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ConnectedAppsPanel } from '../components/ConnectedAppsPanel.js';
import { CopilotInstallCard } from '../components/CopilotInstallCard.js';
import { CopilotLoginCommand } from '../components/CopilotLoginCommand.js';
import { FaceRecognitionCard } from '../components/FaceRecognitionCard.js';
import { GezelIcon } from '../components/GezelIcon.js';
import { GildeUpdatesCard } from '../components/GildeUpdatesCard.js';
import { HealthStrip } from '../components/HealthStrip.js';
import { InstallModelTuningEditor } from '../components/InstallModelTuningEditor.js';
import { KnowledgeCatalogsCard } from '../components/KnowledgeCatalogsCard.js';
import { requestMacUninstall } from '../components/MacUninstallDialog.js';
import { EffortPicker, EffortTray, ModelPicker } from '../components/ModelPicker.js';
import { RemoteServersPanel } from '../components/RemoteServersPanel.js';
import { ReportErrorLink } from '../components/ReportErrorLink.js';
import { StorageUsageCard } from '../components/StorageUsageCard.js';
import { ToolsetsEditor } from '../components/ToolsetsEditor.js';
import { useCopilotAvailability } from '../components/useCopilotAvailability.js';
import { useTotalRamBytes } from '../components/useTotalRamBytes.js';
import { Poppetje } from '../poppetje/index.js';
import { Select } from '../primitives/index.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
import { takePendingSettingsSection } from '../settings-nav.js';
import { type SidebarSide, getSidebarSide, setSidebarSide } from '../sidebar-side.js';
import { type SystemNotice, serviceNotice, updateNotice } from '../system-notices.js';
import { type ThemePref, getThemePref, setThemePref } from '../theme.js';
import { useUpdateState } from '../update-state.js';
import { AudioEngineSettings } from './AudioEngineSettings.js';
import { BenchmarksView } from './BenchmarksView.js';
import { ChannelsSettings } from './ChannelsSettings.js';
import { Ds4Settings } from './Ds4Settings.js';
import { FoldersSettings } from './FoldersSettings.js';
import { ImageEngineSettings } from './ImageEngineSettings.js';
import { ImageRecognitionSettings } from './ImageRecognitionSettings.js';
import { LlamaCppSettings } from './LlamaCppSettings.js';
import { MlxSettings } from './MlxSettings.js';
import { OllamaSettings, TimeoutRow } from './OllamaSettings.js';
import { SecurityComplianceSettings } from './SecurityComplianceSettings.js';
import { VideoEngineSettings } from './VideoEngineSettings.js';
import { detectDs4Availability } from './ds4-availability.js';
import { localEngineSettingsLabel } from './local-engine-label.js';
import {
  type WebSearchProviderSetting,
  visibleWebSearchProviderSetting,
  webSearchProviderOptions,
} from './web-search-provider-options.js';

type CodexCliReasoningEffort = NonNullable<
  NonNullable<ConfigResponse['codexCli']>['defaultReasoningEffort']
>;

const INCLUDE_TESTING_WEB_SEARCH_PROVIDER = import.meta.env.DEV;
const WEB_SEARCH_PROVIDER_OPTIONS = webSearchProviderOptions(INCLUDE_TESTING_WEB_SEARCH_PROVIDER);

const CLAUDE_PERMISSION_CHOICES: ReadonlyArray<{
  id: ClaudePermissionMode;
  label: string;
  description: string;
}> = [
  {
    id: 'plan',
    label: 'Plan only',
    description: 'Read and review without making changes.',
  },
  {
    id: 'default',
    label: 'Standard prompts',
    description: "Use Claude Code's normal permission prompts.",
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    description: 'Approve file changes; ask before commands and other actions.',
  },
  {
    id: 'bypassPermissions',
    label: 'Full access',
    description: 'Approve every tool automatically, including shell commands.',
  },
];

type SectionId =
  | 'general'
  | 'deviceIntegration'
  | 'team'
  | 'folders'
  | 'defaults'
  | 'copilot'
  | 'openai'
  | 'codexCli'
  | 'anthropic'
  | 'anthropicCli'
  | 'ollama'
  | 'llamaCpp'
  | 'mlx'
  | 'ds4'
  // Header-only id for the collapsible "Workloads" group — never the active
  // section (it renders no panel), it just toggles its children's visibility.
  | 'workloads'
  | 'imageEngine'
  | 'videoEngine'
  | 'imageRecognition'
  | 'audio'
  | 'webSearch'
  | 'channels'
  | 'connectedApps'
  | 'remoteServers'
  | 'toolsets'
  | 'knowledge'
  | 'securityCompliance'
  | 'about'
  | 'benchmarks';

// A visual/collapsible nav group. `group` marks a child item (drawn with a
// small vertical rail on the left so it reads as nested); `groupHeader` marks
// the item that labels and expand/collapses that group.
type SettingsGroup = 'ai' | 'workloads';
type SettingsSection = {
  id: SectionId;
  label: string;
  group?: SettingsGroup;
  groupHeader?: SettingsGroup;
};

/** Parse an hour input, clamping to 0–23 and falling back on garbage. */
function clampHour(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(23, Math.max(0, n));
}

/** Parse a percent input, clamping to 0–100 and falling back on garbage. */
function clampPercent(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

function buildSections(platform: string | undefined): SettingsSection[] {
  return [
    { id: 'general', label: 'General' },
    { id: 'deviceIntegration', label: 'Device Integration' },
    { id: 'team', label: 'Your Team' },
    { id: 'folders', label: 'Folders' },
    { id: 'securityCompliance', label: 'Security & Compliance' },
    { id: 'defaults', label: 'Artificial Intelligence', groupHeader: 'ai' },
    { id: 'mlx', label: localEngineSettingsLabel('mlx', platform), group: 'ai' },
    {
      id: 'llamaCpp',
      label: localEngineSettingsLabel('llama-cpp', platform),
      group: 'ai',
    },
    { id: 'ds4', label: localEngineSettingsLabel('ds4', platform), group: 'ai' },
    { id: 'copilot', label: 'GitHub Copilot', group: 'ai' },
    { id: 'openai', label: 'OpenAI', group: 'ai' },
    { id: 'codexCli', label: 'OpenAI Codex CLI', group: 'ai' },
    { id: 'anthropic', label: 'Anthropic Claude', group: 'ai' },
    { id: 'anthropicCli', label: 'Anthropic Claude CLI', group: 'ai' },
    { id: 'ollama', label: 'Ollama', group: 'ai' },
    { id: 'workloads', label: 'Workloads', groupHeader: 'workloads' },
    { id: 'imageEngine', label: 'Image generation', group: 'workloads' },
    { id: 'videoEngine', label: 'Video generation', group: 'workloads' },
    { id: 'imageRecognition', label: 'Image recognition', group: 'workloads' },
    { id: 'audio', label: 'Audio', group: 'workloads' },
    { id: 'webSearch', label: 'Web search', group: 'workloads' },
    { id: 'knowledge', label: 'Knowledge', group: 'workloads' },
    { id: 'channels', label: 'Channels' },
    { id: 'connectedApps', label: 'Connected Apps' },
    { id: 'remoteServers', label: 'Remote Servers' },
    { id: 'toolsets', label: 'Shared Toolsets' },
    { id: 'about', label: 'About' },
    { id: 'benchmarks', label: 'Benchmarks' },
  ];
}

export function SettingsView() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [tokenDraft, setTokenDraft] = useState<string>('');
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState<string>('');
  const [openaiOrgDraft, setOpenaiOrgDraft] = useState<string>('');
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState<string>('');
  const [braveKeyDraft, setBraveKeyDraft] = useState<string>('');
  // Transient save/confirmation feedback is intentionally not surfaced in
  // the UI — the shared status note that used to render below every tab was
  // removed. The state setter is kept (stable, so it stays out of effect
  // deps) so the many `setStatus` call sites stay simple; genuine load
  // errors still flow through `error` below.
  const [, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [newMeesterOpen, setNewMeesterOpen] = useState(false);
  const [newMeesterName, setNewMeesterName] = useState('');
  const [newMeesterBusy, setNewMeesterBusy] = useState(false);
  const [newKlerkOpen, setNewKlerkOpen] = useState(false);
  const [newKlerkName, setNewKlerkName] = useState('');
  const [newKlerkBusy, setNewKlerkBusy] = useState(false);
  const [newBoekwachterOpen, setNewBoekwachterOpen] = useState(false);
  const [newBoekwachterName, setNewBoekwachterName] = useState('');
  const [newBoekwachterBusy, setNewBoekwachterBusy] = useState(false);
  const [newKeurmeesterOpen, setNewKeurmeesterOpen] = useState(false);
  const [newKeurmeesterName, setNewKeurmeesterName] = useState('');
  const [newKeurmeesterBusy, setNewKeurmeesterBusy] = useState(false);
  // Enabling supervision sends conversation excerpts to a cloud provider,
  // so the toggle goes through an explicit consent step (see the
  // Keurmeester section) instead of saving on click.
  const [keurmeesterConsentOpen, setKeurmeesterConsentOpen] = useState(false);
  // A caller (e.g. the first-run Home "manage on-device models" link) can
  // request a section before this view mounts; consume it as the initial
  // section so the deep link doesn't race the event listener below.
  const [section, setSection] = useState<SectionId>(
    () => (takePendingSettingsSection() as SectionId | null) ?? 'general',
  );
  // Collapsed nav groups (expanded by default → empty set). The "Artificial
  // Intelligence" and "Workloads" headers toggle membership here.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<SettingsGroup>>(() => new Set());
  const toggleGroup = useCallback((g: SettingsGroup) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);
  // Copilot connection probe. Drives the connection-mode indicator and gates
  // the model + reasoning-effort pickers. `ok: true` means the provider can
  // list models right now — via either the CLI SDK or a stored PAT.
  const [copilotProbe, setCopilotProbe] = useState<
    { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok' } | { kind: 'fail'; error: string }
  >({ kind: 'idle' });
  const [copilotLogin, setCopilotLogin] = useState<string | null>(null);
  const [showPatForm, setShowPatForm] = useState(false);
  const [showCliHelp, setShowCliHelp] = useState(false);
  const [copilotTurnTimeoutDraft, setCopilotTurnTimeoutDraft] = useState<string>('');
  useEffect(() => {
    setCopilotTurnTimeoutDraft(
      config?.copilotTurnTimeoutMin ? String(config.copilotTurnTimeoutMin) : '',
    );
  }, [config?.copilotTurnTimeoutMin]);
  const saveCopilotTurnTimeout = useCallback(async () => {
    const trimmed = copilotTurnTimeoutDraft.trim();
    const parsed = trimmed ? Number.parseInt(trimmed, 10) : undefined;
    if (trimmed && (!Number.isFinite(parsed) || (parsed ?? 0) <= 0)) return;
    const res = await api.updateConfig({ copilotTurnTimeoutMin: parsed });
    setConfig(res);
  }, [copilotTurnTimeoutDraft]);

  const refreshUsage = useCallback(() => {
    api
      .getUsage()
      .then(setUsage)
      .catch(() => {});
  }, []);

  const refreshConfig = useCallback(() => {
    api
      .getConfig()
      .then(setConfig)
      .catch((err) => setError((err as Error).message));
  }, []);

  const runCopilotProbe = useCallback(async () => {
    setCopilotProbe({ kind: 'probing' });
    try {
      const res = await api.testProvider('copilot');
      if (res.ok) setCopilotProbe({ kind: 'ok' });
      else setCopilotProbe({ kind: 'fail', error: res.error });
    } catch (err) {
      setCopilotProbe({ kind: 'fail', error: (err as Error).message });
    }
    // Fire-and-forget identity fetch — drives the "Signed in as …" line.
    // Failures just leave the login null and the UI falls back to generic copy.
    try {
      const who = await api.getCopilotUser();
      setCopilotLogin(who.ok ? (who.status.login ?? null) : null);
    } catch {
      setCopilotLogin(null);
    }
  }, []);

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((err) => setError((err as Error).message));
    refreshConfig();
    refreshUsage();
    api
      .listGezels()
      .then((res) => setGezels(res.gezels))
      .catch(() => {});
    const interval = setInterval(refreshUsage, 15_000);
    return () => clearInterval(interval);
  }, [refreshUsage, refreshConfig]);

  useEffect(() => {
    if (section === 'copilot' && copilotProbe.kind === 'idle') {
      void runCopilotProbe();
    }
  }, [section, copilotProbe.kind, runCopilotProbe]);

  // Cross-view deep links can jump straight to a Settings section via a
  // `gezel:navigate` event carrying
  // `{ view: 'settings', section: 'defaults' }`.
  useEffect(() => {
    const valid = new Set<SectionId>([
      'general',
      'deviceIntegration',
      'team',
      'folders',
      'defaults',
      'llamaCpp',
      'mlx',
      'ds4',
      'copilot',
      'openai',
      'codexCli',
      'anthropic',
      'anthropicCli',
      'ollama',
      'imageEngine',
      'webSearch',
      'channels',
      'toolsets',
      'knowledge',
      'securityCompliance',
      'about',
    ]);
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: string; section?: string }>).detail;
      if (detail?.view === 'settings' && detail.section && valid.has(detail.section as SectionId)) {
        setSection(detail.section as SectionId);
      }
    };
    window.addEventListener('gezel:navigate', onNav);
    return () => window.removeEventListener('gezel:navigate', onNav);
  }, []);

  // Channels sits in the work-in-progress bucket, so a deep link or a
  // still-open Channels panel can outlive the opt-in it depends on. Wait for
  // config to load before deciding, or the first paint bounces the user out.
  useEffect(() => {
    if (section === 'channels' && config && config.showWorkInProgressFeatures !== true) {
      setSection('general');
    }
  }, [section, config]);

  const setMeester = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ meesterGezelId: id });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus('meester updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const createNewMeester = useCallback(async (name?: string) => {
    setStatus('creating new meester…');
    try {
      const res = await api.createNewMeester(name?.trim() ? { name: name.trim() } : {});
      setConfig(res.config);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res.config }));
      window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: res.gezel }));
      setGezels((prev) => {
        // Merge the created gezel into the list (prepend so it's visible).
        const summary = {
          id: res.gezel.id,
          name: res.gezel.name,
          updatedAt: res.gezel.updatedAt,
          description: res.gezel.description,
          role: res.gezel.role,
          icon: res.gezel.icon,
        };
        const filtered = prev.filter((g) => g.id !== res.gezel.id);
        return [summary, ...filtered];
      });
      setStatus(`created & activated meester "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
    }
  }, []);

  const setKlerk = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ klerkGezelId: id });
      setConfig(res);
      setStatus('klerk updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const createNewKlerk = useCallback(async (name?: string) => {
    setStatus('creating new klerk…');
    try {
      const res = await api.createNewKlerk(name?.trim() ? { name: name.trim() } : {});
      setConfig(res.config);
      setGezels((prev) => {
        const summary = {
          id: res.gezel.id,
          name: res.gezel.name,
          updatedAt: res.gezel.updatedAt,
          description: res.gezel.description,
          role: res.gezel.role,
          icon: res.gezel.icon,
        };
        const filtered = prev.filter((g) => g.id !== res.gezel.id);
        return [summary, ...filtered];
      });
      setStatus(`created & activated klerk "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
    }
  }, []);

  const setBoekwachter = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ boekwachterGezelId: id });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus('boekwachter updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const createNewBoekwachter = useCallback(async (name?: string) => {
    setStatus('creating new boekwachter…');
    try {
      const res = await api.createNewBoekwachter(name?.trim() ? { name: name.trim() } : {});
      setConfig(res.config);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res.config }));
      window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: res.gezel }));
      setGezels((prev) => {
        const summary = {
          id: res.gezel.id,
          name: res.gezel.name,
          updatedAt: res.gezel.updatedAt,
          description: res.gezel.description,
          role: res.gezel.role,
          templateId: res.gezel.templateId,
          icon: res.gezel.icon,
          poppetje: res.gezel.poppetje,
          iconOverride: res.gezel.iconOverride,
        };
        const filtered = prev.filter((gezel) => gezel.id !== res.gezel.id);
        return [summary, ...filtered];
      });
      setStatus(`created & activated boekwachter "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
    }
  }, []);

  const setKeurmeester = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ keurmeesterGezelId: id });
      setConfig(res);
      setStatus('keurmeester updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const createNewKeurmeester = useCallback(async (name?: string) => {
    setStatus('creating new keurmeester…');
    try {
      const res = await api.createNewKeurmeester(name?.trim() ? { name: name.trim() } : {});
      setConfig(res.config);
      setGezels((prev) => {
        const summary = {
          id: res.gezel.id,
          name: res.gezel.name,
          updatedAt: res.gezel.updatedAt,
          description: res.gezel.description,
          role: res.gezel.role,
          icon: res.gezel.icon,
        };
        const filtered = prev.filter((g) => g.id !== res.gezel.id);
        return [summary, ...filtered];
      });
      setStatus(`created & activated keurmeester "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
    }
  }, []);

  const saveKeurmeesterConfig = useCallback(
    async (patch: NonNullable<ConfigResponse['keurmeester']>) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          keurmeester: { ...(config?.keurmeester ?? {}), ...patch },
        });
        setConfig(res);
        setStatus('');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config],
  );

  const setProvider = useCallback(async (provider: ProviderName) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ provider });
      setConfig(res);
      setStatus('saved — open chats restart on their next message.');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveDebugMode = useCallback(async (debugMode: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ debugMode });
      setConfig(res);
      setStatus(debugMode ? 'debug mode ON — verbose logs in ~/.gezel/logs/' : 'debug mode OFF');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveResetTemplatesOnStartup = useCallback(async (resetTemplatesOnStartup: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ resetTemplatesOnStartup });
      setConfig(res);
      setStatus(
        resetTemplatesOnStartup
          ? 'gezel templates will reset to defaults on each startup'
          : 'startup template reset off',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveShowAdvancedFeatures = useCallback(async (showAdvancedFeatures: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ showAdvancedFeatures });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(
        showAdvancedFeatures
          ? 'advanced features ON — Scripts is now in the sidebar'
          : 'advanced features OFF',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveShowWorkInProgressFeatures = useCallback(
    async (showWorkInProgressFeatures: boolean) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ showWorkInProgressFeatures });
        setConfig(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus(
          showWorkInProgressFeatures
            ? 'very early work-in-progress features ON'
            : 'very early work-in-progress features OFF',
        );
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

  const resetTemplatesNow = useCallback(async () => {
    if (
      !window.confirm(
        'Reset all template-based gezellen back to their default instructions? Any edits you have made to their About section will be lost.',
      )
    ) {
      return;
    }
    setStatus('resetting templates…');
    try {
      const res = await api.resetGezelTemplates();
      const n = res.reset.length;
      setStatus(`reset ${n} gezel${n === 1 ? '' : 's'} to template defaults`);
    } catch (err) {
      setStatus(`reset failed: ${(err as Error).message}`);
    }
  }, []);

  const saveShowSystemTray = useCallback(async (showSystemTray: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ showSystemTray });
      setConfig(res);
      // Dispatch so the Electron main process (via the preload bridge)
      // creates or destroys the tray live, without an app restart.
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(showSystemTray ? 'system tray enabled' : 'system tray disabled');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveAutoUpdateChecks = useCallback(async (autoUpdateChecks: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ autoUpdateChecks });
      setConfig(res);
      setStatus(
        autoUpdateChecks ? 'automatic update checks enabled' : 'automatic update checks disabled',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveQuitOnClose = useCallback(async (quitOnClose: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ quitOnClose });
      setConfig(res);
      // Push to the Electron main process so the close-button behavior
      // changes live, without an app restart.
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(
        quitOnClose
          ? 'close button quits Gezel'
          : window.__GEZEL__?.platform === 'darwin'
            ? 'close button keeps Gezel running'
            : 'close button keeps Gezel in the tray',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveNightShift = useCallback(
    async (patch: {
      enabled?: boolean;
      window?: { startHour: number; endHour: number };
      keepAwakeWhileRunning?: boolean;
      wakeOnStart?: boolean;
      modelOverride?: {
        enabled?: boolean;
        provider?: ProviderName;
        model?: string;
      };
      quotaReserve?: {
        overall?: { enabled?: boolean; percent?: number };
        perDay?: { enabled?: boolean; percent?: number };
      };
    }) => {
      setStatus('saving…');
      try {
        const next = { ...(config?.nightShift ?? {}), ...patch };
        const res = await api.updateConfig({ nightShift: next });
        setConfig(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus('Night Shift settings saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.nightShift],
  );

  const saveNightShiftModelOverride = useCallback(
    async (
      patch: Partial<NonNullable<NonNullable<ConfigResponse['nightShift']>['modelOverride']>>,
    ) => {
      const current = config?.nightShift?.modelOverride ?? {};
      await saveNightShift({
        modelOverride: {
          ...current,
          provider: current.provider ?? config?.provider ?? UI_FALLBACK_PROVIDER,
          ...patch,
        },
      });
    },
    [config?.nightShift?.modelOverride, config?.provider, saveNightShift],
  );

  const saveNightShiftQuotaReserve = useCallback(
    async (rule: 'overall' | 'perDay', patch: { enabled?: boolean; percent?: number }) => {
      // Spread every level: the store merges config shallowly, so the whole
      // nested object must round-trip with the sibling rule intact.
      const current = config?.nightShift?.quotaReserve ?? {};
      await saveNightShift({
        quotaReserve: { ...current, [rule]: { ...(current[rule] ?? {}), ...patch } },
      });
    },
    [config?.nightShift?.quotaReserve, saveNightShift],
  );

  const saveRoleBasedNameOnlyMode = useCallback(async (roleBasedNameOnlyMode: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ roleBasedNameOnlyMode });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(
        roleBasedNameOnlyMode
          ? 'boring mode ON — gezels show their role-based names'
          : 'boring mode OFF — friendly names restored',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveShowPoppetjes = useCallback(async (showPoppetjes: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ showPoppetjes });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(
        showPoppetjes
          ? 'poppetjes ON — avatars shown across the UI'
          : 'poppetjes OFF — avatars hidden',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const openLogsFolder = useCallback(async () => {
    const open = window.__GEZEL__?.openLogsFolder;
    if (!open) {
      setStatus(
        'Open the folder yourself: the logs live under ~/.gezel/logs/ (this affordance needs the Electron shell).',
      );
      return;
    }
    const err = await open().catch((e) => String(e));
    if (err) setStatus(`couldn't open logs folder: ${err}`);
  }, []);

  const saveGitHubToken = useCallback(async () => {
    if (!tokenDraft.trim()) return;
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ githubToken: tokenDraft.trim() });
      setConfig(res);
      setTokenDraft('');
      setStatus('saved — any open chat threads have been reset');
      void runCopilotProbe();
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, [tokenDraft, runCopilotProbe]);

  const clearGitHubToken = useCallback(async () => {
    setStatus('clearing…');
    try {
      const res = await api.updateConfig({ githubToken: '' });
      setConfig(res);
      setTokenDraft('');
      setStatus('GitHub token cleared');
      void runCopilotProbe();
    } catch (err) {
      setStatus(`clear failed: ${(err as Error).message}`);
    }
  }, [runCopilotProbe]);

  const saveOpenaiKey = useCallback(async () => {
    if (!openaiKeyDraft.trim()) return;
    setStatus('saving…');
    try {
      const res = await api.updateConfig({
        openaiApiKey: openaiKeyDraft.trim(),
        ...(openaiOrgDraft.trim() ? { openaiOrganization: openaiOrgDraft.trim() } : {}),
      });
      setConfig(res);
      setOpenaiKeyDraft('');
      setStatus('saved — any open chat threads have been reset');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, [openaiKeyDraft, openaiOrgDraft]);

  const clearOpenaiKey = useCallback(async () => {
    setStatus('clearing…');
    try {
      const res = await api.updateConfig({ openaiApiKey: '' });
      setConfig(res);
      setOpenaiKeyDraft('');
      setStatus('OpenAI key cleared');
    } catch (err) {
      setStatus(`clear failed: ${(err as Error).message}`);
    }
  }, []);

  const saveAnthropicKey = useCallback(async () => {
    if (!anthropicKeyDraft.trim()) return;
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ anthropicApiKey: anthropicKeyDraft.trim() });
      setConfig(res);
      setAnthropicKeyDraft('');
      setStatus('saved — any open chat threads have been reset');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, [anthropicKeyDraft]);

  const clearAnthropicKey = useCallback(async () => {
    setStatus('clearing…');
    try {
      const res = await api.updateConfig({ anthropicApiKey: '' });
      setConfig(res);
      setAnthropicKeyDraft('');
      setStatus('Anthropic key cleared');
    } catch (err) {
      setStatus(`clear failed: ${(err as Error).message}`);
    }
  }, []);

  const saveBraveKey = useCallback(async () => {
    if (!braveKeyDraft.trim()) return;
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ braveSearchApiKey: braveKeyDraft.trim() });
      setConfig(res);
      setBraveKeyDraft('');
      setStatus('Brave Search key saved');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, [braveKeyDraft]);

  const clearBraveKey = useCallback(async () => {
    setStatus('clearing…');
    try {
      const res = await api.updateConfig({ braveSearchApiKey: '' });
      setConfig(res);
      setBraveKeyDraft('');
      setStatus('Brave Search key cleared');
    } catch (err) {
      setStatus(`clear failed: ${(err as Error).message}`);
    }
  }, []);

  const saveWebSearchProvider = useCallback(
    async (next: WebSearchProviderSetting) => {
      setStatus('saving…');
      try {
        const provider = next === 'unset' ? undefined : next;
        const res = await api.updateConfig({
          webSearch: { ...(config?.webSearch ?? {}), provider },
        });
        setConfig(res);
        setStatus('saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.webSearch],
  );

  const saveWebSearchFallback = useCallback(
    async (next: 'brave' | 'wikipedia' | 'unset') => {
      setStatus('saving…');
      try {
        const fallbackProvider = next === 'unset' ? undefined : next;
        const res = await api.updateConfig({
          webSearch: { ...(config?.webSearch ?? {}), fallbackProvider },
        });
        setConfig(res);
        setStatus('saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.webSearch],
  );

  const saveDefaultModel = useCallback(
    async (
      which:
        | 'copilot'
        | 'openai'
        | 'anthropic'
        | 'anthropic-cli'
        | 'codex-cli'
        | 'ollama'
        | 'llama-cpp'
        | 'mlx'
        | 'ds4',
      value: string | undefined,
    ) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          defaultModel: {
            ...(config?.defaultModel ?? {}),
            [which]: value,
          },
        });
        setConfig(res);
        setStatus(`default ${which} model saved`);
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config],
  );

  const saveDefaultEffort = useCallback(
    async (
      which: 'copilot' | 'openai' | 'anthropic' | 'anthropic-cli' | 'codex-cli' | 'ollama',
      value: string | undefined,
    ) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          defaultReasoningEffort: {
            ...(config?.defaultReasoningEffort ?? {}),
            [which]: value,
          },
        });
        setConfig(res);
        setStatus(`default ${which} effort saved`);
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config],
  );

  const saveAnthropicCliConcurrency = useCallback(
    async (value: number | undefined) => {
      setStatus('saving…');
      try {
        const next = { ...(config?.providerConcurrency ?? {}) };
        if (value === undefined) {
          delete next['anthropic-cli'];
        } else {
          next['anthropic-cli'] = value;
        }
        const res = await api.updateConfig({ providerConcurrency: next });
        setConfig(res);
        setStatus('Claude CLI concurrency saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.providerConcurrency],
  );

  const saveAnthropicCli = useCallback(
    async (patch: Partial<NonNullable<ConfigResponse['anthropicCli']>>) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          anthropicCli: { ...(config?.anthropicCli ?? {}), ...patch },
        });
        setConfig(res);
        setStatus('Claude CLI settings saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.anthropicCli],
  );

  const [anthropicCliBinaryDraft, setAnthropicCliBinaryDraft] = useState<string>('');
  useEffect(() => {
    setAnthropicCliBinaryDraft(config?.anthropicCli?.binaryPath ?? '');
  }, [config?.anthropicCli?.binaryPath]);

  const [anthropicCliProbe, setAnthropicCliProbe] = useState<
    | { kind: 'idle' }
    | { kind: 'probing' }
    | { kind: 'ok'; modelCount: number }
    | { kind: 'fail'; error: string }
  >({ kind: 'idle' });
  const runAnthropicCliProbe = useCallback(async () => {
    setAnthropicCliProbe({ kind: 'probing' });
    try {
      const res = await api.testProvider('anthropic-cli');
      if (res.ok) setAnthropicCliProbe({ kind: 'ok', modelCount: res.modelCount });
      else setAnthropicCliProbe({ kind: 'fail', error: res.error });
    } catch (err) {
      setAnthropicCliProbe({ kind: 'fail', error: (err as Error).message });
    }
  }, []);

  const saveCodexCli = useCallback(
    async (patch: Partial<NonNullable<ConfigResponse['codexCli']>>) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          codexCli: { ...(config?.codexCli ?? {}), ...patch },
        });
        setConfig(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus('Codex CLI settings saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config?.codexCli],
  );

  const [codexCliBinaryDraft, setCodexCliBinaryDraft] = useState<string>('');
  useEffect(() => {
    setCodexCliBinaryDraft(config?.codexCli?.binaryPath ?? '');
  }, [config?.codexCli?.binaryPath]);

  const [codexCliProbe, setCodexCliProbe] = useState<
    | { kind: 'idle' }
    | { kind: 'probing' }
    | { kind: 'ok'; modelCount: number }
    | { kind: 'fail'; error: string }
  >({ kind: 'idle' });
  const runCodexCliProbe = useCallback(async () => {
    setCodexCliProbe({ kind: 'probing' });
    try {
      const res = await api.testProvider('codex-cli');
      if (res.ok) setCodexCliProbe({ kind: 'ok', modelCount: res.modelCount });
      else setCodexCliProbe({ kind: 'fail', error: res.error });
    } catch (err) {
      setCodexCliProbe({ kind: 'fail', error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    if (section === 'anthropicCli') void runAnthropicCliProbe();
  }, [section, runAnthropicCliProbe]);
  useEffect(() => {
    if (section === 'codexCli') void runCodexCliProbe();
  }, [section, runCodexCliProbe]);

  const saveToolFilterMode = useCallback(async (mode: 'always' | 'never' | 'small-model') => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ toolFilterMode: mode });
      setConfig(res);
      setStatus('tool filter mode saved');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveEngagementMode = useCallback(
    async (mode: 'proactive' | 'scheduled' | 'reactive' | 'off') => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ aiEngagementMode: mode });
        setConfig(res);
        setStatus(`AI engagement: ${mode}`);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

  const saveWorkshopTempo = useCallback(
    async (tempo: 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel') => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ workshopTempo: tempo });
        setConfig(res);
        setStatus(`tempo: ${tempo}`);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

  const setRetrieval = useCallback(
    async (
      patch: Omit<Partial<NonNullable<ConfigResponse['retrieval']>>, 'maxTokens'> & {
        maxTokens?: number | null;
      },
    ) => {
      setStatus('saving…');
      try {
        const current = config?.retrieval ?? { mode: 'balanced' as const };
        const { maxTokens: _currentMaxTokens, ...withoutMaxTokens } = current;
        const { maxTokens, ...rest } = patch;
        const retrieval =
          maxTokens === null
            ? { ...withoutMaxTokens, ...rest }
            : { ...current, ...rest, ...(maxTokens === undefined ? {} : { maxTokens }) };
        const res = await api.updateConfig({ retrieval });
        setConfig(res);
        setStatus('indexed context settings saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config],
  );

  const setSummarization = useCallback(
    async (patch: Partial<NonNullable<ConfigResponse['summarization']>>) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({
          summarization: { ...(config?.summarization ?? {}), ...patch },
        });
        setConfig(res);
        setStatus('summarization settings saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [config],
  );

  const provider: ProviderName = config?.provider ?? UI_FALLBACK_PROVIDER;
  const nightShiftModelOverride = config?.nightShift?.modelOverride;
  const nightShiftProvider: ProviderName = nightShiftModelOverride?.provider ?? provider;
  const hasGithubToken = config?.hasGithubToken ?? false;
  const hasOpenaiKey = config?.hasOpenaiApiKey ?? false;
  const hasAnthropicKey = config?.hasAnthropicApiKey ?? false;
  const copilotUsage = usage?.providers.copilot;
  const copilotAvailability = useCopilotAvailability();
  const totalRamBytes = useTotalRamBytes();
  const openaiUsage = usage?.providers.openai;
  // The Electron bridge is authoritative when present; health keeps the
  // platform-aware navigation correct in the standalone web UI too.
  const uiPlatform = window.__GEZEL__?.platform ?? health?.platform;
  const isDarwin = uiPlatform === 'darwin';

  // Primary "this device" pill for the default-provider picker.
  // Mac steers to MLX; everything else steers to llama.cpp.
  const onDeviceProvider: ProviderName = isDarwin ? 'mlx' : 'llama-cpp';
  const mlxTabLabel = localEngineSettingsLabel('mlx', uiPlatform);
  const llamaCppTabLabel = localEngineSettingsLabel('llama-cpp', uiPlatform);
  const ds4TabLabel = localEngineSettingsLabel('ds4', uiPlatform);
  const onDeviceLabel = isDarwin ? mlxTabLabel : llamaCppTabLabel;

  // DwarfStar (ds4) is a separate on-device engine with hard platform
  // constraints (Apple-Silicon Metal / Linux CUDA; no Intel-Mac or Windows
  // build). Offer it as a default-provider option only where it can actually
  // run — or wherever the user has already selected it, so a config-set
  // provider never strands them without the pill to change it.
  // The RAM floor is part of that constraint set: a machine under 48 GB can
  // technically launch the engine but can't stream its models at a usable
  // speed. `totalRamBytes` is null until the probe answers, and the helper
  // skips the check then rather than reading unknown as too-small.
  const showDs4Provider =
    provider === 'ds4' ||
    nightShiftProvider === 'ds4' ||
    detectDs4Availability({
      externalBaseUrl: config?.ds4BaseUrl,
      totalRamBytes: totalRamBytes ?? undefined,
    }).status !== 'unavailable';

  // GitHub Copilot needs GitHub's proprietary CLI, which we don't ship — it's
  // an opt-in download from the Copilot tab. Don't offer it as a provider
  // until it can actually run. `!== false` rather than `=== true`: the hook
  // returns null while loading, and treating that as unavailable would make
  // the option blink out on every mount. As with ds4 above, an already-chosen
  // Copilot stays on offer so a configured user is never stranded.
  const showCopilotProvider =
    provider === 'copilot' ||
    nightShiftProvider === 'copilot' ||
    copilotAvailability?.available !== false;

  // The API-key OpenAI and Anthropic surfaces are untested and stay hidden for
  // now; their CLI counterparts (codex-cli, anthropic-cli) are unaffected and
  // remain on offer. Same escape hatch as ds4/Copilot above: an already-chosen
  // provider — or one that already has a key on file — keeps its tab and pill
  // so a configured user is never stranded without a way to change it.
  const showOpenaiProvider =
    provider === 'openai' || nightShiftProvider === 'openai' || hasOpenaiKey;
  const showAnthropicProvider =
    provider === 'anthropic' || nightShiftProvider === 'anthropic' || hasAnthropicKey;

  const nightShiftProviderChoices: Array<{
    id: ProviderName;
    label: string;
    title?: string;
  }> = [
    {
      id: onDeviceProvider,
      label: onDeviceLabel,
      title: 'Run models directly on this device — weights live on disk, with no cloud round-trip.',
    },
    ...(isDarwin
      ? [
          {
            id: 'llama-cpp' as const,
            label: llamaCppTabLabel,
            title: 'Use the llama.cpp runtime for Night Shift work.',
          },
        ]
      : []),
    ...(showDs4Provider
      ? [
          {
            id: 'ds4' as const,
            label: ds4TabLabel,
            title: 'Use the DwarfStar (ds4) engine for Night Shift work.',
          },
        ]
      : []),
    ...(showCopilotProvider ? [{ id: 'copilot' as const, label: 'GitHub Copilot' }] : []),
    ...(showOpenaiProvider ? [{ id: 'openai' as const, label: 'OpenAI' }] : []),
    { id: 'codex-cli', label: 'OpenAI Codex CLI' },
    ...(showAnthropicProvider ? [{ id: 'anthropic' as const, label: 'Anthropic Claude' }] : []),
    { id: 'anthropic-cli', label: 'Anthropic Claude CLI' },
    { id: 'ollama', label: 'Ollama' },
  ];

  const sections = useMemo(() => {
    const all = buildSections(uiPlatform);
    return all.filter((s) => {
      if (s.id === 'mlx' && !isDarwin) return false;
      // Keep the section available for supported native installs, configured
      // external servers, and an already-selected provider. The latter two
      // matter on Windows, where ds4 has no native build but remains usable
      // through an external server.
      if (s.id === 'ds4' && !showDs4Provider) return false;
      if (s.id === 'openai' && !showOpenaiProvider) return false;
      if (s.id === 'anthropic' && !showAnthropicProvider) return false;
      // Benchmarks is a debug-only surface — hidden until the user turns on
      // Debug mode under the About tab.
      if (s.id === 'benchmarks' && config?.debugMode !== true) return false;
      // Channels is in the work-in-progress bucket alongside connectors —
      // hidden until the user opts in under About.
      if (s.id === 'channels' && config?.showWorkInProgressFeatures !== true) return false;
      return true;
    });
  }, [
    uiPlatform,
    isDarwin,
    showDs4Provider,
    showOpenaiProvider,
    showAnthropicProvider,
    config?.debugMode,
    config?.showWorkInProgressFeatures,
  ]);

  const activeSectionGroup = useMemo(
    () => sections.find((s) => s.id === section)?.group,
    [sections, section],
  );

  const flatPanel =
    activeSectionGroup === 'ai' ||
    section === 'imageEngine' ||
    section === 'videoEngine' ||
    section === 'imageRecognition' ||
    section === 'audio' ||
    section === 'webSearch' ||
    section === 'channels';

  return (
    <div className="settings-layout">
      <aside className="settings-nav">
        <h2>Settings</h2>
        <ul>
          {sections.map((s) => {
            // Hide children of a collapsed group.
            if (s.group && collapsedGroups.has(s.group)) return null;

            // Group header: a disclosure chevron that toggles the group, plus
            // the label. The AI header doubles as a real section ('defaults')
            // so its label navigates; the header-only 'Workloads' label just
            // toggles.
            if (s.groupHeader) {
              const collapsed = collapsedGroups.has(s.groupHeader);
              const navigates = s.id !== 'workloads';
              return (
                <li key={s.id} className="settings-nav-li settings-nav-li-group">
                  <button
                    type="button"
                    className="settings-nav-group-toggle"
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${s.label}`}
                    onClick={() => toggleGroup(s.groupHeader as SettingsGroup)}
                  >
                    <span className="settings-nav-caret" aria-hidden="true">
                      &rsaquo;
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid={`settings-nav-${s.id}`}
                    className={`settings-nav-item settings-nav-group-label${section === s.id ? ' settings-nav-item-active' : ''}`}
                    onClick={() =>
                      navigates ? setSection(s.id) : toggleGroup(s.groupHeader as SettingsGroup)
                    }
                  >
                    {s.label}
                  </button>
                </li>
              );
            }

            return (
              <li
                key={s.id}
                className={s.group ? 'settings-nav-li settings-nav-li-child' : 'settings-nav-li'}
              >
                <button
                  type="button"
                  data-testid={`settings-nav-${s.id}`}
                  className={`settings-nav-item${s.group ? ' settings-nav-item-child' : ''}${section === s.id ? ' settings-nav-item-active' : ''}`}
                  onClick={() => setSection(s.id)}
                >
                  {s.label}
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div
        className={`settings-panel${flatPanel ? ' settings-panel-flat' : ''}`}
        data-testid={`settings-section-${section}`}
      >
        {section === 'general' && (
          <>
            <section style={{ marginBottom: '2rem' }}>
              <h3>System Health</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                What's running under the hood — the local daemon, your Node runtime, the OS, and the
                system browser toolset used for web actions.
              </p>
              <HealthStrip />
            </section>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Appearance</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Light or dark mode, or follow the OS.
              </p>
              <ThemePicker />
            </section>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Sidebar position</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Which side the navigation rail (projects, gezellen, documents…) sits on.
              </p>
              <SidebarSidePicker />
            </section>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Boring mode</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Hide friendly names everywhere. Each gezel shows only their role-based name (e.g.{' '}
                <code>visual-designer</code> instead of "Mira"), and titles like "Meester" are
                dropped from headers. The same name flows into system prompts and chat handoffs, so
                the model addresses itself by role.
              </p>
              <label className="debug-toggle">
                <input
                  type="checkbox"
                  checked={config?.roleBasedNameOnlyMode === true}
                  onChange={(e) => void saveRoleBasedNameOnlyMode(e.target.checked)}
                />
                <span>Use role-based names only</span>
              </label>
              <p className="muted" style={{ marginBottom: 0 }}>
                Poppetjes are the little character figures shown beside each gezel — like your
                meester's here. Turn them off to fall back to a plain letter avatar everywhere.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                {/* UI-level inversion only: the persisted flag stays
                    `showPoppetjes` (true = shown). The checkbox reads/writes
                    its negation so the label can be the more natural "Hide". */}
                <label className="debug-toggle" style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={config?.showPoppetjes === false}
                    onChange={(e) => void saveShowPoppetjes(!e.target.checked)}
                  />
                  <span>Hide poppetjes</span>
                </label>
                {(() => {
                  const meester = gezels.find((g) => g.id === config?.meesterGezelId);
                  return meester?.poppetje ? (
                    // Wrap in `.gezel-icon` so the figure is clipped to a small
                    // box — a bare <Poppetje> paints its full body because the
                    // SVG is overflow:visible.
                    <div
                      className="gezel-icon"
                      style={{ width: 40, height: 40 }}
                      title={`example poppetje — ${meester.name}`}
                    >
                      <div className="gezel-icon-poppetje">
                        <Poppetje poppetje={meester.poppetje} variant="headshot" size={40} />
                      </div>
                    </div>
                  ) : null;
                })()}
              </div>
            </section>
            <section style={{ marginTop: '2rem' }}>
              <h3>Night Shift</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                During a nightly window, Gezel runs deferred batch work — content indexing and a
                daily Meester review of every active project (with suggestions waiting for you in
                the morning). Interactive and scheduled work always takes priority.
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={config?.nightShift?.enabled !== false}
                  onChange={(e) => void saveNightShift({ enabled: e.target.checked })}
                />
                <span>Enable Night Shift</span>
              </label>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.6rem',
                  flexWrap: 'wrap',
                }}
              >
                <span className="muted" style={{ fontSize: '0.9rem' }}>
                  Window
                </span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={config?.nightShift?.window?.startHour ?? 22}
                  onChange={(e) =>
                    void saveNightShift({
                      window: {
                        startHour: clampHour(e.target.value, 22),
                        endHour: config?.nightShift?.window?.endHour ?? 6,
                      },
                    })
                  }
                  style={{ width: '4rem' }}
                  aria-label="Night Shift start hour"
                />
                <span className="muted" style={{ fontSize: '0.9rem' }}>
                  to
                </span>
                <input
                  type="number"
                  min={0}
                  max={23}
                  value={config?.nightShift?.window?.endHour ?? 6}
                  onChange={(e) =>
                    void saveNightShift({
                      window: {
                        startHour: config?.nightShift?.window?.startHour ?? 22,
                        endHour: clampHour(e.target.value, 6),
                      },
                    })
                  }
                  style={{ width: '4rem' }}
                  aria-label="Night Shift end hour"
                />
                <span className="muted" style={{ fontSize: '0.8rem' }}>
                  (local 24-hour; wraps past midnight)
                </span>
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.6rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={config?.nightShift?.keepAwakeWhileRunning === true}
                  onChange={(e) => void saveNightShift({ keepAwakeWhileRunning: e.target.checked })}
                />
                <span>Keep this machine awake while night-shift work is running</span>
              </label>
              {isDarwin && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginTop: '0.4rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={config?.nightShift?.wakeOnStart === true}
                    onChange={(e) => void saveNightShift({ wakeOnStart: e.target.checked })}
                  />
                  <span>Wake this machine when the window opens</span>
                </label>
              )}
            </section>
            <section style={{ marginTop: '2rem' }}>
              <h3>Night shift cloud quota reserve</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                For Claude, Codex, and Copilot subscriptions, run the night shift only until:
              </p>
              <label
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}
              >
                <input
                  type="checkbox"
                  checked={config?.nightShift?.quotaReserve?.overall?.enabled !== false}
                  onChange={(e) =>
                    void saveNightShiftQuotaReserve('overall', { enabled: e.target.checked })
                  }
                  aria-label="Stop night work near my overall quota"
                />
                <span>I’m within</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={config?.nightShift?.quotaReserve?.overall?.percent ?? 20}
                  onChange={(e) =>
                    void saveNightShiftQuotaReserve('overall', {
                      percent: clampPercent(e.target.value, 20),
                    })
                  }
                  style={{ width: '2.5rem' }}
                  disabled={config?.nightShift?.quotaReserve?.overall?.enabled === false}
                  aria-label="Overall quota floor percent"
                />
                <span>% of my overall quota</span>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  marginTop: '0.4rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={config?.nightShift?.quotaReserve?.perDay?.enabled === true}
                  onChange={(e) =>
                    void saveNightShiftQuotaReserve('perDay', { enabled: e.target.checked })
                  }
                  aria-label="Reserve a share of my quota per day until reset"
                />
                <span>It would dip into a reserve of</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={config?.nightShift?.quotaReserve?.perDay?.percent ?? 10}
                  onChange={(e) =>
                    void saveNightShiftQuotaReserve('perDay', {
                      percent: clampPercent(e.target.value, 10),
                    })
                  }
                  style={{ width: '2.5rem' }}
                  disabled={config?.nightShift?.quotaReserve?.perDay?.enabled !== true}
                  aria-label="Daily quota reserve percent"
                />
                <span>% of my quota per day until it resets</span>
              </label>
              <p className="muted small" style={{ margin: '0.35rem 0 0 1.5rem' }}>
                The daily reserve scales with the time left: 10% a day with 4 days until reset keeps
                the last 40% for you. Work already running finishes; held work resumes when your
                quota frees up. Gezels on local models are never held.
              </p>
            </section>
            <section style={{ marginTop: '2rem' }}>
              <h3>Gezel templates</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Restore every gezel created from a template back to the <code>about.md</code> their
                template ships, discarding any edits you’ve made to their instructions. Bespoke
                gezels (written from scratch) are left untouched.
              </p>
              <button type="button" className="subtle" onClick={() => void resetTemplatesNow()}>
                Reset to defaults
              </button>
            </section>
          </>
        )}

        {section === 'deviceIntegration' && (
          <>
            <section>
              <h3>System tray</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Keep a Gezel icon in the {isDarwin ? 'menu bar' : 'system tray'} for at-a-glance
                status, notifications, and a quick engagement-mode toggle. When on
                {isDarwin
                  ? ''
                  : ', closing the window keeps Gezel running in the tray (quit from the tray menu)'}
                .
              </p>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input
                  type="checkbox"
                  checked={config?.showSystemTray !== false}
                  onChange={(e) => void saveShowSystemTray(e.target.checked)}
                />
                <span>Show the tray icon</span>
              </label>
              {/* Close-to-tray opt-out. Only relevant when the tray is on, and
                  only on Windows/Linux — macOS keeps the app alive on close
                  regardless, so the toggle would be a no-op there. */}
              {config?.showSystemTray !== false && !isDarwin && (
                <label
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={config?.quitOnClose === true}
                    onChange={(e) => void saveQuitOnClose(e.target.checked)}
                  />
                  <span>Remove the tray icon on close</span>
                </label>
              )}
            </section>
            {/* Mac-only: by convention macOS keeps the app running after the
                window closes. This opt-in makes the red X quit Gezel entirely,
                matching Windows. Off by default; independent of the tray. */}
            {isDarwin && (
              <section style={{ marginTop: '2rem' }}>
                <h3>Close button</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  By default macOS keeps Gezel running when you close the window. Turn this on to
                  quit Gezel entirely when you click the red close button.
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={config?.quitOnClose === true}
                    onChange={(e) => void saveQuitOnClose(e.target.checked)}
                  />
                  <span>Quit Gezel when the window is closed.</span>
                </label>
              </section>
            )}
            <div style={{ marginTop: '2rem' }}>
              <AmbientDashboardCard />
            </div>
          </>
        )}

        {section === 'team' && (
          <>
            <EngagementModePanel
              mode={config?.aiEngagementMode ?? 'proactive'}
              tempo={config?.workshopTempo ?? 'bedrijvig'}
              onChange={saveEngagementMode}
              onTempoChange={saveWorkshopTempo}
            />

            <section style={{ marginBottom: '2rem' }}>
              <h3>Meester</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                The Meester is your team concierge — they help you start new projects, answer
                questions, and check in on projects to keep them moving. Change which gezel wears
                the hat here; their prompt is untouched when you do.
              </p>
              <div className="meester-picker">
                {config?.meesterGezelId &&
                  (() => {
                    const current = gezels.find((g) => g.id === config.meesterGezelId);
                    if (!current) return null;
                    return (
                      <div className="meester-current">
                        <GezelIcon
                          svg={current.icon ?? null}
                          poppetje={current.poppetje}
                          iconOverride={current.iconOverride}
                          name={current.name}
                          size={40}
                        />
                        <div>
                          <div className="meester-current-name">{current.name}</div>
                          {current.role && <div className="muted small">{current.role}</div>}
                        </div>
                      </div>
                    );
                  })()}
                <label className="muted small" style={{ marginTop: '0.5rem', display: 'block' }}>
                  Change meester to:
                </label>
                <Select.Root
                  value={config?.meesterGezelId ?? ''}
                  onValueChange={(v) => {
                    if (v === '__new') {
                      setNewMeesterOpen(true);
                      setNewMeesterName('');
                      return;
                    }
                    void setMeester(v);
                  }}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Select meester…" />
                  </Select.Trigger>
                  <Select.Content>
                    {gezels.map((g) => (
                      <Select.Item key={g.id} value={g.id}>
                        {g.name}
                        {g.role ? ` — ${g.role}` : ''}
                      </Select.Item>
                    ))}
                    <Select.Item value="__new">✨ New Meester gezel…</Select.Item>
                  </Select.Content>
                </Select.Root>

                {newMeesterOpen && (
                  <form
                    className="meester-new-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setNewMeesterBusy(true);
                      try {
                        await createNewMeester(newMeesterName);
                        setNewMeesterOpen(false);
                        setNewMeesterName('');
                      } finally {
                        setNewMeesterBusy(false);
                      }
                    }}
                  >
                    <input
                      placeholder="Name (leave blank for a random pick)"
                      value={newMeesterName}
                      onChange={(e) => setNewMeesterName(e.target.value)}
                      disabled={newMeesterBusy}
                    />
                    <div className="meester-new-form-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setNewMeesterOpen(false);
                          setNewMeesterName('');
                        }}
                        disabled={newMeesterBusy}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="primary" disabled={newMeesterBusy}>
                        {newMeesterBusy ? 'Creating…' : 'Create Meester'}
                      </button>
                    </div>
                    <p className="muted small" style={{ margin: '0.35rem 0 0 0' }}>
                      A brand-new gezel will be spun up with the curated Meester prompt and set as
                      your active guide. You can rename or tune them later in the Gezellen tab.
                    </p>
                  </form>
                )}
              </div>
            </section>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Klerk</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                The Klerk is your workshop scribe — they handle utility text work (about.md drafts,
                rewrites, end-of-thread summaries, memory consolidation) so you can route grunt
                tasks to a different model than your conversational gezellen.
              </p>
              <div className="meester-picker">
                {config?.klerkGezelId &&
                  (() => {
                    const current = gezels.find((g) => g.id === config.klerkGezelId);
                    if (!current) return null;
                    return (
                      <div className="meester-current">
                        <GezelIcon
                          svg={current.icon ?? null}
                          poppetje={current.poppetje}
                          iconOverride={current.iconOverride}
                          name={current.name}
                          size={40}
                        />
                        <div>
                          <div className="meester-current-name">{current.name}</div>
                          {current.role && <div className="muted small">{current.role}</div>}
                        </div>
                      </div>
                    );
                  })()}
                <label className="muted small" style={{ marginTop: '0.5rem', display: 'block' }}>
                  Change klerk to:
                </label>
                <Select.Root
                  value={config?.klerkGezelId ?? ''}
                  onValueChange={(v) => {
                    if (v === '__new') {
                      setNewKlerkOpen(true);
                      setNewKlerkName('');
                      return;
                    }
                    void setKlerk(v);
                  }}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Select klerk…" />
                  </Select.Trigger>
                  <Select.Content>
                    {gezels.map((g) => (
                      <Select.Item key={g.id} value={g.id}>
                        {g.name}
                        {g.role ? ` — ${g.role}` : ''}
                      </Select.Item>
                    ))}
                    <Select.Item value="__new">✨ New Klerk gezel…</Select.Item>
                  </Select.Content>
                </Select.Root>

                {newKlerkOpen && (
                  <form
                    className="meester-new-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setNewKlerkBusy(true);
                      try {
                        await createNewKlerk(newKlerkName);
                        setNewKlerkOpen(false);
                        setNewKlerkName('');
                      } finally {
                        setNewKlerkBusy(false);
                      }
                    }}
                  >
                    <input
                      placeholder="Name (leave blank for a random pick)"
                      value={newKlerkName}
                      onChange={(e) => setNewKlerkName(e.target.value)}
                      disabled={newKlerkBusy}
                    />
                    <div className="meester-new-form-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setNewKlerkOpen(false);
                          setNewKlerkName('');
                        }}
                        disabled={newKlerkBusy}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="primary" disabled={newKlerkBusy}>
                        {newKlerkBusy ? 'Creating…' : 'Create Klerk'}
                      </button>
                    </div>
                    <p className="muted small" style={{ margin: '0.35rem 0 0 0' }}>
                      A fresh gezel will be spun up with the curated Klerk prompt and set as your
                      active scribe. Tune their model in the Gezellen tab to point utility work at
                      Sonnet, a local model, or whatever fits.
                    </p>
                  </form>
                )}
              </div>
            </section>

            <section style={{ marginBottom: '2rem' }} data-testid="boekwachter-settings">
              <h3>Boekwachter</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                The Boekwachter is your workshop&apos;s index-keeper. A project with a Boekwachter
                on its assigned crew gets background AI summaries, file reviews, folder rollups, and
                weekly digests. Remove the role from a project to keep fast structural search
                without those AI passes. Indexing stays local by default; a local provider and model
                selected on this gezel can tune the work.
              </p>
              <div className="meester-picker">
                {config?.boekwachterGezelId &&
                  (() => {
                    const current = gezels.find((gezel) => gezel.id === config.boekwachterGezelId);
                    if (!current) return null;
                    return (
                      <div className="meester-current">
                        <GezelIcon
                          svg={current.icon ?? null}
                          poppetje={current.poppetje}
                          iconOverride={current.iconOverride}
                          name={current.name}
                          size={40}
                        />
                        <div>
                          <div className="meester-current-name">{current.name}</div>
                          {current.role && <div className="muted small">{current.role}</div>}
                        </div>
                      </div>
                    );
                  })()}
                <label className="muted small" style={{ marginTop: '0.5rem', display: 'block' }}>
                  Change boekwachter to:
                </label>
                <Select.Root
                  value={config?.boekwachterGezelId ?? ''}
                  onValueChange={(value) => {
                    if (value === '__new') {
                      setNewBoekwachterOpen(true);
                      setNewBoekwachterName('');
                      return;
                    }
                    void setBoekwachter(value);
                  }}
                >
                  <Select.Trigger>
                    <Select.Value placeholder="Select boekwachter…" />
                  </Select.Trigger>
                  <Select.Content>
                    {gezels.map((gezel) => (
                      <Select.Item key={gezel.id} value={gezel.id}>
                        {gezel.name}
                        {gezel.role ? ` — ${gezel.role}` : ''}
                      </Select.Item>
                    ))}
                    <Select.Item value="__new">New Boekwachter gezel…</Select.Item>
                  </Select.Content>
                </Select.Root>

                {newBoekwachterOpen && (
                  <form
                    className="meester-new-form"
                    onSubmit={async (event) => {
                      event.preventDefault();
                      setNewBoekwachterBusy(true);
                      try {
                        await createNewBoekwachter(newBoekwachterName);
                        setNewBoekwachterOpen(false);
                        setNewBoekwachterName('');
                      } finally {
                        setNewBoekwachterBusy(false);
                      }
                    }}
                  >
                    <input
                      placeholder="Name (leave blank for a random pick)"
                      value={newBoekwachterName}
                      onChange={(event) => setNewBoekwachterName(event.target.value)}
                      disabled={newBoekwachterBusy}
                    />
                    <div className="meester-new-form-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setNewBoekwachterOpen(false);
                          setNewBoekwachterName('');
                        }}
                        disabled={newBoekwachterBusy}
                      >
                        Cancel
                      </button>
                      <button type="submit" className="primary" disabled={newBoekwachterBusy}>
                        {newBoekwachterBusy ? 'Creating…' : 'Create Boekwachter'}
                      </button>
                    </div>
                    <p className="muted small" style={{ margin: '0.35rem 0 0 0' }}>
                      The new gezel uses the canonical gilde Boekwachter personality. Projects
                      assigned to the current Boekwachter transfer to the new one.
                    </p>
                  </form>
                )}
              </div>
            </section>

            {config?.showAdvancedFeatures && (
              <section style={{ marginBottom: '2rem' }} data-testid="keurmeester-settings">
                <h3>Keurmeester</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  The Keurmeester is the guild's quality inspector. When a small on-device model
                  gets stuck — spinning on the same step, going silent, failing the same check over
                  and over — a frontier model is consulted to diagnose the problem and step in: a
                  well-aimed nudge, a rewritten task step, or (at most twice per task) doing the
                  failing step itself and handing the work back.
                </p>
                {config?.keurmeester?.enabled !== true && !keurmeesterConsentOpen && (
                  <button type="button" onClick={() => setKeurmeesterConsentOpen(true)}>
                    Turn on supervision…
                  </button>
                )}
                {config?.keurmeester?.enabled !== true && keurmeesterConsentOpen && (
                  <div className="meester-new-form" data-testid="keurmeester-consent">
                    <p style={{ marginTop: 0 }}>
                      When a local model gets stuck, excerpts of the conversation and task will be
                      sent to{' '}
                      <strong>
                        {config?.keurmeester?.providerName ?? 'the cloud provider you pick'}
                      </strong>{' '}
                      for diagnosis. If you chose a local model for privacy, that trade-off is yours
                      to make — nothing is sent until you turn this on.
                    </p>
                    <div className="meester-new-form-actions">
                      <button type="button" onClick={() => setKeurmeesterConsentOpen(false)}>
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="primary"
                        onClick={() => {
                          setKeurmeesterConsentOpen(false);
                          void saveKeurmeesterConfig({ enabled: true });
                        }}
                      >
                        I understand — enable
                      </button>
                    </div>
                  </div>
                )}
                {config?.keurmeester?.enabled === true && (
                  <>
                    <label
                      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                      className="small"
                    >
                      <input
                        type="checkbox"
                        checked
                        onChange={() => void saveKeurmeesterConfig({ enabled: false })}
                      />
                      Supervision is on — conversation/task excerpts go to the provider below when a
                      local model gets stuck.
                    </label>
                    <div style={{ display: 'flex', gap: '0.75rem', margin: '0.75rem 0' }}>
                      <div>
                        <label className="muted small" style={{ display: 'block' }}>
                          Consult provider
                        </label>
                        <Select.Root
                          value={config?.keurmeester?.providerName ?? ''}
                          onValueChange={(v) =>
                            void saveKeurmeesterConfig({ providerName: v, model: undefined })
                          }
                        >
                          <Select.Trigger>
                            <Select.Value placeholder="Pick a cloud provider…" />
                          </Select.Trigger>
                          <Select.Content>
                            {/* An already-selected Copilot must keep its item
                                even when unavailable, or Radix falls back to
                                the placeholder and the set value looks unset. */}
                            {(showCopilotProvider ||
                              config?.keurmeester?.providerName === 'copilot') && (
                              <Select.Item value="copilot">
                                Copilot{hasGithubToken ? ' ✓' : ''}
                              </Select.Item>
                            )}
                            {(showAnthropicProvider ||
                              config?.keurmeester?.providerName === 'anthropic') && (
                              <Select.Item value="anthropic">
                                Anthropic{hasAnthropicKey ? ' ✓' : ''}
                              </Select.Item>
                            )}
                            {(showOpenaiProvider ||
                              config?.keurmeester?.providerName === 'openai') && (
                              <Select.Item value="openai">
                                OpenAI{hasOpenaiKey ? ' ✓' : ''}
                              </Select.Item>
                            )}
                            <Select.Item value="anthropic-cli">Anthropic CLI</Select.Item>
                            <Select.Item value="codex-cli">Codex CLI</Select.Item>
                          </Select.Content>
                        </Select.Root>
                      </div>
                      {config?.keurmeester?.providerName && (
                        <div>
                          <label className="muted small" style={{ display: 'block' }}>
                            Consult model
                          </label>
                          <ModelPicker
                            provider={config.keurmeester.providerName as ProviderName}
                            value={config?.keurmeester?.model}
                            onChange={(m) => void saveKeurmeesterConfig({ model: m })}
                            placeholder="Provider default"
                          />
                        </div>
                      )}
                    </div>
                    <label
                      style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}
                      className="small"
                    >
                      <input
                        type="checkbox"
                        checked={config?.keurmeester?.allowTakeover !== false}
                        onChange={(e) =>
                          void saveKeurmeesterConfig({ allowTakeover: e.target.checked })
                        }
                      />
                      Allow bounded takeover (the Keurmeester may perform a repeatedly-failing step
                      itself — at most once per step, twice per task — then hand back)
                    </label>
                    <div className="meester-picker" style={{ marginTop: '0.75rem' }}>
                      {config?.keurmeesterGezelId &&
                        (() => {
                          const current = gezels.find((g) => g.id === config.keurmeesterGezelId);
                          if (!current) return null;
                          return (
                            <div className="meester-current">
                              <GezelIcon
                                svg={current.icon ?? null}
                                poppetje={current.poppetje}
                                iconOverride={current.iconOverride}
                                name={current.name}
                                size={40}
                              />
                              <div>
                                <div className="meester-current-name">{current.name}</div>
                                {current.role && <div className="muted small">{current.role}</div>}
                              </div>
                            </div>
                          );
                        })()}
                      {!config?.keurmeesterGezelId && (
                        <p className="muted small" style={{ margin: 0 }}>
                          No Keurmeester gezel yet — one is created automatically on the first
                          intervention, or designate/create one now:
                        </p>
                      )}
                      <label
                        className="muted small"
                        style={{ marginTop: '0.5rem', display: 'block' }}
                      >
                        Change keurmeester to:
                      </label>
                      <Select.Root
                        value={config?.keurmeesterGezelId ?? ''}
                        onValueChange={(v) => {
                          if (v === '__new') {
                            setNewKeurmeesterOpen(true);
                            setNewKeurmeesterName('');
                            return;
                          }
                          void setKeurmeester(v);
                        }}
                      >
                        <Select.Trigger>
                          <Select.Value placeholder="Select keurmeester…" />
                        </Select.Trigger>
                        <Select.Content>
                          {gezels.map((g) => (
                            <Select.Item key={g.id} value={g.id}>
                              {g.name}
                              {g.role ? ` — ${g.role}` : ''}
                            </Select.Item>
                          ))}
                          <Select.Item value="__new">✨ New Keurmeester gezel…</Select.Item>
                        </Select.Content>
                      </Select.Root>

                      {newKeurmeesterOpen && (
                        <form
                          className="meester-new-form"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            setNewKeurmeesterBusy(true);
                            try {
                              await createNewKeurmeester(newKeurmeesterName);
                              setNewKeurmeesterOpen(false);
                              setNewKeurmeesterName('');
                            } finally {
                              setNewKeurmeesterBusy(false);
                            }
                          }}
                        >
                          <input
                            placeholder="Name (leave blank for a random pick)"
                            value={newKeurmeesterName}
                            onChange={(e) => setNewKeurmeesterName(e.target.value)}
                            disabled={newKeurmeesterBusy}
                          />
                          <div className="meester-new-form-actions">
                            <button
                              type="button"
                              onClick={() => {
                                setNewKeurmeesterOpen(false);
                                setNewKeurmeesterName('');
                              }}
                              disabled={newKeurmeesterBusy}
                            >
                              Cancel
                            </button>
                            <button type="submit" className="primary" disabled={newKeurmeesterBusy}>
                              {newKeurmeesterBusy ? 'Creating…' : 'Create Keurmeester'}
                            </button>
                          </div>
                          <p className="muted small" style={{ margin: '0.35rem 0 0 0' }}>
                            A fresh gezel is spun up with the curated inspector prompt and set as
                            your active keurmeester. Their interventions appear in chat and in the
                            History tab.
                          </p>
                        </form>
                      )}
                    </div>
                  </>
                )}
              </section>
            )}
          </>
        )}

        {section === 'folders' && <FoldersSettings />}

        {section === 'defaults' && (
          <>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Default provider</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Which AI chat provider handles chat and one-shot generations. Individual gezellen
                can override this in their detail pane.
              </p>
              <div className="provider-switch" data-testid="default-provider-switch">
                <button
                  type="button"
                  className={`provider-pill${provider === onDeviceProvider ? ' provider-pill-active' : ''}`}
                  onClick={() => void setProvider(onDeviceProvider)}
                  title="Run models directly on this device — weights live on disk, no separate software, no cloud round-trip."
                >
                  {onDeviceLabel}
                </button>
                {isDarwin && (
                  <button
                    type="button"
                    className={`provider-pill${provider === 'llama-cpp' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('llama-cpp')}
                    title="Cross-platform llama runtime — an alternative on-device engine on Mac for cases where MLX isn't a fit."
                  >
                    {llamaCppTabLabel}
                  </button>
                )}
                {showDs4Provider && (
                  <button
                    type="button"
                    className={`provider-pill${provider === 'ds4' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('ds4')}
                    title="DwarfStar (ds4) — antirez's specialized engine for very large mixture-of-experts models (DeepSeek V4, GLM 5.2). Streams the experts from disk so a frontier-class model runs on this device."
                  >
                    {ds4TabLabel}
                  </button>
                )}
                {showCopilotProvider && (
                  <button
                    type="button"
                    className={`provider-pill${provider === 'copilot' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('copilot')}
                  >
                    GitHub Copilot
                  </button>
                )}
                {showOpenaiProvider && (
                  <button
                    type="button"
                    className={`provider-pill${provider === 'openai' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('openai')}
                  >
                    OpenAI
                  </button>
                )}
                <button
                  type="button"
                  className={`provider-pill${provider === 'codex-cli' ? ' provider-pill-active' : ''}`}
                  onClick={() => void setProvider('codex-cli')}
                  title="Drive a locally-installed `codex` CLI per turn. Auth is whatever the CLI is logged in with on this host — no API key needed here."
                >
                  OpenAI Codex CLI
                </button>
                {showAnthropicProvider && (
                  <button
                    type="button"
                    className={`provider-pill${provider === 'anthropic' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('anthropic')}
                  >
                    Anthropic Claude
                  </button>
                )}
                <button
                  type="button"
                  className={`provider-pill${provider === 'anthropic-cli' ? ' provider-pill-active' : ''}`}
                  onClick={() => void setProvider('anthropic-cli')}
                  title="Drive a locally-installed `claude` CLI per turn. Auth is whatever the CLI is logged in with on this host — no API key needed here."
                >
                  Anthropic Claude CLI
                </button>
                <button
                  type="button"
                  className={`provider-pill${provider === 'ollama' ? ' provider-pill-active' : ''}`}
                  onClick={() => void setProvider('ollama')}
                >
                  Ollama
                </button>
              </div>

              {provider === 'copilot' && (
                <div
                  className="new-row"
                  style={{ marginTop: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <label className="muted" style={{ fontSize: '0.9rem' }}>
                    Default model
                  </label>
                  <ModelPicker
                    provider="copilot"
                    value={config?.defaultModel?.copilot}
                    onChange={(v) => void saveDefaultModel('copilot', v)}
                  />
                  <EffortPicker
                    provider="copilot"
                    model={config?.defaultModel?.copilot}
                    value={config?.defaultReasoningEffort?.copilot}
                    onChange={(v) => void saveDefaultEffort('copilot', v)}
                  />
                </div>
              )}

              {provider === 'ollama' && (
                <>
                  <div
                    className="new-row"
                    style={{ marginTop: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <label className="muted" style={{ fontSize: '0.9rem' }}>
                      Default model
                    </label>
                    <ModelPicker
                      provider="ollama"
                      value={config?.defaultModel?.ollama}
                      onChange={(v) => void saveDefaultModel('ollama', v)}
                      placeholder="First local model"
                    />
                  </div>
                  {isOllamaReasoningModel(config?.defaultModel?.ollama ?? '') && (
                    <OllamaReasoningToggle
                      value={config?.ollamaThink}
                      onChange={async (next) => {
                        const res = await api.updateConfig({ ollamaThink: next });
                        setConfig(res);
                      }}
                    />
                  )}
                </>
              )}

              {(provider === 'llama-cpp' || provider === 'mlx') && (
                <div
                  className="new-row"
                  style={{ marginTop: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <label className="muted" style={{ fontSize: '0.9rem' }}>
                    Default model
                  </label>
                  <ModelPicker
                    provider={provider}
                    value={config?.defaultModel?.[provider]}
                    onChange={(v) => void saveDefaultModel(provider, v)}
                    placeholder="First local model"
                  />
                </div>
              )}

              {(provider === 'llama-cpp' || provider === 'mlx') && (
                <p className="muted small" style={{ marginTop: '0.75rem' }}>
                  Download models and tune advanced settings in the{' '}
                  <button
                    type="button"
                    className="gz-link-button"
                    onClick={() => setSection(provider === 'mlx' ? 'mlx' : 'llamaCpp')}
                    style={{ padding: 0 }}
                  >
                    {provider === 'mlx' ? mlxTabLabel : llamaCppTabLabel}
                  </button>{' '}
                  tab.
                </p>
              )}

              {provider === 'ds4' && (
                <>
                  <div
                    className="new-row"
                    style={{ marginTop: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
                  >
                    <label className="muted" style={{ fontSize: '0.9rem' }}>
                      Default model
                    </label>
                    <ModelPicker
                      provider="ds4"
                      value={config?.defaultModel?.ds4}
                      onChange={(v) => void saveDefaultModel('ds4', v)}
                      placeholder="First local model"
                    />
                  </div>
                  <p className="muted small" style={{ marginTop: '0.75rem' }}>
                    Download DwarfStar models and tune SSD streaming in the{' '}
                    <button
                      type="button"
                      className="gz-link-button"
                      onClick={() => setSection('ds4')}
                      style={{ padding: 0 }}
                    >
                      {ds4TabLabel}
                    </button>{' '}
                    tab.
                  </p>
                </>
              )}
              <DefaultModelAdvancedTuning
                config={config}
                provider={provider}
                onConfigUpdated={setConfig}
              />

              <div
                style={{
                  marginTop: '1.5rem',
                  paddingTop: '1.25rem',
                  borderTop: '1px solid var(--border)',
                }}
              >
                <h4 style={{ margin: '0 0 0.35rem' }}>Night Shift model</h4>
                <p className="muted" style={{ margin: '0 0 0.75rem' }}>
                  Night Shift inherits the default provider and model unless you choose a separate,
                  hands-off model here. For example, you might want to use a larger (but slower)
                  model during the night shift for more careful thinking overnight. Individual gezel
                  overrides still take priority.
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="checkbox"
                    checked={nightShiftModelOverride?.enabled === true}
                    onChange={(e) => {
                      const enabled = e.target.checked;
                      const inheritedModel =
                        nightShiftModelOverride?.model ??
                        config?.defaultModel?.[nightShiftProvider];
                      void saveNightShiftModelOverride({
                        enabled,
                        ...(enabled && inheritedModel ? { model: inheritedModel } : {}),
                      });
                    }}
                  />
                  <span>Use a specific model by default during Night Shift</span>
                </label>

                {nightShiftModelOverride?.enabled === true && (
                  <div style={{ marginTop: '0.8rem' }}>
                    <div className="gz-tray" role="radiogroup" aria-label="Night Shift provider">
                      {nightShiftProviderChoices.map((choice) => (
                        <button
                          key={choice.id}
                          type="button"
                          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                          role="radio"
                          aria-checked={nightShiftProvider === choice.id}
                          className={`gz-key${
                            nightShiftProvider === choice.id ? ' gz-key-active' : ''
                          }`}
                          onClick={() =>
                            void saveNightShiftModelOverride({
                              enabled: true,
                              provider: choice.id,
                              model: config?.defaultModel?.[choice.id],
                            })
                          }
                          title={choice.title}
                        >
                          {choice.label}
                        </button>
                      ))}
                    </div>
                    <div
                      className="new-row"
                      style={{ marginTop: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}
                    >
                      <label className="muted" style={{ fontSize: '0.9rem' }}>
                        Night Shift model
                      </label>
                      <ModelPicker
                        provider={nightShiftProvider}
                        value={nightShiftModelOverride.model}
                        onChange={(model) => void saveNightShiftModelOverride({ model })}
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section style={{ marginBottom: '2rem' }}>
              <h3>Tool filtering</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Give each gezel only the tools their role actually needs. A smaller toolbox keeps
                them focused and makes every reply faster and cheaper — it matters most with small
                on-device models. Known roles (Meester, Voorman, Reviewer, Copywriter, Designer,
                Planner) start with a sensible set; each gezel's own Toolsets tab can override it.
              </p>
              <div className="provider-switch">
                <button
                  type="button"
                  className={`provider-pill${
                    (config?.toolFilterMode ?? 'always') === 'always' ? ' provider-pill-active' : ''
                  }`}
                  onClick={() => void saveToolFilterMode('always')}
                >
                  Always
                </button>
                <button
                  type="button"
                  className={`provider-pill${
                    (config?.toolFilterMode ?? 'always') === 'small-model'
                      ? ' provider-pill-active'
                      : ''
                  }`}
                  onClick={() => void saveToolFilterMode('small-model')}
                >
                  On small models
                </button>
                <button
                  type="button"
                  className={`provider-pill${
                    (config?.toolFilterMode ?? 'always') === 'never' ? ' provider-pill-active' : ''
                  }`}
                  onClick={() => void saveToolFilterMode('never')}
                >
                  Never
                </button>
              </div>
            </section>

            <MemorySection
              config={config}
              onRetrievalChange={setRetrieval}
              onSummarizationChange={setSummarization}
            />
          </>
        )}

        {section === 'copilot' && (
          <>
            {/* Installing precedes signing in, so this card comes first.
                The tab itself is never gated on availability — it's where
                you come to make Copilot available. */}
            <CopilotInstallCard
              availability={copilotAvailability}
              onInstalled={() => void runCopilotProbe()}
            />

            <section className="provider-card">
              <h3>GitHub Copilot</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                A Copilot-enabled GitHub account is required. Gezel supports two sign-in modes — the
                Copilot CLI is the simpler default.
              </p>

              {/* Connection status ─ reflects the most recent probe. */}
              <CopilotConnectionStatus
                probe={copilotProbe}
                mode={hasGithubToken ? 'pat' : 'cli'}
                onRetest={() => void runCopilotProbe()}
              />

              {/* Option 1 — CLI. Collapses to a single "Signed in as …" line
                  when we know the account; expands to full install/login
                  instructions when not signed in or when the user asks. */}
              <div
                style={{
                  marginTop: '1.25rem',
                  paddingTop: '1rem',
                  borderTop: '1px solid var(--border)',
                }}
              >
                {!hasGithubToken && copilotProbe.kind === 'ok' && copilotLogin ? (
                  <div className="new-row" style={{ alignItems: 'center', gap: '0.5rem' }}>
                    <h4 style={{ margin: 0 }}>
                      Signed in as <code>{copilotLogin}</code>
                      <span className="home-copilot-recommended" style={{ marginLeft: '0.5rem' }}>
                        active
                      </span>
                    </h4>
                    <button
                      type="button"
                      className="gz-link-button"
                      onClick={() => setShowCliHelp((s) => !s)}
                      style={{ marginLeft: 'auto' }}
                    >
                      {showCliHelp ? 'Hide' : 'Login instructions'}
                    </button>
                  </div>
                ) : (
                  <h4 style={{ margin: 0 }}>
                    Sign in with the Copilot CLI
                    {!hasGithubToken && copilotProbe.kind === 'ok' && (
                      <span className="home-copilot-recommended" style={{ marginLeft: '0.5rem' }}>
                        active
                      </span>
                    )}
                  </h4>
                )}
                {(showCliHelp ||
                  !(copilotProbe.kind === 'ok' && copilotLogin && !hasGithubToken)) && (
                  <>
                    <p className="muted small">
                      Gezel bundles the Copilot CLI and a Node runtime — click below and the login
                      runs in-app. It opens a browser to sign in to GitHub and lands the credential
                      in <code>~/.copilot</code>; status above refreshes automatically.
                    </p>
                    <CopilotLoginCommand
                      installDir={config?.copilotCliInstallDir}
                      onComplete={() => void runCopilotProbe()}
                    />
                  </>
                )}
              </div>
            </section>

            {/* Alternative sign-in method — its own squircle so it reads as
                a clearly separate option rather than a sub-section of the
                primary CLI card. */}
            <section className="provider-card">
              <h3 style={{ margin: 0 }}>
                Alternative sign-in: GitHub token
                {hasGithubToken && copilotProbe.kind === 'ok' && copilotLogin && (
                  <span
                    className="muted small"
                    style={{ marginLeft: '0.5rem', fontWeight: 'normal' }}
                  >
                    (signed in as <code>{copilotLogin}</code>)
                  </span>
                )}
                {hasGithubToken && copilotProbe.kind === 'ok' && (
                  <span className="home-copilot-recommended" style={{ marginLeft: '0.5rem' }}>
                    active
                  </span>
                )}
                {!hasGithubToken && !showPatForm && (
                  <button
                    type="button"
                    className="gz-link-button"
                    onClick={() => setShowPatForm(true)}
                    style={{ marginLeft: '0.5rem' }}
                  >
                    Show
                  </button>
                )}
              </h3>
              {(hasGithubToken || showPatForm) && (
                <>
                  <p className="muted small">
                    Use a classic{' '}
                    <a
                      href="https://github.com/settings/tokens"
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--accent)' }}
                    >
                      GitHub personal access token
                    </a>{' '}
                    with the <code>copilot</code> scope.
                  </p>
                  {hasGithubToken && (
                    <p>
                      <code>&lt;Stored GitHub token&gt;</code>{' '}
                      <button
                        type="button"
                        onClick={clearGitHubToken}
                        style={{ marginLeft: '0.5rem' }}
                      >
                        Clear
                      </button>
                    </p>
                  )}
                  <div className="new-row">
                    <input
                      type="password"
                      placeholder={hasGithubToken ? 'Replace GitHub token…' : 'Paste GitHub token…'}
                      value={tokenDraft}
                      onChange={(e) => setTokenDraft(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button type="button" onClick={saveGitHubToken} disabled={!tokenDraft.trim()}>
                      Save
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="provider-card">
              <h3>Sandbox Copilot actions</h3>
              <p className="muted small" style={{ marginTop: 0 }}>
                When on, new Copilot threads deny the CLI&rsquo;s built-in tools (<code>bash</code>,{' '}
                <code>web_fetch</code>, <code>view</code>, file ops, <code>grep</code>) and force
                the model to work through gezel&rsquo;s MCP tools instead. Gives you an audit trail
                for every action and consistent behavior across providers. Per-gezel override lives
                on each gezel&rsquo;s Settings tab.
              </p>
              <label
                className="muted"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  marginTop: '0.5rem',
                  fontSize: '0.9rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={config?.sandboxCopilot === true}
                  onChange={(e) => {
                    void api.updateConfig({ sandboxCopilot: e.target.checked }).then(setConfig);
                  }}
                />
                <span>Sandbox Copilot to gezel tools only</span>
              </label>
            </section>

            <section className="provider-card">
              <h3>Timeouts</h3>
              <p className="muted small" style={{ marginTop: 0 }}>
                Copilot turns are capped at a hard wall-clock ceiling — if the ceiling fires before
                the model signals <code>session.idle</code>, the turn ends with a &ldquo;Turn
                stopped before finishing&rdquo; banner. Bump this if tool-heavy gezellen (long shell
                or Playwright chains) legitimately need longer. Leave blank to use the default (10
                minutes).
              </p>
              <TimeoutRow
                label="Hard turn timeout"
                unit="minutes"
                help="Total wall-clock cap from when the turn acquires its queue slot to when the model finishes. Default 10m. Raise for tool-heavy gezellen that run long chains without streaming reply text between calls."
                value={copilotTurnTimeoutDraft}
                onChange={setCopilotTurnTimeoutDraft}
                configValue={config?.copilotTurnTimeoutMin}
                onSave={() => void saveCopilotTurnTimeout()}
              />
            </section>

            {copilotUsage && (
              <section style={{ marginTop: '1.5rem' }}>
                <ProviderUsagePanel label="GitHub Copilot" data={copilotUsage} />
              </section>
            )}
          </>
        )}

        {section === 'openai' && (
          <>
            <section className="provider-card">
              <h3>OpenAI</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Uses an OpenAI API key. Billing and usage run through your OpenAI account,
                independent of GitHub Copilot.
              </p>
              <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: '1.25rem' }}>
                <li>
                  Go to{' '}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    platform.openai.com/api-keys
                  </a>{' '}
                  and create a secret key with All Permissions.
                </li>
                <li>Paste it below. Organization ID is optional.</li>
              </ol>
              {hasOpenaiKey && (
                <p>
                  Current key:{' '}
                  <code>
                    {'•'.repeat(8)}…{(config?.openaiApiKey ?? '').slice(-4)}
                  </code>
                  {config?.openaiOrganization && (
                    <>
                      {' '}
                      · org <code>{config.openaiOrganization}</code>
                    </>
                  )}{' '}
                  <button type="button" onClick={clearOpenaiKey} style={{ marginLeft: '0.5rem' }}>
                    Clear
                  </button>
                </p>
              )}
              <div className="new-row">
                <input
                  type="password"
                  placeholder={hasOpenaiKey ? 'Replace key…' : 'Paste OpenAI API key (sk-…)'}
                  value={openaiKeyDraft}
                  onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                  style={{ flex: 1 }}
                />
                <input
                  type="text"
                  placeholder="Organization (optional)"
                  value={openaiOrgDraft}
                  onChange={(e) => setOpenaiOrgDraft(e.target.value)}
                  style={{ width: 200 }}
                />
                <button type="button" onClick={saveOpenaiKey} disabled={!openaiKeyDraft.trim()}>
                  Save
                </button>
              </div>
              {hasOpenaiKey && (
                <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
                  <label className="muted" style={{ fontSize: '0.9rem' }}>
                    Default model
                  </label>
                  <ModelPicker
                    provider="openai"
                    value={config?.defaultModel?.openai}
                    onChange={(v) => void saveDefaultModel('openai', v)}
                  />
                  <EffortPicker
                    provider="openai"
                    model={config?.defaultModel?.openai}
                    value={config?.defaultReasoningEffort?.openai}
                    onChange={(v) => void saveDefaultEffort('openai', v)}
                  />
                </div>
              )}
            </section>
            {openaiUsage && (
              <section style={{ marginTop: '1.5rem' }}>
                <ProviderUsagePanel label="OpenAI" data={openaiUsage} />
              </section>
            )}
          </>
        )}

        {section === 'codexCli' && (
          <section className="provider-card">
            <h3>OpenAI Codex CLI</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Drives a locally-installed{' '}
              <a
                href="https://github.com/openai/codex"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Codex CLI
              </a>{' '}
              once per chat turn.
            </p>
            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Connection
              </label>
              {codexCliProbe.kind === 'ok' && (
                <span style={{ color: 'var(--success)', fontSize: '0.9rem' }}>
                  ✓ Codex CLI ready ({codexCliProbe.modelCount} models)
                </span>
              )}
              {codexCliProbe.kind === 'fail' && (
                <span style={{ color: 'var(--danger, #c66)', fontSize: '0.9rem' }}>
                  ✗ {codexCliProbe.error}
                </span>
              )}
              {(codexCliProbe.kind === 'idle' || codexCliProbe.kind === 'probing') && (
                <span className="muted" style={{ fontSize: '0.9rem' }}>
                  Testing…
                </span>
              )}
              <button
                type="button"
                onClick={() => void runCodexCliProbe()}
                disabled={codexCliProbe.kind === 'probing'}
                style={{ marginLeft: '0.75rem' }}
              >
                {codexCliProbe.kind === 'probing' ? 'Testing…' : 'Test connection'}
              </button>
            </div>

            {codexCliProbe.kind === 'fail' && (
              <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: '1.25rem' }}>
                <li>
                  Install the Codex CLI globally and run <code>codex login</code> (or export an{' '}
                  <code>OPENAI_API_KEY</code>) so the binary is ready to use.
                </li>
                <li>
                  Optionally pin an explicit binary path under Advanced — gezel uses{' '}
                  <code>$PATH</code> by default.
                </li>
                <li>Pick a default model and permission mode.</li>
              </ol>
            )}

            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Default permission
              </label>
              <div className="gz-tray" role="radiogroup" aria-label="Default Codex access">
                {(
                  [
                    ['plan', 'Plan'],
                    ['edit', 'Edit'],
                    ['reviewed', 'Reviewed'],
                    ['full', 'Full'],
                  ] as const satisfies ReadonlyArray<readonly [CodexPermissionMode, string]>
                ).map(([value, label]) => {
                  const selected =
                    normalizeCodexPermissionMode(config?.codexCli?.defaultPermissionMode) === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                      role="radio"
                      aria-checked={selected}
                      className={`gz-key${selected ? ' gz-key-active' : ''}`}
                      onClick={() => void saveCodexCli({ defaultPermissionMode: value })}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
              Plan is read-only. Edit can change the workspace but cannot cross its sandbox.
              Reviewed sends boundary crossings to an independent Codex reviewer. Full disables
              Codex sandboxing and approvals. Gezel’s narrow destructive-command guard remains on in
              every mode. Projects and individual gezels can override this default.
            </p>

            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Default model
              </label>
              <ModelPicker
                provider="codex-cli"
                value={config?.defaultModel?.['codex-cli']}
                onChange={(v) => void saveDefaultModel('codex-cli', v)}
              />
            </div>

            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Reasoning effort
              </label>
              <EffortTray
                provider="codex-cli"
                model={config?.defaultModel?.['codex-cli']}
                defaultModel="gpt-5.5"
                value={config?.codexCli?.defaultReasoningEffort ?? ''}
                onChange={(value) =>
                  void saveCodexCli({
                    defaultReasoningEffort: value as CodexCliReasoningEffort | undefined,
                  })
                }
              />
            </div>

            <details style={{ marginTop: '1rem' }}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>Advanced</strong>
              </summary>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Binary path
                </label>
                <input
                  type="text"
                  placeholder="(auto — found on PATH)"
                  value={codexCliBinaryDraft}
                  onChange={(e) => setCodexCliBinaryDraft(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = codexCliBinaryDraft.trim();
                    void saveCodexCli({ binaryPath: trimmed || undefined });
                  }}
                >
                  Save
                </button>
              </div>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Gezel tools
                </label>
                <label className="muted" style={{ fontSize: '0.9rem' }}>
                  <input
                    type="checkbox"
                    checked={config?.codexCli?.manageRuntimeFiles !== false}
                    onChange={(e) => void saveCodexCli({ manageRuntimeFiles: e.target.checked })}
                    style={{ marginRight: '0.5rem' }}
                  />
                  Add Gezel tools like search, memories, tasks, and team coordination to Codex
                </label>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Disable to run Codex with only its built-in tools.
              </p>
            </details>
          </section>
        )}

        {section === 'anthropic' && (
          <section className="provider-card">
            <h3>Anthropic Claude</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Uses an Anthropic API key. Billing and usage run through your Anthropic console,
              independent of GitHub Copilot or OpenAI.
            </p>
            <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: '1.25rem' }}>
              <li>
                Go to{' '}
                <a
                  href="https://console.anthropic.com/settings/keys"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  console.anthropic.com/settings/keys
                </a>{' '}
                and create an API key.
              </li>
              <li>Paste it below.</li>
            </ol>
            {hasAnthropicKey && (
              <p>
                Current key:{' '}
                <code>
                  {'•'.repeat(8)}…{(config?.anthropicApiKey ?? '').slice(-4)}
                </code>{' '}
                <button type="button" onClick={clearAnthropicKey} style={{ marginLeft: '0.5rem' }}>
                  Clear
                </button>
              </p>
            )}
            <div className="new-row">
              <input
                type="password"
                placeholder={
                  hasAnthropicKey ? 'Replace key…' : 'Paste Anthropic API key (sk-ant-…)'
                }
                value={anthropicKeyDraft}
                onChange={(e) => setAnthropicKeyDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={saveAnthropicKey} disabled={!anthropicKeyDraft.trim()}>
                Save
              </button>
            </div>
            {hasAnthropicKey && (
              <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
                <label className="muted" style={{ fontSize: '0.9rem' }}>
                  Default model
                </label>
                <ModelPicker
                  provider="anthropic"
                  value={config?.defaultModel?.anthropic}
                  onChange={(v) => void saveDefaultModel('anthropic', v)}
                />
                <EffortPicker
                  provider="anthropic"
                  model={config?.defaultModel?.anthropic}
                  value={config?.defaultReasoningEffort?.anthropic}
                  onChange={(v) => void saveDefaultEffort('anthropic', v)}
                />
              </div>
            )}
            <p className="muted" style={{ marginTop: '0.75rem', fontSize: '0.85rem' }}>
              Each reply re-sends the conversation so far; Gezel marks it for Anthropic's caching,
              so follow-up turns cost a fraction of the first.
            </p>
          </section>
        )}

        {section === 'anthropicCli' && (
          <section className="provider-card">
            <h3>Anthropic Claude CLI</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Drives a locally-installed{' '}
              <a
                href="https://docs.claude.com/en/docs/claude-code/overview"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                Claude Code CLI
              </a>{' '}
              once per chat turn.
            </p>
            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Connection
              </label>
              {anthropicCliProbe.kind === 'ok' && (
                <span style={{ color: 'var(--success)', fontSize: '0.9rem' }}>
                  ✓ Claude CLI ready ({anthropicCliProbe.modelCount} models)
                </span>
              )}
              {anthropicCliProbe.kind === 'fail' && (
                <span style={{ color: 'var(--danger, #c66)', fontSize: '0.9rem' }}>
                  ✗ {anthropicCliProbe.error}
                </span>
              )}
              {(anthropicCliProbe.kind === 'idle' || anthropicCliProbe.kind === 'probing') && (
                <span className="muted" style={{ fontSize: '0.9rem' }}>
                  Testing…
                </span>
              )}
              <button
                type="button"
                onClick={() => void runAnthropicCliProbe()}
                disabled={anthropicCliProbe.kind === 'probing'}
                style={{ marginLeft: '0.75rem' }}
              >
                {anthropicCliProbe.kind === 'probing' ? 'Testing…' : 'Test connection'}
              </button>
            </div>

            {anthropicCliProbe.kind === 'fail' && (
              <ol className="muted" style={{ lineHeight: 1.7, paddingLeft: '1.25rem' }}>
                <li>
                  Install the Claude CLI globally and run <code>claude /status</code> in a terminal
                  to confirm it's authenticated.
                </li>
                <li>
                  Optionally pin an explicit binary path under Advanced — gezel uses{' '}
                  <code>$PATH</code> by default.
                </li>
                <li>Pick a default model and permission mode.</li>
              </ol>
            )}

            <div
              className="new-row claude-permission-row"
              style={{ alignItems: 'flex-start', marginTop: '0.75rem' }}
            >
              <span className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Default permission
              </span>
              <div
                className="gz-tray claude-permission-tray"
                role="radiogroup"
                aria-label="Default permission"
              >
                {CLAUDE_PERMISSION_CHOICES.map((choice) => {
                  const selected =
                    (config?.anthropicCli?.defaultPermissionMode ?? 'acceptEdits') === choice.id;
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons is the shared keys-in-trays pattern.
                      role="radio"
                      aria-checked={selected}
                      className={`gz-key gz-key--stacked${selected ? ' gz-key-active' : ''}`}
                      onClick={() => void saveAnthropicCli({ defaultPermissionMode: choice.id })}
                    >
                      <span className="claude-permission-label">{choice.label}</span>
                      <span className="claude-permission-hint">{choice.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Default model
              </label>
              <ModelPicker
                provider="anthropic-cli"
                value={config?.defaultModel?.['anthropic-cli']}
                onChange={(v) => void saveDefaultModel('anthropic-cli', v)}
                placeholder="Gezel default (Claude Sonnet)"
              />
            </div>

            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                Reasoning effort
              </label>
              <EffortPicker
                provider="anthropic-cli"
                model={config?.defaultModel?.['anthropic-cli']}
                value={config?.defaultReasoningEffort?.['anthropic-cli']}
                onChange={(value) => void saveDefaultEffort('anthropic-cli', value)}
              />
            </div>

            <details style={{ marginTop: '1rem' }}>
              <summary style={{ cursor: 'pointer' }}>
                <strong>Advanced</strong>
              </summary>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Binary path
                </label>
                <input
                  type="text"
                  placeholder="(auto — found on PATH)"
                  value={anthropicCliBinaryDraft}
                  onChange={(e) => setAnthropicCliBinaryDraft(e.target.value)}
                  style={{ flex: 1 }}
                />
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = anthropicCliBinaryDraft.trim();
                    void saveAnthropicCli({ binaryPath: trimmed || undefined });
                  }}
                >
                  Save
                </button>
              </div>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Gezel tools
                </label>
                <label className="muted" style={{ fontSize: '0.9rem' }}>
                  <input
                    type="checkbox"
                    checked={config?.anthropicCli?.manageRuntimeFiles !== false}
                    onChange={(e) =>
                      void saveAnthropicCli({ manageRuntimeFiles: e.target.checked })
                    }
                    style={{ marginRight: '0.5rem' }}
                  />
                  Add Gezel tools like search, memories, tasks, and team coordination to Claude
                </label>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Disable to run Claude with only its built-in tools.
              </p>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Pool size
                </label>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={config?.anthropicCli?.poolSize ?? 4}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 32) {
                      void saveAnthropicCli({ poolSize: n });
                    }
                  }}
                  style={{ width: '2.5rem' }}
                />
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  warm <code>claude</code> subprocesses to keep around
                </span>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Each pool slot holds one <code>claude</code> process pinned to a chat thread; turn
                2+ of a thread skips the cold-start cost. More slots = lower per-turn latency for
                parallel gezellen, more memory (~100–200 MB per warm process). When at cap, the
                least-recently-used non-busy worker is evicted.
              </p>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Concurrency
                </label>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={
                    config?.providerConcurrency?.['anthropic-cli'] ??
                    config?.anthropicCli?.poolSize ??
                    4
                  }
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n) && n >= 1 && n <= 32) {
                      void saveAnthropicCliConcurrency(n);
                    }
                  }}
                  style={{ width: '2.5rem' }}
                />
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  turns running in parallel
                </span>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                How many gezel turns can dispatch to <code>claude</code> at once. Defaults to the
                pool size — every warm slot can be running a turn. Lower this if you want a memory
                headroom buffer (warm processes that aren't currently executing). Setting it above
                the pool size logs a warning at provider init; the pool will spawn over-cap
                transiently to honor the request.
              </p>

              <div className="new-row" style={{ alignItems: 'center', marginTop: '0.75rem' }}>
                <label className="muted" style={{ fontSize: '0.9rem', minWidth: '7rem' }}>
                  Idle timeout
                </label>
                <input
                  type="number"
                  min={60}
                  max={3600}
                  step={60}
                  value={config?.anthropicCli?.workerIdleSec ?? 600}
                  onChange={(e) => {
                    const n = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(n) && n >= 60 && n <= 3600) {
                      void saveAnthropicCli({ workerIdleSec: n });
                    }
                  }}
                  style={{ width: '2.5rem' }}
                />
                <span className="muted" style={{ fontSize: '0.85rem' }}>
                  seconds
                </span>
              </div>
              <p className="muted" style={{ fontSize: '0.85rem', marginTop: '0.25rem' }}>
                Shut down a warm subprocess after this long without a turn. Resets on every turn.
              </p>
            </details>
          </section>
        )}

        {section === 'ollama' && (
          <section className="provider-card">
            <OllamaSettings config={config} onConfigChanged={setConfig} />
          </section>
        )}

        {section === 'llamaCpp' && (
          <section className="provider-card">
            <LlamaCppSettings
              config={config}
              onConfigChanged={setConfig}
              health={health}
              title={llamaCppTabLabel}
            />
          </section>
        )}

        {section === 'ds4' && (
          <section className="provider-card">
            <Ds4Settings
              config={config}
              onConfigChanged={setConfig}
              health={health}
              title={ds4TabLabel}
            />
          </section>
        )}

        {section === 'mlx' && (
          <section className="provider-card">
            <MlxSettings config={config} onConfigChanged={setConfig} />
          </section>
        )}

        {section === 'imageEngine' && (
          <section>
            <ImageEngineSettings />
          </section>
        )}

        {section === 'videoEngine' && (
          <section>
            <VideoEngineSettings />
          </section>
        )}

        {section === 'imageRecognition' && (
          <>
            <section>
              <ImageRecognitionSettings />
            </section>
            <FaceRecognitionCard />
          </>
        )}

        {section === 'audio' && (
          <section>
            <AudioEngineSettings />
          </section>
        )}

        {section === 'webSearch' && (
          <section className="provider-card">
            <h3>Web search</h3>
            <p className="muted" style={{ marginTop: 0 }}>
              Powers the web search tools that gezellen use to discover content on the internet.
              Picks one search backend; configure a key only for the providers you choose.
            </p>
            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.5rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem' }}>
                Provider
              </label>
              <select
                value={visibleWebSearchProviderSetting(
                  config?.webSearch?.provider,
                  INCLUDE_TESTING_WEB_SEARCH_PROVIDER,
                )}
                onChange={(e) =>
                  void saveWebSearchProvider(e.target.value as WebSearchProviderSetting)
                }
              >
                {WEB_SEARCH_PROVIDER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="new-row" style={{ alignItems: 'center', marginTop: '0.5rem' }}>
              <label className="muted" style={{ fontSize: '0.9rem' }}>
                Fallback
              </label>
              <select
                value={config?.webSearch?.fallbackProvider ?? 'unset'}
                onChange={(e) =>
                  void saveWebSearchFallback(e.target.value as 'brave' | 'wikipedia' | 'unset')
                }
              >
                <option value="unset">None</option>
                <option value="wikipedia">Wikipedia</option>
                <option value="brave">Brave Search</option>
              </select>
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                Used when the primary is unavailable or errors.
              </span>
            </div>

            <h4 style={{ marginTop: '1.5rem', marginBottom: '0.25rem' }}>Brave Search</h4>
            <p className="muted" style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              Free tier: 2000 queries/month, 1 query/second. Get a key at{' '}
              <a
                href="https://api.search.brave.com/app/keys"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent)' }}
              >
                api.search.brave.com/app/keys
              </a>
              .
            </p>
            {config?.hasBraveSearchApiKey && (
              <p>
                Current key:{' '}
                <code>
                  {'•'.repeat(8)}…{(config?.braveSearchApiKey ?? '').slice(-4)}
                </code>
                <button type="button" onClick={clearBraveKey} style={{ marginLeft: '0.5rem' }}>
                  Clear
                </button>
              </p>
            )}
            <div className="new-row">
              <input
                type="password"
                placeholder={
                  config?.hasBraveSearchApiKey ? 'Replace key…' : 'Paste Brave Search API key…'
                }
                value={braveKeyDraft}
                onChange={(e) => setBraveKeyDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              <button type="button" onClick={saveBraveKey} disabled={!braveKeyDraft.trim()}>
                Save
              </button>
            </div>
          </section>
        )}

        {section === 'channels' && config?.showWorkInProgressFeatures === true && (
          <ChannelsSettings config={config} onConfigChanged={setConfig} />
        )}

        {section === 'connectedApps' && <ConnectedAppsPanel />}
        {section === 'remoteServers' && <RemoteServersPanel />}

        {section === 'knowledge' && <KnowledgeCatalogsCard />}

        {section === 'toolsets' && (
          <section>
            <h3>Shared Toolsets</h3>
            <ToolsetsEditor
              scope={{ kind: 'shared' }}
              subject="every gezel"
              hint="Toolsets here are available to every gezel in addition to their own."
            />
          </section>
        )}

        {section === 'securityCompliance' && (
          <SecurityComplianceSettings config={config} onConfigChanged={setConfig} />
        )}

        {section === 'about' && (
          <>
            <section style={{ marginBottom: '2rem' }}>
              <h3>About</h3>
              {health && (
                <dl>
                  <dt>Version</dt>
                  <dd>{health.version === '0.0.0' ? 'development build' : health.version}</dd>
                  <dt>Running since</dt>
                  <dd>{formatStartedAt(health.startedAt)}</dd>
                </dl>
              )}
              <LocalEngineStatus />
              <AutostartToggle />
              <BackgroundServiceStatus />
              <p className="muted small" style={{ marginTop: '0.75rem' }}>
                Something not working right?{' '}
                <ReportErrorLink
                  className="gz-link-button"
                  label="Report a problem on GitHub"
                  report={{ surface: 'settings-about', message: '' }}
                />
              </p>
            </section>
            <section style={{ marginBottom: '2rem' }}>
              <h3>Updates</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Gezel checks public GitHub release metadata when the desktop app launches. No
                personal data is sent. Turn this off to stop automatic checks; you can still choose
                “Check for updates” from the tray menu.
              </p>
              <label className="debug-toggle">
                <input
                  type="checkbox"
                  checked={config?.autoUpdateChecks !== false}
                  onChange={(e) => void saveAutoUpdateChecks(e.target.checked)}
                />
                <span>Check for updates automatically when Gezel starts</span>
              </label>
              <UpdateStatus />
            </section>
            <GildeUpdatesCard />
            <StorageUsageCard />
            <section style={{ marginBottom: '2rem' }}>
              <h3>Advanced</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Reveals advanced, power-user surfaces — currently the “Scripts” area in the sidebar.
              </p>
              <label className="debug-toggle">
                <input
                  type="checkbox"
                  checked={config?.showAdvancedFeatures === true}
                  onChange={(e) => void saveShowAdvancedFeatures(e.target.checked)}
                />
                <span>Show advanced features</span>
              </label>
              <label className="debug-toggle" style={{ display: 'flex', marginTop: '0.6rem' }}>
                <input
                  type="checkbox"
                  checked={config?.showWorkInProgressFeatures === true}
                  onChange={(e) => void saveShowWorkInProgressFeatures(e.target.checked)}
                />
                <span>Show very early work-in-progress features</span>
              </label>
              <p className="muted small">
                Very early features may be incomplete or change shape. The current preview is
                Connectors and the project types and craftbooks that use them.
              </p>
            </section>
            {isDarwin && window.__GEZEL__?.uninstall && (
              <section className="settings-uninstall-section" style={{ marginBottom: '2rem' }}>
                <h3>Uninstall</h3>
                <p className="muted" style={{ marginTop: 0 }}>
                  Remove Gezel and its machine-wide background service. You can keep downloaded
                  models and your work for a later reinstall, or choose exactly which data to
                  delete.
                </p>
                <button type="button" className="danger" onClick={requestMacUninstall}>
                  Uninstall Gezel…
                </button>
              </section>
            )}
            <section>
              <h3>Debug mode</h3>
              <p className="muted" style={{ marginTop: 0 }}>
                Turns on verbose diagnostics — tool-call internals, bridge startup traces, chat
                send/response bodies, and ambient-scheduler cadence reasoning — and enables
                additional tools.
              </p>
              <label className="debug-toggle">
                <input
                  type="checkbox"
                  checked={config?.debugMode === true}
                  onChange={(e) => void saveDebugMode(e.target.checked)}
                />
                <span>Debug mode</span>
              </label>
              <label className="debug-toggle" style={{ display: 'flex', marginTop: '0.6rem' }}>
                <input
                  type="checkbox"
                  checked={config?.resetTemplatesOnStartup === true}
                  onChange={(e) => void saveResetTemplatesOnStartup(e.target.checked)}
                />
                <span>On startup, reset all gezel templates back to defaults</span>
              </label>
              <div style={{ marginTop: '0.6rem' }}>
                <button type="button" className="subtle" onClick={() => void openLogsFolder()}>
                  Open logs folder
                </button>
              </div>
            </section>
          </>
        )}

        {section === 'benchmarks' && config?.debugMode === true && <BenchmarksView />}

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * Reasoning-mode toggle shown below the Default model picker when the
 * selected Ollama model is a known reasoning family. Three-way radio:
 *
 *   - Auto: null on the wire → writeConfig deletes the key → service
 *     falls back to family-aware default (off for reasoning models).
 *   - Always on: `think: true` — capture thinking as visible deltas.
 *   - Always off: `think: false` — skip reasoning, answer directly.
 *
 * The "Always off" pick is the typical fix when a reasoning model
 * keeps producing empty bubbles: it stops spending the output budget
 * on silent chain-of-thought. "Always on" is useful when the user
 * wants to *see* the reasoning (big bubble; more tokens; slower).
 */
/**
 * Per-provider tuning surface shown under each provider's "Default
 * model" picker. Renders {@link InstallModelTuningEditor}, which
 * stacks a preset (profile) dropdown over a collapsed custom
 * fine-tuning panel. Fetches the catalog manifest eagerly when the
 * model id changes so the preset list is populated before the user
 * opens anything.
 *
 * Hidden when the provider has no default model selected — we can't
 * key install tuning without a model id.
 */
function DefaultModelAdvancedTuning({
  config,
  provider,
  onConfigUpdated,
}: {
  config: ConfigResponse | null;
  provider: ProviderName;
  onConfigUpdated: (next: ConfigResponse) => void;
}) {
  const modelId = config?.defaultModel?.[provider];
  const [catalogTuning, setCatalogTuning] = useState<
    import('@bendyline/gezel').ChatModelTuning | undefined
  >(undefined);

  useEffect(() => {
    if (!modelId) {
      setCatalogTuning(undefined);
      return;
    }
    let cancelled = false;
    void (async () => {
      const detail = await api.getCatalogItem('chat-model', modelId).catch(() => null);
      if (cancelled) return;
      if (detail && detail.manifest.kind === 'chat-model' && detail.manifest.tuning) {
        setCatalogTuning(detail.manifest.tuning);
      } else {
        setCatalogTuning(undefined);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  if (!modelId) return null;

  const override = config?.modelTuning?.[modelId];
  const profileId = config?.modelTuningProfile?.[modelId];
  const availableProfiles = Object.keys(catalogTuning?.profiles ?? {});

  return (
    <InstallModelTuningEditor
      modelId={modelId}
      provider={provider}
      availableProfiles={availableProfiles}
      {...(catalogTuning ? { inherited: catalogTuning } : {})}
      {...(override ? { override } : {})}
      {...(profileId ? { profileId } : {})}
      onSaved={onConfigUpdated}
    />
  );
}

function OllamaReasoningToggle({
  value,
  onChange,
}: {
  value: boolean | undefined;
  onChange: (next: boolean | null) => void | Promise<void>;
}) {
  const mode: 'auto' | 'on' | 'off' = value === true ? 'on' : value === false ? 'off' : 'auto';
  return (
    <div style={{ marginTop: '0.75rem' }}>
      <div style={{ fontSize: '0.9rem', marginBottom: '0.3rem' }}>
        <strong>Reasoning mode</strong>{' '}
        <span className="muted small">— this model supports a thinking phase</span>
      </div>
      <p className="muted small" style={{ margin: '0 0 0.4rem 0' }}>
        Reasoning models spend their output budget on internal chain-of-thought before streaming any
        reply. If the budget runs out first, the chat bubble is empty. Auto uses Gezel's
        family-aware default (off for reasoning models); Always on captures thinking as visible
        deltas; Always off skips reasoning for faster direct answers.
      </p>
      <div style={{ display: 'flex', gap: '1.2rem', flexWrap: 'wrap' }}>
        {(['auto', 'on', 'off'] as const).map((m) => (
          <label key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="radio"
              name="ollama-think"
              checked={mode === m}
              onChange={() => {
                const next = m === 'auto' ? null : m === 'on';
                void onChange(next);
              }}
            />
            <span>{m === 'auto' ? 'Auto' : m === 'on' ? 'Always on' : 'Always off'}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** Human form of the daemon's start time — raw ISO reads as a dev artifact. */
function formatStartedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function AutostartToggle() {
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
 * Whether gezeld is running as a real background service this launch. The
 * degraded answer used to be a banner across Home; it is neither urgent nor
 * fixable without the installer, so it lives here and only leaves a one-line
 * pointer in the rail.
 */
/**
 * The live local engines and — the load-bearing number — the context
 * window each one ACTUALLY granted at launch. A model looping or "acting
 * dumb" on a small machine is very often a window smaller than its
 * standing prompt; surfacing the grant here turns that diagnosis into one
 * glance instead of a log hunt through `~/.gezel/logs/`.
 */
function LocalEngineStatus() {
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

function BackgroundServiceStatus() {
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
function UpdateStatus() {
  const state = useUpdateState();
  const platform = window.__GEZEL__?.platform;
  const notice = state?.kind === 'error' ? updateNotice(state, platform) : null;
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

/**
 * Inline status badge for the Copilot panel. Distinguishes the two auth
 * modes ("via CLI" vs "via PAT") based on whether a PAT is stored at the
 * time the probe succeeded, and offers a retest button so the user can
 * re-verify after running `copilot login` without leaving the page.
 */
function CopilotConnectionStatus({
  probe,
  mode,
  onRetest,
}: {
  probe: { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok' } | { kind: 'fail'; error: string };
  mode: 'cli' | 'pat';
  onRetest: () => void;
}) {
  const label = mode === 'pat' ? 'via GitHub token' : 'via Copilot CLI';
  return (
    <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center', gap: '0.5rem' }}>
      {probe.kind === 'probing' && <span className="muted small">checking connection…</span>}
      {probe.kind === 'ok' && (
        <span className="small" style={{ color: 'var(--accent)' }}>
          ● Connected {label}
        </span>
      )}
      {probe.kind === 'fail' && (
        <span className="error small" title={probe.error}>
          ● Not connected — {probe.error}
        </span>
      )}
      {probe.kind === 'idle' && <span className="muted small">not yet checked</span>}
      <button
        type="button"
        onClick={onRetest}
        disabled={probe.kind === 'probing'}
        style={{ marginLeft: 'auto' }}
      >
        Test connection
      </button>
    </div>
  );
}

function ProviderUsagePanel({ label, data }: { label: string; data: ProviderUsage }) {
  return (
    <div className="provider-usage-panel">
      <h4 className="provider-usage-heading">{label}</h4>
      <div className="usage-grid">
        {data.quotaBuckets.map((b) => (
          <QuotaBucketCard key={b.name} bucket={b} />
        ))}
        <div className="usage-card">
          <div className="usage-label">Today</div>
          <div className="usage-value">{data.todayTurns} turns</div>
          <div className="usage-detail">
            <span>
              {data.todayTokensIn.toLocaleString()} in / {data.todayTokensOut.toLocaleString()} out
              tokens
            </span>
          </div>
        </div>
        <div className="usage-card">
          <div className="usage-label">Since startup</div>
          <div className="usage-value">{data.totalTurns} turns</div>
          <div className="usage-detail">
            <span>
              {data.totalTokensIn.toLocaleString()} in / {data.totalTokensOut.toLocaleString()} out
              tokens
            </span>
          </div>
        </div>
        {/* Decode speed. Only the on-device engines report throughput, so this
            card is omitted entirely for cloud providers rather than showing a
            zero that reads as a measurement. */}
        {typeof data.medianOutputTokensPerSec === 'number' && (
          <div className="usage-card">
            <div className="usage-label">Decode speed</div>
            <div className="usage-value">{data.medianOutputTokensPerSec} tok/s</div>
            <div className="usage-detail">
              <span>median across turns, generation only</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function QuotaBucketCard({ bucket }: { bucket: QuotaBucket }) {
  if (bucket.isUnlimited) {
    return (
      <div className="usage-card usage-card-wide">
        <div className="usage-label">{humanizeBucketName(bucket.name)}</div>
        <div className="usage-value">Unlimited</div>
      </div>
    );
  }
  const used = Math.round((1 - bucket.remainingPercent) * 100);
  return (
    <div className="usage-card usage-card-wide">
      <div className="usage-label">{humanizeBucketName(bucket.name)}</div>
      <div className="usage-bar-track">
        <div
          className={`usage-bar-fill${used > 80 ? ' usage-bar-warn' : ''}`}
          style={{ width: `${Math.min(used, 100)}%` }}
        />
      </div>
      <div className="usage-detail">
        <span>
          {bucket.used.toLocaleString()} / {bucket.limit.toLocaleString()} ({used}%)
        </span>
        <span>
          {bucket.remaining.toLocaleString()} remaining
          {bucket.resetDate ? ` · resets ${bucket.resetDate}` : ''}
        </span>
      </div>
      {bucket.overage > 0 && (
        <div className="usage-overage">{bucket.overage.toLocaleString()} overage</div>
      )}
    </div>
  );
}

function humanizeBucketName(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function ThemePicker() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);
  return (
    <div className="provider-switch">
      {(['system', 'light', 'dark'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`provider-pill${pref === value ? ' provider-pill-active' : ''}`}
          onClick={() => {
            setThemePref(value);
            setPref(value);
          }}
        >
          {value === 'system' ? 'Follow system' : value === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

function SidebarSidePicker() {
  const [side, setSide] = useState<SidebarSide>(getSidebarSide);
  return (
    <div className="provider-switch">
      {(['left', 'right'] as const).map((value) => (
        <button
          key={value}
          type="button"
          className={`provider-pill${side === value ? ' provider-pill-active' : ''}`}
          onClick={() => {
            setSidebarSide(value);
            setSide(value);
          }}
        >
          {value === 'left' ? 'Left' : 'Right'}
        </button>
      ))}
    </div>
  );
}

interface MemorySectionProps {
  config: ConfigResponse | null;
  onRetrievalChange: (
    patch: Omit<Partial<NonNullable<ConfigResponse['retrieval']>>, 'maxTokens'> & {
      maxTokens?: number | null;
    },
  ) => Promise<void>;
  onSummarizationChange: (
    patch: Partial<NonNullable<ConfigResponse['summarization']>>,
  ) => Promise<void>;
}

function MemorySection({ config, onRetrievalChange, onSummarizationChange }: MemorySectionProps) {
  const retrievalMode =
    config?.retrieval?.mode ?? (config?.autoRecall?.enabled === false ? 'off' : 'balanced');
  const summarizeEnabled = config?.summarization?.enabled !== false;
  const retrievalBudget = config?.retrieval?.maxTokens;
  const minUserTurns = config?.summarization?.minUserTurns ?? 2;
  const idleHours = config?.summarization?.idleHours ?? 24;
  return (
    <section style={{ marginTop: '2rem' }}>
      <h3>Project knowledge &amp; memory</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Ground relevant turns in indexed project files, artifacts, memories, and shared documents.
        Finished threads can also be distilled into project memory for future work.
      </p>

      <div style={{ marginBottom: '1.25rem' }}>
        <strong>Indexed context per turn</strong>
        <p className="muted small" style={{ margin: '0.25rem 0 0' }}>
          Higher settings provide more direct evidence. Lower settings preserve context space on
          memory-constrained models. The gezel can still call <code>search</code> when this is Off.
        </p>
        <div className="provider-switch" style={{ marginTop: '0.5rem' }}>
          {(['off', 'lean', 'balanced', 'deep'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`provider-pill${retrievalMode === mode ? ' provider-pill-active' : ''}`}
              onClick={() => void onRetrievalChange({ mode })}
            >
              {mode[0]!.toUpperCase() + mode.slice(1)}
            </button>
          ))}
        </div>
        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <label className="muted small">Optional token cap</label>
          <input
            type="number"
            min={0}
            max={16000}
            value={retrievalBudget ?? ''}
            placeholder="Mode default"
            onChange={(e) => {
              if (e.target.value === '') {
                void onRetrievalChange({ maxTokens: null });
                return;
              }
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v >= 0) void onRetrievalChange({ maxTokens: v });
            }}
            style={{ width: '8rem' }}
            disabled={retrievalMode === 'off'}
          />
        </div>
      </div>

      <div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={summarizeEnabled}
            onChange={(e) => void onSummarizationChange({ enabled: e.target.checked })}
          />
          <strong>Summarize threads into project memory.</strong>
        </label>
        <p className="muted small" style={{ margin: '0.25rem 0 0 1.5rem' }}>
          Runs when a thread is archived, and on an hourly sweep for any thread that's been idle
          past the threshold. Short threads are skipped.
        </p>
        <div className="new-row" style={{ marginTop: '0.5rem', alignItems: 'center' }}>
          <label className="muted small">Idle after (hours)</label>
          <input
            type="number"
            min={1}
            max={720}
            value={idleHours}
            onChange={(e) => {
              const v = Number.parseFloat(e.target.value);
              if (Number.isFinite(v) && v > 0) void onSummarizationChange({ idleHours: v });
            }}
            style={{ width: '5rem' }}
            disabled={!summarizeEnabled}
          />
          <label className="muted small" style={{ marginLeft: '1rem' }}>
            Min user turns
          </label>
          <input
            type="number"
            min={1}
            max={50}
            value={minUserTurns}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) void onSummarizationChange({ minUserTurns: v });
            }}
            style={{ width: '5rem' }}
            disabled={!summarizeEnabled}
          />
        </div>
      </div>
    </section>
  );
}

type EngagementMode = 'proactive' | 'scheduled' | 'reactive' | 'off';
type WorkshopTempo = 'gezellig' | 'bedrijvig' | 'druk' | 'dolle-boel';

const TEMPOS: {
  id: WorkshopTempo;
  label: string;
  hint: string;
  description: string;
}[] = [
  {
    id: 'gezellig',
    label: 'Gezellig',
    hint: 'cozy',
    description:
      'Meester checks in rarely and warmly. 2-hour rapid cadence, 12-hour slow. Nudges sound like "no rush, let me know."',
  },
  {
    id: 'bedrijvig',
    label: 'Bedrijvig',
    hint: 'busy (default)',
    description:
      'The standard pace. 20-minute rapid cadence, 6-hour slow. Nudges are neutral and structured.',
  },
  {
    id: 'druk',
    label: 'Druk',
    hint: 'pressured',
    description:
      'Short gaps, direct tone. 8-minute rapid cadence, 1-hour slow. Meester expects a blocker-or-status answer.',
  },
  {
    id: 'dolle-boel',
    label: 'Dolle boel',
    hint: 'madhouse',
    description:
      "3-minute rapid cadence, 20-minute slow. Nudges arrive IN CAPS and end with 'this is fine 🔥'.",
  },
];

const ENGAGEMENT_MODES: {
  id: EngagementMode;
  label: string;
  description: string;
}[] = [
  {
    id: 'proactive',
    label: 'Proactive',
    description:
      'Default. All task work, scheduled triggers, proactive prompts, anti-stall nudges, voorman health checks, and cross-gezel messaging run.',
  },
  {
    id: 'scheduled',
    label: 'Tasks + Reactive',
    description:
      'Chat works, all active task work continues, and scheduled tasks still fire. No proactive nudges or cross-gezel messaging between gezellen.',
  },
  {
    id: 'reactive',
    label: 'Reactive only',
    description:
      'AI only responds to your direct chat messages. New task steps and scheduled jobs are paused; an in-flight turn can finish. No proactive nudges or cross-gezel messages.',
  },
  {
    id: 'off',
    label: 'Off',
    description:
      'AI is disabled. Chat is inactive and all background activity is paused. The current in-flight turn finishes; queued messages are canceled.',
  },
];

function EngagementModePanel({
  mode,
  tempo,
  onChange,
  onTempoChange,
}: {
  mode: EngagementMode;
  tempo: WorkshopTempo;
  onChange: (mode: EngagementMode) => void | Promise<void>;
  onTempoChange: (tempo: WorkshopTempo) => void | Promise<void>;
}) {
  const current =
    ENGAGEMENT_MODES.find((m) => m.id === mode) ??
    (ENGAGEMENT_MODES[0] as (typeof ENGAGEMENT_MODES)[number]);
  const currentTempo = TEMPOS.find((t) => t.id === tempo) ?? (TEMPOS[1] as (typeof TEMPOS)[number]);
  return (
    <section className={`engagement-mode-panel engagement-mode-${mode}`}>
      <h3>AI engagement</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Global control over how much AI activity is allowed. Use this as a panic button when you
        want to conserve tokens or step away from the app.
      </p>
      <div className="engagement-mode-switch gz-tray" role="radiogroup" aria-label="AI engagement">
        {ENGAGEMENT_MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
            role="radio"
            aria-checked={mode === m.id}
            className={`gz-key${mode === m.id ? ' gz-key-active' : ''}`}
            onClick={() => void onChange(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <p className="engagement-mode-description">{current.description}</p>
      {mode === 'off' && (
        <div className="engagement-mode-banner" role="alert">
          AI is disabled. The chat composer is inactive and all background activity is paused.
        </div>
      )}
      {mode === 'proactive' && (
        <div className="workshop-tempo">
          <h4 className="workshop-tempo-heading">Tempo</h4>
          <p className="muted small" style={{ margin: '0 0 0.5rem' }}>
            How frenetic the meester and voormannen feel. Adjusts check-in intervals and the tone of
            the meester's nudges.
          </p>
          <div className="workshop-tempo-switch gz-tray" role="radiogroup" aria-label="Tempo">
            {TEMPOS.map((t) => (
              <button
                key={t.id}
                type="button"
                // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native <input type="radio"> can't carry the keys-in-trays treatment.
                role="radio"
                aria-checked={tempo === t.id}
                className={`gz-key gz-key--stacked${tempo === t.id ? ' gz-key-active' : ''}`}
                onClick={() => void onTempoChange(t.id)}
                title={t.hint}
              >
                <span className="workshop-tempo-pill-label">{t.label}</span>
                <span className="workshop-tempo-pill-hint">{t.hint}</span>
              </button>
            ))}
          </div>
          <p className="engagement-mode-description">{currentTempo.description}</p>
        </div>
      )}
    </section>
  );
}
