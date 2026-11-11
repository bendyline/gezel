import {
  type ClaudePermissionMode,
  type GezelSummary,
  type HealthResponse,
  type ProviderName,
  displayName,
  isLocalProvider,
  isOllamaReasoningModel,
  normalizeCodexPermissionMode,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import type { ConfigResponse, UsageResponse } from '@bendyline/gezel-client';
import { Fragment, Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { AppleFoundationModelsStatus } from '../components/AppleFoundationModelsStatus.js';
import { CopilotInstallCard } from '../components/CopilotInstallCard.js';
import { CopilotLoginCommand } from '../components/CopilotLoginCommand.js';
import { GezelIcon } from '../components/GezelIcon.js';
import { HealthStrip } from '../components/HealthStrip.js';
import { InstallModelTuningEditor } from '../components/InstallModelTuningEditor.js';
import { requestMacUninstall } from '../components/MacUninstallDialog.js';
import { UserMemoriesEditor } from '../components/MemoriesTree.js';
import {
  EffortPicker,
  EffortTray,
  ModelPicker,
  useReasoningSupport,
  useRemoteServers,
} from '../components/ModelPicker.js';
import { NotificationsSetting } from '../components/NotificationsSetting.js';
import { RecommendedMediaDownloads } from '../components/RecommendedMediaDownloads.js';
import { ReportErrorLink } from '../components/ReportErrorLink.js';
import {
  SettingCheck,
  SettingField,
  SettingsSection,
  settingHintId,
} from '../components/SettingsSection.js';
import { SocialModeToggle } from '../components/SocialModeToggle.js';
import { StartAtLoginToggle } from '../components/StartAtLoginToggle.js';
import { shortModelName } from '../components/model-display-name.js';
import { providerLabel } from '../components/provider-label.js';
import { useCopilotAvailability } from '../components/useCopilotAvailability.js';
import { useTotalRamBytes } from '../components/useTotalRamBytes.js';
import {
  useRestoredViewPart,
  useViewLocation,
} from '../components/view-history/ViewHistoryContext.js';
import { Poppetje } from '../poppetje/index.js';
import { Select } from '../primitives/index.js';
import { onRadioKeyDown } from '../primitives/radio-keyboard.js';
import { UI_FALLBACK_PROVIDER } from '../provider-default.js';
import { SECURITY_LEVEL_PRESETS } from '../security-levels.js';
import { clearPendingSettingsSection, peekPendingSettingsSection } from '../settings-nav.js';
import {
  type EngagementMode,
  EngagementModePanel,
  type WorkshopTempo,
} from './EngagementModePanel.js';
import { GeneralistModeSection } from './GeneralistModeSection.js';
import { HostModelSettings } from './HostModelSettings.js';
import { MemorySection } from './MemorySection.js';
import { ProviderUsagePanel } from './ProviderUsagePanel.js';
import { SidebarSidePicker, ThemePicker } from './SettingsAppearance.js';
import { SettingsInterests } from './SettingsInterests.js';
import { SettingsLegalSection } from './SettingsLegal.js';
import { SettingsSectionPicker } from './SettingsSectionPicker.js';
import {
  AutostartToggle,
  BackgroundServiceStatus,
  LocalEngineStatus,
  UpdateStatus,
  formatStartedAt,
} from './SettingsSystemStatus.js';
import { CLAUDE_PERMISSION_CHOICES, CODEX_PERMISSION_CHOICES } from './cli-permission-choices.js';
import { detectDs4Availability } from './ds4-availability.js';
import { localEngineSettingsLabel } from './local-engine-label.js';
import {
  type WebSearchProviderSetting,
  visibleWebSearchProviderSetting,
  webSearchProviderOptions,
} from './web-search-provider-options.js';

const loadAmbientDashboardModule = () => import('../components/AmbientDashboardCard.js');
const loadConnectedAppsModule = () => import('../components/ConnectedAppsPanel.js');
const loadFaceRecognitionModule = () => import('../components/FaceRecognitionCard.js');
const loadMediaSearchModule = () => import('../components/MediaSearchCard.js');
const loadGildeUpdatesModule = () => import('../components/GildeUpdatesCard.js');
const loadKnowledgeCatalogsModule = () => import('../components/KnowledgeCatalogsCard.js');
const loadRemoteServersModule = () => import('../components/RemoteServersPanel.js');
const loadStorageUsageModule = () => import('../components/StorageUsageCard.js');
const loadToolsetsEditorModule = () => import('../components/ToolsetsEditor.js');
const loadAudioEngineSettingsModule = () => import('./AudioEngineSettings.js');
const loadBenchmarksModule = () => import('./BenchmarksView.js');
const loadChannelsSettingsModule = () => import('./ChannelsSettings.js');
const loadDs4SettingsModule = () => import('./Ds4Settings.js');
const loadFoldersSettingsModule = () => import('./FoldersSettings.js');
const loadImageEngineSettingsModule = () => import('./ImageEngineSettings.js');
const loadImageRecognitionSettingsModule = () => import('./ImageRecognitionSettings.js');
const loadLlamaCppSettingsModule = () => import('./LlamaCppSettings.js');
const loadMlxSettingsModule = () => import('./MlxSettings.js');
const loadMicrophoneSettingsModule = () => import('./MicrophoneSettings.js');
const loadOllamaSettingsModule = () => import('./OllamaSettings.js');
const loadSecurityComplianceSettingsModule = () => import('./SecurityComplianceSettings.js');
const loadVideoEngineSettingsModule = () => import('./VideoEngineSettings.js');

const AmbientDashboardCard = lazy(() =>
  loadAmbientDashboardModule().then(({ AmbientDashboardCard }) => ({
    default: AmbientDashboardCard,
  })),
);
const ConnectedAppsPanel = lazy(() =>
  loadConnectedAppsModule().then(({ ConnectedAppsPanel }) => ({ default: ConnectedAppsPanel })),
);
const AccountsPanel = lazy(() =>
  import('../components/AccountsPanel.js').then(({ AccountsPanel }) => ({
    default: AccountsPanel,
  })),
);
const MediaSearchCard = lazy(() =>
  loadMediaSearchModule().then(({ MediaSearchCard }) => ({ default: MediaSearchCard })),
);
const FaceRecognitionCard = lazy(() =>
  loadFaceRecognitionModule().then(({ FaceRecognitionCard }) => ({ default: FaceRecognitionCard })),
);
const GildeUpdatesCard = lazy(() =>
  loadGildeUpdatesModule().then(({ GildeUpdatesCard }) => ({ default: GildeUpdatesCard })),
);
const KnowledgeCatalogsCard = lazy(() =>
  loadKnowledgeCatalogsModule().then(({ KnowledgeCatalogsCard }) => ({
    default: KnowledgeCatalogsCard,
  })),
);
const MicrophoneSettings = lazy(() =>
  loadMicrophoneSettingsModule().then(({ MicrophoneSettings }) => ({
    default: MicrophoneSettings,
  })),
);
const RemoteServersPanel = lazy(() =>
  loadRemoteServersModule().then(({ RemoteServersPanel }) => ({ default: RemoteServersPanel })),
);
const StorageUsageCard = lazy(() =>
  loadStorageUsageModule().then(({ StorageUsageCard }) => ({ default: StorageUsageCard })),
);
const ToolsetsEditor = lazy(() =>
  loadToolsetsEditorModule().then(({ ToolsetsEditor }) => ({ default: ToolsetsEditor })),
);
const AudioEngineSettings = lazy(() =>
  loadAudioEngineSettingsModule().then(({ AudioEngineSettings }) => ({
    default: AudioEngineSettings,
  })),
);
const BenchmarksView = lazy(() =>
  loadBenchmarksModule().then(({ BenchmarksView }) => ({ default: BenchmarksView })),
);
const ChannelsSettings = lazy(() =>
  loadChannelsSettingsModule().then(({ ChannelsSettings }) => ({ default: ChannelsSettings })),
);
const Ds4Settings = lazy(() =>
  loadDs4SettingsModule().then(({ Ds4Settings }) => ({ default: Ds4Settings })),
);
const FoldersSettings = lazy(() =>
  loadFoldersSettingsModule().then(({ FoldersSettings }) => ({ default: FoldersSettings })),
);
const ImageEngineSettings = lazy(() =>
  loadImageEngineSettingsModule().then(({ ImageEngineSettings }) => ({
    default: ImageEngineSettings,
  })),
);
const ImageRecognitionSettings = lazy(() =>
  loadImageRecognitionSettingsModule().then(({ ImageRecognitionSettings }) => ({
    default: ImageRecognitionSettings,
  })),
);
const LlamaCppSettings = lazy(() =>
  loadLlamaCppSettingsModule().then(({ LlamaCppSettings }) => ({ default: LlamaCppSettings })),
);
const MlxSettings = lazy(() =>
  loadMlxSettingsModule().then(({ MlxSettings }) => ({ default: MlxSettings })),
);
const OllamaSettings = lazy(() =>
  loadOllamaSettingsModule().then(({ OllamaSettings }) => ({ default: OllamaSettings })),
);
const SecurityComplianceSettings = lazy(() =>
  loadSecurityComplianceSettingsModule().then(({ SecurityComplianceSettings }) => ({
    default: SecurityComplianceSettings,
  })),
);
const VideoEngineSettings = lazy(() =>
  loadVideoEngineSettingsModule().then(({ VideoEngineSettings }) => ({
    default: VideoEngineSettings,
  })),
);

type CodexCliReasoningEffort = NonNullable<
  NonNullable<ConfigResponse['codexCli']>['defaultReasoningEffort']
>;

/**
 * Label for a gezel in one of the role-assignment pickers. Boring mode renders
 * the role-based name, which already says the role, so the `— Role` suffix is
 * dropped instead of doubled.
 */
function assignmentLabel(gezel: GezelSummary, roleBasedNameOnly: boolean): string {
  const name = displayName(gezel, roleBasedNameOnly);
  return !roleBasedNameOnly && gezel.role ? `${name} — ${gezel.role}` : name;
}

const INCLUDE_TESTING_WEB_SEARCH_PROVIDER = import.meta.env.DEV;
const WEB_SEARCH_PROVIDER_OPTIONS = webSearchProviderOptions(INCLUDE_TESTING_WEB_SEARCH_PROVIDER);

type SectionId =
  | 'general'
  | 'deviceIntegration'
  | 'team'
  | 'aboutYou'
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
  | 'nightShift'
  // Header-only id for the collapsible "More settings" group — never the
  // active section (it renders no panel), it just toggles its children's
  // visibility.
  | 'more'
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
  | 'accounts'
  | 'about'
  | 'benchmarks';

const SECTION_IDS: ReadonlySet<string> = new Set<SectionId>([
  'general',
  'deviceIntegration',
  'team',
  'aboutYou',
  'folders',
  'defaults',
  'copilot',
  'openai',
  'codexCli',
  'anthropic',
  'anthropicCli',
  'ollama',
  'llamaCpp',
  'mlx',
  'ds4',
  'nightShift',
  'imageEngine',
  'videoEngine',
  'imageRecognition',
  'audio',
  'webSearch',
  'channels',
  'connectedApps',
  'remoteServers',
  'toolsets',
  'knowledge',
  'securityCompliance',
  'accounts',
  'about',
  'benchmarks',
]);

/** A section that opens a page. Never the More settings heading, which opens none. */
function isSectionId(value: unknown): value is SectionId {
  return typeof value === 'string' && SECTION_IDS.has(value);
}

function preloadSettingsSection(section: SectionId): void {
  let loading: Promise<unknown> | undefined;
  switch (section) {
    case 'deviceIntegration':
      loading = Promise.all([loadAmbientDashboardModule(), loadMicrophoneSettingsModule()]);
      break;
    case 'folders':
      loading = loadFoldersSettingsModule();
      break;
    case 'ollama':
      loading = loadOllamaSettingsModule();
      break;
    case 'llamaCpp':
      loading = loadLlamaCppSettingsModule();
      break;
    case 'ds4':
      loading = loadDs4SettingsModule();
      break;
    case 'mlx':
      loading = loadMlxSettingsModule();
      break;
    case 'imageEngine':
      loading = loadImageEngineSettingsModule();
      break;
    case 'videoEngine':
      loading = loadVideoEngineSettingsModule();
      break;
    case 'imageRecognition':
      loading = Promise.all([
        loadImageRecognitionSettingsModule(),
        loadMediaSearchModule(),
        loadFaceRecognitionModule(),
      ]);
      break;
    case 'audio':
      loading = loadAudioEngineSettingsModule();
      break;
    case 'channels':
      loading = loadChannelsSettingsModule();
      break;
    case 'connectedApps':
      loading = loadConnectedAppsModule();
      break;
    case 'remoteServers':
      loading = loadRemoteServersModule();
      break;
    case 'knowledge':
      loading = loadKnowledgeCatalogsModule();
      break;
    case 'toolsets':
      loading = loadToolsetsEditorModule();
      break;
    case 'securityCompliance':
      loading = loadSecurityComplianceSettingsModule();
      break;
    case 'about':
      loading = Promise.all([loadGildeUpdatesModule(), loadStorageUsageModule()]);
      break;
    case 'benchmarks':
      loading = loadBenchmarksModule();
      break;
    default:
      break;
  }
  void loading?.catch(() => {});
}

// A visual/collapsible nav group. `group` marks a child item (drawn with a
// small vertical rail on the left so it reads as nested); `groupHeader` marks
// the item that labels and expand/collapses that group.
type SettingsGroup = 'ai' | 'more';
type SettingsNavEntry = {
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

/**
 * The provider tabs that only exist to configure an *external* chat provider.
 * Hidden wholesale when the security posture forbids external chat — the
 * daemon refuses to construct these providers, so their sign-in flows and
 * permission modes configure nothing. Local engines (llama.cpp / MLX / ds4 /
 * Ollama) are always permitted and never appear here.
 */
const EXTERNAL_CHAT_SECTIONS: ReadonlySet<SectionId> = new Set<SectionId>([
  'copilot',
  'openai',
  'codexCli',
  'anthropic',
  'anthropicCli',
]);

/**
 * The nav, in order. What most people open sits at the top level; the pages a
 * person sets up once, or that only some installs use, sit under "More
 * settings" so the list reads as about eight rows (docs/ux.md, "Settings
 * pages").
 */
function buildSections(platform: string | undefined): SettingsNavEntry[] {
  return [
    { id: 'general', label: 'General' },
    { id: 'aboutYou', label: 'About you' },
    { id: 'securityCompliance', label: 'Security & compliance' },
    { id: 'defaults', label: 'Artificial intelligence', groupHeader: 'ai' },
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
    { id: 'nightShift', label: 'Night Shift' },
    { id: 'connectedApps', label: 'Integrations' },
    { id: 'about', label: 'About' },
    { id: 'more', label: 'More settings', groupHeader: 'more' },
    { id: 'deviceIntegration', label: 'Device integration', group: 'more' },
    { id: 'team', label: 'Your team', group: 'more' },
    { id: 'folders', label: 'Folders', group: 'more' },
    { id: 'accounts', label: 'Accounts', group: 'more' },
    { id: 'imageEngine', label: 'Image generation', group: 'more' },
    { id: 'videoEngine', label: 'Video generation', group: 'more' },
    { id: 'imageRecognition', label: 'Image recognition', group: 'more' },
    { id: 'audio', label: 'Audio', group: 'more' },
    { id: 'webSearch', label: 'Web search', group: 'more' },
    { id: 'knowledge', label: 'Knowledge', group: 'more' },
    { id: 'benchmarks', label: 'Benchmarks', group: 'more' },
    { id: 'channels', label: 'Channels', group: 'more' },
    { id: 'remoteServers', label: 'Remote servers', group: 'more' },
    { id: 'toolsets', label: 'Shared toolsets', group: 'more' },
  ];
}

/**
 * The group a section sits in. A header that opens a page of its own
 * (Artificial intelligence) counts as inside its group, so opening that page
 * shows the pages under it.
 */
const SECTION_GROUPS: ReadonlyMap<SectionId, SettingsGroup> = new Map(
  buildSections(undefined).flatMap((s) => {
    const group = s.group ?? s.groupHeader;
    return group ? [[s.id, group] as const] : [];
  }),
);

export function SettingsView() {
  if (window.__GEZEL__?.renderModelSettings) return <HostModelSettings />;
  return <DaemonSettingsView />;
}

function DaemonSettingsView() {
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
  const boringMode = config?.roleBasedNameOnlyMode === true;
  // Enabling supervision sends conversation excerpts to a cloud provider,
  // so the toggle goes through an explicit consent step (see the
  // Keurmeester section) instead of saving on click.
  const [keurmeesterConsentOpen, setKeurmeesterConsentOpen] = useState(false);
  // A caller (e.g. the first-run Home "manage on-device models" link) can
  // request a section before this view mounts; read it as the initial
  // section so the deep link doesn't race the event listener below. The
  // read is non-destructive and the clear waits for a committed mount: a
  // lazy view's first render can be discarded — see settings-nav.ts.
  // A link that names a section wins; otherwise Back's restored section.
  const restoredSection = useRestoredViewPart('settings');
  const [section, setSection] = useState<SectionId>(
    () =>
      (peekPendingSettingsSection() as SectionId | null) ??
      (isSectionId(restoredSection?.value) ? restoredSection.value : 'general'),
  );
  useEffect(() => clearPendingSettingsSection(), []);
  // The view stack: each section is a place. Declared ahead of the redirect
  // effects below so their replaceNext lands on the report it is meant for.
  const sectionLabels = useMemo(
    () => new Map(buildSections(window.__GEZEL__?.platform).map((s) => [s.id, s.label])),
    [],
  );
  const settingsLocation = useViewLocation('settings', {
    part: { key: section, value: section, label: sectionLabels.get(section) ?? 'Settings' },
    onRestore: (part) => {
      if (isSectionId(part.value)) setSection(part.value);
    },
  });
  const replaceNextLocation = settingsLocation.replaceNext;
  // Open nav groups. Both start folded, so the list opens on about eight rows;
  // the group holding the active section is opened, and the "Artificial
  // intelligence" and "More settings" headers toggle membership here. Kept in
  // memory: a group stays as the person left it for the life of the view.
  const [expandedGroups, setExpandedGroups] = useState<Set<SettingsGroup>>(() => {
    const group = SECTION_GROUPS.get(section);
    return new Set(group ? [group] : []);
  });
  const toggleGroup = useCallback((g: SettingsGroup) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  }, []);
  const revealGroupOf = useCallback((id: SectionId) => {
    const group = SECTION_GROUPS.get(id);
    if (!group) return;
    setExpandedGroups((prev) => (prev.has(group) ? prev : new Set(prev).add(group)));
  }, []);
  // Every way of landing on a section passes through here: a click, a link
  // from inside a page, a deep link, a redirect, and a section Back restores.
  useEffect(() => revealGroupOf(section), [section, revealGroupOf]);
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

  // Probe Copilot on open only where the person uses it. Any Copilot CLI on
  // the machine makes it look installed, so opening this page on an install
  // that never chose it showed a red start failure for a provider nobody set
  // up (2026-11-09). Test connection still probes on demand.
  const copilotInUse = copilotIsInUse(config, gezels);
  useEffect(() => {
    if (section === 'copilot' && copilotInUse && copilotProbe.kind === 'idle') {
      void runCopilotProbe();
    }
  }, [section, copilotInUse, copilotProbe.kind, runCopilotProbe]);

  // Channels sits in the work-in-progress bucket, so a deep link or a
  // still-open Channels panel can outlive the opt-in it depends on. Wait for
  // config to load before deciding, or the first paint bounces the user out.
  useEffect(() => {
    if (section === 'channels' && config && config.showWorkInProgressFeatures !== true) {
      replaceNextLocation('general');
      setSection('general');
    }
  }, [section, config, replaceNextLocation]);

  const setMeester = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ meesterGezelId: id });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus('meester updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
      throw err;
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
      throw err;
    }
  }, []);

  const setKlerk = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ klerkGezelId: id });
      setConfig(res);
      setStatus('scribe updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const createNewKlerk = useCallback(async (name?: string) => {
    setStatus('creating new scribe…');
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
      setStatus(`created & activated scribe "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const setBoekwachter = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ boekwachterGezelId: id });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus('librarian updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const createNewBoekwachter = useCallback(async (name?: string) => {
    setStatus('creating new librarian…');
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
      setStatus(`created & activated librarian "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const setKeurmeester = useCallback(async (id: string) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ keurmeesterGezelId: id });
      setConfig(res);
      setStatus('inspector updated');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const createNewKeurmeester = useCallback(async (name?: string) => {
    setStatus('creating new inspector…');
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
      setStatus(`created & activated inspector "${res.gezel.name}"`);
    } catch (err) {
      setStatus(`create failed: ${(err as Error).message}`);
      throw err;
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

  const setProvider = useCallback(
    async (provider: ProviderName, defaultModel?: ConfigResponse['defaultModel']) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig({ provider, ...(defaultModel ? { defaultModel } : {}) });
        setConfig(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus('saved — open chats restart on their next message.');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

  const saveDebugMode = useCallback(async (debugMode: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ debugMode });
      setConfig(res);
      // Open conversations and panes read the flag live through useDebugMode.
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
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
          ? 'template-based crew members will reset to defaults on each startup'
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
        setStatus(showWorkInProgressFeatures ? 'preview features ON' : 'preview features OFF');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

  const resetTemplatesNow = useCallback(async () => {
    if (
      !window.confirm(
        'Reset all template-based crew members back to their default instructions? Any edits you have made to their About section will be lost.',
      )
    ) {
      return;
    }
    setStatus('resetting templates…');
    try {
      const res = await api.resetGezelTemplates();
      const n = res.reset.length;
      setStatus(`reset ${n} ${n === 1 ? 'crew member' : 'crew members'} to template defaults`);
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

  /**
   * How long a SENT prompt draft is kept. The sweep also removes the files
   * that draft attached, which a message in the transcript may still be
   * showing — so the copy says that plainly rather than presenting this as
   * free disk hygiene.
   */
  const savePromptDraftRetention = useCallback(async (keepSentDays: number) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ promptDrafts: { keepSentDays } });
      setConfig(res);
      setStatus('draft retention saved');
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
      pauseOnBattery?: boolean;
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

  /**
   * One switch over the two persisted display flags (roleBasedNameOnlyMode +
   * showPoppetjes) — the UI deliberately offers no way to set them apart.
   * Formerly "Boring mode": the negative in-joke framing read poorly during
   * onboarding (2026-09-02 UX review), so both first run and Settings now ask
   * the same positive question. The flags stay separate in config for API
   * compatibility.
   */
  const saveShowNamesAndPoppetjes = useCallback(async (show: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ roleBasedNameOnlyMode: !show, showPoppetjes: show });
      setConfig(res);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
      setStatus(
        show
          ? 'names and poppetjes are shown'
          : 'role-based names and plain letter avatars are shown',
      );
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  /**
   * Inline proofing toggles (Documents). The `gezel:config-updated`
   * dispatch is what reaches the open editors: their capability hook
   * listens for it, so a squiggle disappears while the document stays on
   * screen instead of waiting for the next keystroke.
   */
  const saveInlineProofing = useCallback(
    async (patch: { inlineSpellChecking?: boolean; inlineGrammarChecking?: boolean }) => {
      setStatus('saving…');
      try {
        const res = await api.updateConfig(patch);
        setConfig(res);
        window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
        setStatus('proofing preferences saved');
      } catch (err) {
        setStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [],
  );

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
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
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
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
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
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
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
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
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
        | 'ds4'
        | 'remote',
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

  // The Default provider screen mirrors each CLI's model controls, but only
  // once that CLI has answered a probe, so it needs the same probe on entry.
  const claudePermissionCurrent: ClaudePermissionMode =
    config?.anthropicCli?.defaultPermissionMode ?? 'acceptEdits';
  const claudePermissionChoice =
    CLAUDE_PERMISSION_CHOICES.find((choice) => choice.id === claudePermissionCurrent) ??
    CLAUDE_PERMISSION_CHOICES[0]!;
  const codexPermissionCurrent = normalizeCodexPermissionMode(
    config?.codexCli?.defaultPermissionMode,
  );
  const codexPermissionChoice =
    CODEX_PERMISSION_CHOICES.find((choice) => choice.id === codexPermissionCurrent) ??
    CODEX_PERMISSION_CHOICES[0]!;

  const configuredProvider = config?.provider;
  const anthropicCliControlsShown =
    section === 'anthropicCli' ||
    (section === 'defaults' && configuredProvider === 'anthropic-cli');
  const codexCliControlsShown =
    section === 'codexCli' || (section === 'defaults' && configuredProvider === 'codex-cli');
  useEffect(() => {
    if (anthropicCliControlsShown) void runAnthropicCliProbe();
  }, [anthropicCliControlsShown, runAnthropicCliProbe]);
  useEffect(() => {
    if (codexCliControlsShown) void runCodexCliProbe();
  }, [codexCliControlsShown, runCodexCliProbe]);

  const anthropicCliReasoningSupported = useReasoningSupport(
    'anthropic-cli',
    config?.defaultModel?.['anthropic-cli'],
    undefined,
    anthropicCliControlsShown && anthropicCliProbe.kind === 'ok',
  );
  const codexCliReasoningSupported = useReasoningSupport(
    'codex-cli',
    config?.defaultModel?.['codex-cli'],
    'gpt-6.1-sol',
    codexCliControlsShown && codexCliProbe.kind === 'ok',
  );

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

  const saveEngagementMode = useCallback(async (mode: EngagementMode) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ aiEngagementMode: mode });
      setConfig(res);
      setStatus(`AI engagement: ${mode}`);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

  const saveWorkshopTempo = useCallback(async (tempo: WorkshopTempo) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ workshopTempo: tempo });
      setConfig(res);
      setStatus(`tempo: ${tempo}`);
      window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

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

  const setTaskReferences = useCallback(async (enabled: boolean) => {
    setStatus('saving…');
    try {
      const res = await api.updateConfig({ taskReferences: { enabled } });
      setConfig(res);
      setStatus('reference lookup saved');
    } catch (err) {
      setStatus(`save failed: ${(err as Error).message}`);
    }
  }, []);

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
  const copilotSignedInViaCli = !hasGithubToken && copilotProbe.kind === 'ok' && !!copilotLogin;
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
  // The same facts the DwarfStar tab itself reads: with fewer, the tab
  // showed on a machine whose daemon has no build and then said so inside.
  const showDs4Provider =
    provider === 'ds4' ||
    nightShiftProvider === 'ds4' ||
    detectDs4Availability({
      externalBaseUrl: config?.ds4BaseUrl,
      totalRamBytes: totalRamBytes ?? undefined,
      ds4ServerBundled: health?.ds4ServerBundled,
      serverPlatform: health?.platform,
      detectedBackend: health?.llamaCppDetectedBackend,
      gpuVendor: health?.llamaCppDetectedVendor,
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

  // Apple's own on-device model needs no download, only an Apple silicon Mac
  // with the helper installed; a chosen provider stays on offer regardless.
  const showAppleProvider =
    provider === 'apple-foundation-models' ||
    config?.appleFoundationModelsStatus?.installed === true;

  // Models on paired servers (Settings → Remote servers). Offered once a
  // server shares at least one, and kept on offer while one is chosen. Read
  // outside this tab only when a paired server is in use, for the nav subline.
  const remoteServers = useRemoteServers(
    section === 'defaults' || provider === 'remote' || nightShiftProvider === 'remote',
  );
  const remoteModels = useMemo(
    () =>
      (remoteServers ?? []).flatMap((server) => server.models.map((model) => ({ server, model }))),
    [remoteServers],
  );
  const showRemoteProvider =
    provider === 'remote' || nightShiftProvider === 'remote' || remoteModels.length > 0;
  const remoteServerNames = [...new Set(remoteModels.map(({ server }) => server.displayName))];
  const remoteProviderLabel =
    remoteServerNames.length === 1 ? remoteServerNames[0]! : providerLabel('remote', uiPlatform);
  const remoteProviderTitle =
    'Use a model on another gezel device you connected to. Your files and chats stay here; only the model runs there.';
  // A remote choice must name a model — the id is what selects the server —
  // so switching to one keeps the saved model while it's still offered and
  // otherwise starts on the first.
  const startingRemoteModel = (saved: string | undefined): string | undefined =>
    saved && remoteModels.some(({ model }) => model.id === saved)
      ? saved
      : remoteModels[0]?.model.id;
  const selectRemoteProvider = () => {
    const saved = config?.defaultModel?.remote;
    const model = startingRemoteModel(saved);
    void setProvider(
      'remote',
      model && model !== saved ? { ...(config?.defaultModel ?? {}), remote: model } : undefined,
    );
  };

  // Super Lockdown — and any custom posture with external chat switched off —
  // refuses to build a non-local provider at all: `ChatManager.ensureProvider`
  // throws before the SDK or CLI is touched. Offering those as live choices
  // produced a configured-but-unusable install, and the failure landed far
  // from the cause: a stored `codex-cli` default whose probe came back
  // policy-blocked sent the whole app back through first-run onboarding.
  //
  // The capability is the gate, not the level name, so a custom posture that
  // turns external chat off behaves identically. A config that hasn't loaded
  // yet resolves fail-safe to Lockdown (external chat allowed), which keeps
  // the pills from blinking out on every mount.
  const externalChatPolicy = resolveSecurityPolicy({ securityPolicy: config?.securityPolicy });
  const externalChatBlocked = !externalChatPolicy.allowExternalChat;
  const securityLevelLabel =
    SECURITY_LEVEL_PRESETS.find((p) => p.id === externalChatPolicy.level)?.label ??
    'your current security level';
  const blockedProviderTitle = (name: ProviderName) =>
    `${providerLabel(name, uiPlatform)} sends chat off this device, which ${securityLevelLabel} does not allow. Change the level in Security & compliance to use it.`;
  /**
   * Blocked *and* on offer — the pill stays, greyed, so the state is legible.
   * The daemon doesn't hold paired-server turns to the external-chat switch,
   * so greying that pill would claim a block that isn't there.
   */
  const providerBlocked = (name: ProviderName) =>
    externalChatBlocked && !isLocalProvider(name) && name !== 'remote';

  // Subline under the "Artificial intelligence" nav header: which engine and
  // model a new chat gets by default. Answering that used to mean opening the
  // tab and reading two controls.
  //
  // Only the on-device engines get a name lookup, and only through their own
  // installed-model listing — the generic /api/models route reaches out to the
  // provider (and can auto-start Ollama), which is too much to spend on a nav
  // label. Cloud providers show the configured id, which is already the name
  // people use for those models ("gpt-6.1-sol").
  const configuredDefaultModel = config?.defaultModel?.[provider];
  const [defaultModelName, setDefaultModelName] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (provider !== 'mlx' && provider !== 'llama-cpp' && provider !== 'ds4') {
      setDefaultModelName(configuredDefaultModel);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res =
          provider === 'mlx'
            ? await api.listMlxModels()
            : provider === 'ds4'
              ? await api.listDs4Models()
              : await api.listLlamaCppModels();
        if (cancelled) return;
        // With no configured default the engine runs the first installed
        // model, the same fallback the header engine pill reports.
        const models = res.models ?? [];
        const match = configuredDefaultModel
          ? models.find((m) => m.id === configuredDefaultModel)
          : models[0];
        setDefaultModelName(match?.name ?? configuredDefaultModel);
      } catch {
        if (!cancelled) setDefaultModelName(configuredDefaultModel);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider, configuredDefaultModel]);

  const aiDefaultSubline = useMemo(() => {
    if (provider === 'remote') {
      // A bare `remote:<id>/<model>` id is not a name anyone would recognize.
      const match = remoteModels.find(({ model }) => model.id === configuredDefaultModel);
      return match
        ? `Default: ${match.server.displayName} · ${shortModelName(match.model.name)}`
        : `Default: ${providerLabel('remote', uiPlatform)}`;
    }
    const engine = providerLabel(provider, uiPlatform);
    const model = shortModelName(defaultModelName);
    return `Default: ${engine}${model ? ` · ${model}` : ''}`;
  }, [provider, uiPlatform, defaultModelName, remoteModels, configuredDefaultModel]);

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
    ...(showRemoteProvider
      ? [{ id: 'remote' as const, label: remoteProviderLabel, title: remoteProviderTitle }]
      : []),
    ...(showCopilotProvider ? [{ id: 'copilot' as const, label: 'GitHub Copilot' }] : []),
    { id: 'openai', label: 'OpenAI' },
    { id: 'codex-cli', label: 'OpenAI Codex CLI' },
    { id: 'anthropic', label: 'Anthropic Claude' },
    { id: 'anthropic-cli', label: 'Anthropic Claude CLI' },
    { id: 'ollama', label: 'Ollama' },
  ];

  // Developer areas show in debug mode, or once this install uses them, so
  // nobody loses a setting they rely on.
  const [sharedToolsetCount, setSharedToolsetCount] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .listInstalledToolsets({ kind: 'shared' })
      .then((res) => {
        if (!cancelled) setSharedToolsetCount(res.toolsets.length);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  // Accounts sign people in from a browser (ADR 0029). The tab shows where
  // they are in use: a daemon that requires them (a container), or one that
  // has some. The desktop app on its own never needs it.
  const [accountsInUse, setAccountsInUse] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.accounts
      .getSignInState()
      .then((state) => {
        if (!cancelled) setAccountsInUse(state.accountsRequired || !state.setupRequired);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const usesProvider = (name: ProviderName) =>
    provider === name ||
    nightShiftProvider === name ||
    Boolean(config?.defaultModel?.[name as keyof NonNullable<typeof config.defaultModel>]);
  const developerAreaShown: Partial<Record<string, boolean>> = {
    accounts: accountsInUse,
    ollama: usesProvider('ollama') || Boolean(config?.ollamaBaseUrl),
    codexCli: usesProvider('codex-cli') || Boolean(config?.codexCli),
    anthropicCli: usesProvider('anthropic-cli') || Boolean(config?.anthropicCli),
    remoteServers: showRemoteProvider || config?.remoteServing?.enabled === true,
    // Unknown until the listing answers; the tab stays until it says empty.
    toolsets: sharedToolsetCount === null || sharedToolsetCount > 0,
  };
  const developerAreaKey = JSON.stringify(developerAreaShown);

  const sections = useMemo(() => {
    const all = buildSections(uiPlatform);
    const shown = JSON.parse(developerAreaKey) as Partial<Record<string, boolean>>;
    return all.filter((s) => {
      if (config?.debugMode !== true && shown[s.id] === false) return false;
      if (s.id === 'mlx' && !isDarwin) return false;
      // Keep the section available for supported native installs, configured
      // external servers, and an already-selected provider. The latter two
      // matter on Windows, where ds4 has no native build but remains usable
      // through an external server.
      if (s.id === 'ds4' && !showDs4Provider) return false;
      // A posture with external chat off can't run these at all, so their
      // setup tabs are dead ends — sign-in flows and CLI permission modes for
      // a provider the daemon refuses to construct. The greyed pill on the
      // Artificial intelligence tab carries the explanation.
      if (EXTERNAL_CHAT_SECTIONS.has(s.id) && externalChatBlocked) return false;
      // Channels is in the work-in-progress bucket alongside connectors —
      // hidden until the user opts in under About.
      if (s.id === 'channels' && config?.showWorkInProgressFeatures !== true) return false;
      return true;
    });
  }, [
    uiPlatform,
    isDarwin,
    showDs4Provider,
    externalChatBlocked,
    config?.debugMode,
    config?.showWorkInProgressFeatures,
    developerAreaKey,
  ]);

  // Cross-view deep links can jump straight to a Settings section via a
  // `gezel:navigate` event carrying
  // `{ view: 'settings', section: 'defaults' }`. Every section the nav offers
  // right now is accepted. The list used to be kept by hand and lagged the
  // nav, so a link to About you or Integrations worked only while Settings
  // was closed (the mount path reads the pending section instead).
  //
  // The cloud-provider pages are accepted even while the nav hides them.
  // Under a posture with external chat off, the redirect below sends the link
  // to the Artificial intelligence page, which says why the provider is gone.
  // And the title bar's quota meters link to the Codex and Claude CLI pages,
  // which the nav lists only once the install uses that provider by default.
  useEffect(() => {
    const offered = new Set<string>(sections.map((s) => s.id));
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent<{ view?: string; section?: string }>).detail;
      if (detail?.view !== 'settings' || !isSectionId(detail.section)) return;
      if (!offered.has(detail.section) && !EXTERNAL_CHAT_SECTIONS.has(detail.section)) return;
      setSection(detail.section);
      // The effect on `section` opens the group when the section changes; a
      // link to the section already open must also unfold a group the person
      // folded over it.
      revealGroupOf(detail.section);
    };
    window.addEventListener('gezel:navigate', onNav);
    return () => window.removeEventListener('gezel:navigate', onNav);
  }, [sections, revealGroupOf]);

  // Landing on a hidden tab is reachable two ways: the posture drops to Super
  // Lockdown while one is open, or a deep link (`peekPendingSettingsSection`)
  // points at one. Send those to the Artificial intelligence tab, where the
  // greyed pill explains why the provider is gone. Deliberately narrower than
  // "any section missing from `sections`" — config loads async, and a blanket
  // rule would bounce every deep link before its gate had an answer.
  useEffect(() => {
    if (externalChatBlocked && EXTERNAL_CHAT_SECTIONS.has(section)) {
      replaceNextLocation('defaults');
      setSection('defaults');
    }
  }, [externalChatBlocked, section, replaceNextLocation]);

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
        <SettingsSectionPicker
          // The More settings heading only groups its sections; it opens no
          // page. The dropdown reaches every section whatever is folded.
          sections={sections
            .filter((s) => s.id !== 'more')
            .map((s) => ({ id: s.id, label: s.label, child: Boolean(s.group) }))}
          value={section}
          onChange={(id) => {
            preloadSettingsSection(id as SectionId);
            setSection(id as SectionId);
          }}
        />
        <ul>
          {sections.map((s) => {
            // Hide children of a folded group.
            if (s.group && !expandedGroups.has(s.group)) return null;

            // Group header: a disclosure chevron that toggles the group, plus
            // the label. The AI header doubles as a real section ('defaults')
            // so its label opens that page and unfolds the pages under it;
            // the header-only 'More settings' label just toggles.
            if (s.groupHeader) {
              const group = s.groupHeader;
              const expanded = expandedGroups.has(group);
              const navigates = s.id !== 'more';
              return (
                <li key={s.id} className="settings-nav-li settings-nav-li-group">
                  <button
                    type="button"
                    data-testid={`settings-nav-group-${group}`}
                    className="settings-nav-group-toggle"
                    aria-expanded={expanded}
                    aria-label={`${expanded ? 'Collapse' : 'Expand'} ${s.label}`}
                    onClick={() => toggleGroup(group)}
                  >
                    <span className="settings-nav-caret" aria-hidden="true">
                      &rsaquo;
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid={`settings-nav-${s.id}`}
                    className={`settings-nav-item settings-nav-group-label${section === s.id ? ' settings-nav-item-active' : ''}`}
                    title={s.groupHeader === 'ai' ? aiDefaultSubline : undefined}
                    aria-expanded={navigates ? undefined : expanded}
                    onPointerEnter={() => preloadSettingsSection(s.id)}
                    onFocus={() => preloadSettingsSection(s.id)}
                    onPointerDown={() => preloadSettingsSection(s.id)}
                    onClick={() => {
                      if (!navigates) {
                        toggleGroup(group);
                        return;
                      }
                      setSection(s.id);
                      revealGroupOf(s.id);
                    }}
                  >
                    <span className="settings-nav-group-title">{s.label}</span>
                    {s.groupHeader === 'ai' && (
                      <span className="settings-nav-group-sub">{aiDefaultSubline}</span>
                    )}
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
                  onPointerEnter={() => preloadSettingsSection(s.id)}
                  onFocus={() => preloadSettingsSection(s.id)}
                  onPointerDown={() => preloadSettingsSection(s.id)}
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
        <Suspense fallback={null}>
          {section === 'general' && (
            <>
              <SettingsInterests />
              <SettingsSection id="settings-appearance" title="Appearance">
                <SettingField label="Theme" hint="Light or dark mode, or follow the OS.">
                  <ThemePicker />
                </SettingField>
                <SettingField
                  label="Sidebar position"
                  className="settings-sidebar-side"
                  hint="Which side the navigation rail (projects, crew, documents…) sits on."
                >
                  <SidebarSidePicker />
                </SettingField>
              </SettingsSection>
              <SettingsSection
                id="settings-names-character"
                title="Names and character"
                hint="How crew members look and talk to you."
              >
                <SettingCheck
                  label="Show names and poppetjes"
                  hint={
                    <>
                      Poppetjes are the little character figures shown beside each name. Turn this
                      off and everyone shows a role-based name (e.g. <code>visual-designer</code>{' '}
                      instead of "Mira") with a plain letter avatar; the role-based name also flows
                      into system prompts and chat handoffs, so the model addresses itself by role.
                    </>
                  }
                  checked={
                    config?.roleBasedNameOnlyMode !== true && config?.showPoppetjes !== false
                  }
                  onChange={(checked) => void saveShowNamesAndPoppetjes(checked)}
                  aside={(() => {
                    const meester = gezels.find((g) => g.id === config?.meesterGezelId);
                    // `.gezel-icon` clips the figure to a small box — a bare
                    // <Poppetje> paints its full body because the SVG is
                    // overflow:visible.
                    return meester?.poppetje ? (
                      <div className="gezel-icon settings-poppetje-example">
                        <div className="gezel-icon-poppetje">
                          <Poppetje poppetje={meester.poppetje} variant="headshot" size={40} />
                        </div>
                      </div>
                    ) : null;
                  })()}
                />
                <SocialModeToggle />
              </SettingsSection>
              <SettingsSection id="settings-notifications" title="Notifications">
                <NotificationsSetting />
              </SettingsSection>
              <SettingsSection
                id="settings-documents"
                title="Documents"
                hint="Spelling and grammar checking as you write in the document editors. It runs entirely on this machine — nothing is sent anywhere, and nothing is written into the document."
              >
                <SettingCheck
                  label="Show inline spell checking"
                  checked={config?.inlineSpellChecking !== false}
                  onChange={(checked) => void saveInlineProofing({ inlineSpellChecking: checked })}
                />
                <SettingCheck
                  label="Show inline grammar checking"
                  hint="Grammar checking is available for English only."
                  checked={config?.inlineGrammarChecking !== false}
                  onChange={(checked) =>
                    void saveInlineProofing({ inlineGrammarChecking: checked })
                  }
                />
              </SettingsSection>
              <SettingsSection
                id="settings-prompt-drafts"
                title="Prompt drafts"
                hint="A message you start writing is saved to the project as you type, so you can leave it and come back days later. Unsent drafts are kept until you delete them."
              >
                <SettingField
                  label="Keep sent drafts for"
                  controlId="settings-sent-draft-days"
                  hint="Enter 0 to keep them forever. Clearing out an old sent draft also removes the files it attached, so an image in a message that old stops showing in the transcript."
                >
                  <div className="gz-setting-inline">
                    <input
                      id="settings-sent-draft-days"
                      type="number"
                      min={0}
                      max={3650}
                      aria-describedby={settingHintId('settings-sent-draft-days')}
                      value={config?.promptDrafts?.keepSentDays ?? 90}
                      onChange={(e) => {
                        const days = Number.parseInt(e.target.value, 10);
                        if (Number.isFinite(days) && days >= 0) {
                          void savePromptDraftRetention(days);
                        }
                      }}
                    />
                    <span>days</span>
                  </div>
                </SettingField>
              </SettingsSection>
              <SettingsSection
                id="settings-gezel-templates"
                title="Role templates"
                hint={
                  <>
                    Restore every crew member created from a template back to the{' '}
                    <code>about.md</code> their template ships, discarding any edits you’ve made to
                    their instructions. Crew members written from scratch are left untouched.
                  </>
                }
                actions={
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void resetTemplatesNow()}
                  >
                    Reset to defaults
                  </button>
                }
              />
            </>
          )}

          {section === 'nightShift' && (
            <>
              <SettingsSection
                id="settings-night-shift"
                title="Night Shift"
                hint="During a nightly window, Gezel runs deferred batch work — content indexing and a daily Meester review of every active project, with suggestions waiting for you in the morning. Interactive and scheduled work always takes priority."
              >
                <SettingCheck
                  label="Enable Night Shift"
                  checked={config?.nightShift?.enabled !== false}
                  onChange={(checked) => void saveNightShift({ enabled: checked })}
                />
                <SettingField
                  label="Window"
                  hint="Local 24-hour time. The window can wrap past midnight."
                >
                  <div className="gz-setting-inline">
                    <span>From</span>
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
                      aria-label="Night Shift start hour"
                    />
                    <span>to</span>
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
                      aria-label="Night Shift end hour"
                    />
                  </div>
                </SettingField>
                <SettingCheck
                  label="Keep this machine awake while night-shift work is running"
                  checked={config?.nightShift?.keepAwakeWhileRunning === true}
                  onChange={(checked) => void saveNightShift({ keepAwakeWhileRunning: checked })}
                />
                <SettingCheck
                  label="Pause night work while this computer runs on battery"
                  checked={config?.nightShift?.pauseOnBattery !== false}
                  onChange={(checked) => void saveNightShift({ pauseOnBattery: checked })}
                />
                <StartAtLoginToggle />
                {isDarwin && (
                  <p className="gz-setting-hint">
                    macOS lets only administrators schedule a wake, so Gezel can't wake a sleeping
                    Mac for the night shift. It works through the night while the Mac stays awake
                    and plugged in.
                  </p>
                )}
              </SettingsSection>
              <SettingsSection
                id="settings-night-shift-quota"
                title="Night Shift cloud quota"
                hint="For Claude, Codex, and Copilot plans with usage quotas; check that your plan allows automated use. Work on local models is never held."
              >
                <SettingField
                  label="Hold night work when"
                  hint="The daily reserve scales with the time left: 10% a day with 4 days until reset keeps the last 40% for you. Work already running finishes; held work resumes when your quota frees up."
                >
                  <label className="gz-setting-inline">
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
                      disabled={config?.nightShift?.quotaReserve?.overall?.enabled === false}
                      aria-label="Overall quota floor percent"
                    />
                    <span>% of my overall quota</span>
                  </label>
                  <label className="gz-setting-inline">
                    <input
                      type="checkbox"
                      checked={config?.nightShift?.quotaReserve?.perDay?.enabled === true}
                      onChange={(e) =>
                        void saveNightShiftQuotaReserve('perDay', { enabled: e.target.checked })
                      }
                      aria-label="Reserve a share of my quota per day until reset"
                    />
                    <span>I have less than</span>
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
                      disabled={config?.nightShift?.quotaReserve?.perDay?.enabled !== true}
                      aria-label="Daily quota reserve percent"
                    />
                    <span>% of my quota per day left before it resets</span>
                  </label>
                </SettingField>
              </SettingsSection>
            </>
          )}

          {section === 'deviceIntegration' && (
            <>
              <SettingsSection
                id="settings-system-tray"
                title={isDarwin ? 'Menu bar' : 'System tray'}
                hint={`Keep a Gezel icon in the ${isDarwin ? 'menu bar' : 'system tray'} for at-a-glance status, notifications, and a quick engagement-mode toggle.`}
              >
                <SettingCheck
                  label="Show the tray icon"
                  hint={
                    isDarwin
                      ? undefined
                      : 'While it shows, closing the window keeps Gezel running in the tray; quit from the tray menu.'
                  }
                  checked={config?.showSystemTray !== false}
                  onChange={(checked) => void saveShowSystemTray(checked)}
                />
                {/* Close-to-tray opt-out. Only relevant when the tray is on, and
                  only on Windows/Linux — macOS keeps the app alive on close
                  regardless, so the toggle would be a no-op there. */}
                {config?.showSystemTray !== false && !isDarwin && (
                  <SettingCheck
                    label="Remove the tray icon on close"
                    checked={config?.quitOnClose === true}
                    onChange={(checked) => void saveQuitOnClose(checked)}
                  />
                )}
              </SettingsSection>
              {/* Mac-only: by convention macOS keeps the app running after the
                window closes. This opt-in makes the red X quit Gezel entirely,
                matching Windows. Off by default; independent of the tray. */}
              {isDarwin && (
                <SettingsSection id="settings-close-button" title="Close button">
                  <SettingCheck
                    label="Quit Gezel when the window is closed"
                    hint="By default macOS keeps Gezel running when you close the window. Turn this on to quit Gezel entirely when you click the red close button."
                    checked={config?.quitOnClose === true}
                    onChange={(checked) => void saveQuitOnClose(checked)}
                  />
                </SettingsSection>
              )}
              <MicrophoneSettings />
              <AmbientDashboardCard />
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

              <SettingsSection
                id="settings-crew-roles"
                title="Crew roles"
                hint="Who holds each standing job. Changing who holds one leaves their own instructions as they are."
              >
                <RoleAssignmentField
                  controlId="settings-role-meester"
                  label="Meester"
                  hint="Your concierge: they help you start new projects, answer questions, and check in on projects to keep them moving."
                  value={config?.meesterGezelId}
                  gezels={gezels}
                  roleBasedNameOnly={boringMode}
                  placeholder="Select meester…"
                  newItemLabel="New Meester…"
                  createLabel="Create Meester"
                  createHint="A new crew member is created with the curated Meester prompt and set as your active guide. You can rename or tune them later in the Crew tab."
                  onAssign={setMeester}
                  onCreate={createNewMeester}
                />
                <RoleAssignmentField
                  controlId="settings-role-scribe"
                  label="Scribe"
                  hint="Handles Gezel's small writing jobs (about.md drafts, rewrites, end-of-thread summaries, memory consolidation), so you can route grunt tasks to a different model than the one your conversations use."
                  value={config?.klerkGezelId}
                  gezels={gezels}
                  roleBasedNameOnly={boringMode}
                  placeholder="Select Scribe…"
                  newItemLabel="New Scribe…"
                  createLabel="Create Scribe"
                  createHint="A new crew member is created with the curated Scribe prompt and set as your active Scribe. Tune their model in the Crew tab to point utility work at Sonnet, a local model, or whatever fits."
                  onAssign={setKlerk}
                  onCreate={createNewKlerk}
                />
                <div data-testid="boekwachter-settings">
                  <RoleAssignmentField
                    controlId="settings-role-librarian"
                    label="Librarian"
                    hint="Keeps the index of your files. A project with a Librarian on its assigned crew gets background AI summaries, file reviews, folder rollups, and weekly digests. Remove the role from a project to keep fast structural search without those AI passes. Indexing stays local by default; a local provider and model selected for the Librarian can tune the work."
                    value={config?.boekwachterGezelId}
                    gezels={gezels}
                    roleBasedNameOnly={boringMode}
                    placeholder="Select Librarian…"
                    newItemLabel="New Librarian…"
                    createLabel="Create Librarian"
                    createHint="The new Librarian uses the canonical gilde Librarian personality. Projects assigned to the current Librarian transfer to the new one."
                    onAssign={setBoekwachter}
                    onCreate={createNewBoekwachter}
                  />
                </div>
              </SettingsSection>

              {config?.showAdvancedFeatures && (
                <SettingsSection
                  id="settings-inspector"
                  title="Inspector"
                  hint="The Inspector checks the guild's work. When a small on-device model gets stuck — spinning on the same step, going silent, failing the same check over and over — a frontier model is consulted to diagnose the problem and step in: a well-aimed nudge, a rewritten task step, or (at most twice per task) doing the failing step itself and handing the work back."
                >
                  <div className="gz-setting-stack" data-testid="keurmeester-settings">
                    {config?.keurmeester?.enabled !== true && !keurmeesterConsentOpen && (
                      <button type="button" onClick={() => setKeurmeesterConsentOpen(true)}>
                        Turn on supervision…
                      </button>
                    )}
                    {config?.keurmeester?.enabled !== true && keurmeesterConsentOpen && (
                      <div className="gz-setting-panel" data-testid="keurmeester-consent">
                        <p>
                          When a local model gets stuck, excerpts of the conversation and task will
                          be sent to{' '}
                          <strong>
                            {config?.keurmeester?.providerName ?? 'the cloud provider you pick'}
                          </strong>{' '}
                          for diagnosis. If you chose a local model for privacy, that trade-off is
                          yours to make — nothing is sent until you turn this on.
                        </p>
                        <div className="gz-setting-panel-actions">
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setKeurmeesterConsentOpen(false)}
                          >
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
                        <SettingCheck
                          label="Supervise local models"
                          hint="Conversation and task excerpts go to the provider below when a local model gets stuck."
                          checked
                          onChange={() => void saveKeurmeesterConfig({ enabled: false })}
                        />
                        <SettingField
                          label="Consult provider"
                          controlId="settings-inspector-provider"
                        >
                          <Select.Root
                            value={config?.keurmeester?.providerName ?? ''}
                            onValueChange={(v) =>
                              void saveKeurmeesterConfig({ providerName: v, model: undefined })
                            }
                          >
                            <Select.Trigger id="settings-inspector-provider">
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
                              <Select.Item value="anthropic">
                                Anthropic{hasAnthropicKey ? ' ✓' : ''}
                              </Select.Item>
                              <Select.Item value="openai">
                                OpenAI{hasOpenaiKey ? ' ✓' : ''}
                              </Select.Item>
                              <Select.Item value="anthropic-cli">Anthropic CLI</Select.Item>
                              <Select.Item value="codex-cli">Codex CLI</Select.Item>
                            </Select.Content>
                          </Select.Root>
                        </SettingField>
                        {config?.keurmeester?.providerName && (
                          <SettingField label="Consult model">
                            <ModelPicker
                              provider={config.keurmeester.providerName as ProviderName}
                              value={config?.keurmeester?.model}
                              onChange={(m) => void saveKeurmeesterConfig({ model: m })}
                              placeholder="Provider default"
                            />
                          </SettingField>
                        )}
                        <SettingCheck
                          label="Allow bounded takeover"
                          hint="The Inspector may perform a repeatedly failing step itself — at most once per step and twice per task — then hand the work back."
                          checked={config?.keurmeester?.allowTakeover !== false}
                          onChange={(checked) =>
                            void saveKeurmeesterConfig({ allowTakeover: checked })
                          }
                        />
                        <RoleAssignmentField
                          controlId="settings-role-inspector"
                          label="Inspector"
                          hint={
                            config?.keurmeesterGezelId
                              ? 'Their interventions appear in chat and in the History tab.'
                              : 'No Inspector yet. One is created automatically on the first intervention, or choose or create one now.'
                          }
                          value={config?.keurmeesterGezelId}
                          gezels={gezels}
                          roleBasedNameOnly={boringMode}
                          placeholder="Select Inspector…"
                          newItemLabel="New Inspector…"
                          createLabel="Create Inspector"
                          createHint="A new crew member is created with the curated Inspector prompt and set as your active Inspector. Their interventions appear in chat and in the History tab."
                          onAssign={setKeurmeester}
                          onCreate={createNewKeurmeester}
                        />
                      </>
                    )}
                  </div>
                </SettingsSection>
              )}
            </>
          )}

          {section === 'aboutYou' && <UserMemoriesEditor />}
          {section === 'folders' && <FoldersSettings />}

          {section === 'defaults' && (
            <>
              <SettingsSection
                id="settings-default-provider"
                title="Default provider"
                hint="Which AI chat provider handles chat and one-shot generations. Individual crew members can override this in their detail pane."
              >
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
                      title="DwarfStar (ds4) — antirez's specialized engine for very large mixture-of-experts models (DeepSeek V4, GLM 5.2/5.3). Streams the experts from disk so a frontier-class model runs on this device."
                    >
                      {ds4TabLabel}
                    </button>
                  )}
                  {showAppleProvider && (
                    <button
                      type="button"
                      className={`provider-pill${provider === 'apple-foundation-models' ? ' provider-pill-active' : ''}`}
                      onClick={() => void setProvider('apple-foundation-models')}
                      title="Apple Intelligence on this Mac, managed by macOS. Works offline for chat, notes and short tasks."
                    >
                      {providerLabel('apple-foundation-models', uiPlatform)}
                    </button>
                  )}
                  {showRemoteProvider && (
                    <button
                      type="button"
                      className={`provider-pill${provider === 'remote' ? ' provider-pill-active' : ''}`}
                      onClick={selectRemoteProvider}
                      title={remoteProviderTitle}
                    >
                      {remoteProviderLabel}
                    </button>
                  )}
                  {showCopilotProvider && (
                    <button
                      type="button"
                      className={`provider-pill${provider === 'copilot' ? ' provider-pill-active' : ''}`}
                      onClick={() => void setProvider('copilot')}
                      disabled={providerBlocked('copilot')}
                      title={
                        providerBlocked('copilot') ? blockedProviderTitle('copilot') : undefined
                      }
                    >
                      GitHub Copilot
                    </button>
                  )}
                  <button
                    type="button"
                    className={`provider-pill${provider === 'openai' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('openai')}
                    disabled={providerBlocked('openai')}
                    title={providerBlocked('openai') ? blockedProviderTitle('openai') : undefined}
                  >
                    OpenAI
                  </button>
                  <button
                    type="button"
                    className={`provider-pill${provider === 'codex-cli' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('codex-cli')}
                    disabled={providerBlocked('codex-cli')}
                    title={
                      providerBlocked('codex-cli')
                        ? blockedProviderTitle('codex-cli')
                        : 'Drive a locally-installed `codex` CLI per turn. Auth is whatever the CLI is logged in with on this host — no API key needed here.'
                    }
                  >
                    OpenAI Codex CLI
                  </button>
                  <button
                    type="button"
                    className={`provider-pill${provider === 'anthropic' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('anthropic')}
                    disabled={providerBlocked('anthropic')}
                    title={
                      providerBlocked('anthropic') ? blockedProviderTitle('anthropic') : undefined
                    }
                  >
                    Anthropic Claude
                  </button>
                  <button
                    type="button"
                    className={`provider-pill${provider === 'anthropic-cli' ? ' provider-pill-active' : ''}`}
                    onClick={() => void setProvider('anthropic-cli')}
                    disabled={providerBlocked('anthropic-cli')}
                    title={
                      providerBlocked('anthropic-cli')
                        ? blockedProviderTitle('anthropic-cli')
                        : 'Drive a locally-installed `claude` CLI per turn. Auth is whatever the CLI is logged in with on this host — no API key needed here.'
                    }
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

                {externalChatBlocked && (
                  <p className="gz-setting-hint">
                    {providerBlocked(provider) ? (
                      <>
                        <strong>{providerLabel(provider, uiPlatform)}</strong> is your default
                        provider, but {securityLevelLabel} keeps every chat on this device — no one
                        can use it until you pick an on-device engine above.{' '}
                      </>
                    ) : (
                      <>
                        Cloud and CLI providers are grayed out because {securityLevelLabel} keeps
                        every chat on this device.{' '}
                      </>
                    )}
                    Change the level in{' '}
                    <button
                      type="button"
                      className="gz-link-button"
                      onClick={() => setSection('securityCompliance')}
                    >
                      Security &amp; compliance
                    </button>{' '}
                    to use them.
                  </p>
                )}

                {provider === 'copilot' && !externalChatBlocked && (
                  <SettingField label="Default model">
                    <div className="gz-setting-row">
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
                  </SettingField>
                )}

                {provider === 'codex-cli' && !externalChatBlocked && (
                  <>
                    {codexCliProbe.kind === 'ok' && (
                      <SettingField label="Default model">
                        <ModelPicker
                          provider="codex-cli"
                          value={config?.defaultModel?.['codex-cli']}
                          onChange={(v) => void saveDefaultModel('codex-cli', v)}
                        />
                      </SettingField>
                    )}
                    {codexCliProbe.kind === 'ok' && codexCliReasoningSupported !== false && (
                      <SettingField label="Reasoning effort">
                        <EffortTray
                          provider="codex-cli"
                          model={config?.defaultModel?.['codex-cli']}
                          defaultModel="gpt-6.1-sol"
                          value={config?.codexCli?.defaultReasoningEffort ?? ''}
                          onChange={(value) =>
                            void saveCodexCli({
                              defaultReasoningEffort: value as CodexCliReasoningEffort | undefined,
                            })
                          }
                        />
                      </SettingField>
                    )}
                    <p className="gz-setting-hint">
                      {codexCliProbe.kind === 'fail'
                        ? 'The Codex CLI is not connected yet. Set it up in the '
                        : codexCliProbe.kind === 'ok'
                          ? 'Permissions and advanced settings live in the '
                          : 'Checking the Codex CLI connection… Settings live in the '}
                      <button
                        type="button"
                        className="gz-link-button"
                        onClick={() => setSection('codexCli')}
                      >
                        OpenAI Codex CLI
                      </button>{' '}
                      tab.
                    </p>
                  </>
                )}

                {provider === 'anthropic-cli' && !externalChatBlocked && (
                  <>
                    {anthropicCliProbe.kind === 'ok' && (
                      <SettingField label="Default model">
                        <ModelPicker
                          provider="anthropic-cli"
                          value={config?.defaultModel?.['anthropic-cli']}
                          onChange={(v) => void saveDefaultModel('anthropic-cli', v)}
                          placeholder="Gezel default (Claude Sonnet)"
                        />
                      </SettingField>
                    )}
                    {anthropicCliProbe.kind === 'ok' && anthropicCliReasoningSupported === true && (
                      <SettingField label="Reasoning effort">
                        <EffortPicker
                          provider="anthropic-cli"
                          model={config?.defaultModel?.['anthropic-cli']}
                          value={config?.defaultReasoningEffort?.['anthropic-cli']}
                          onChange={(value) => void saveDefaultEffort('anthropic-cli', value)}
                        />
                      </SettingField>
                    )}
                    <p className="gz-setting-hint">
                      {anthropicCliProbe.kind === 'fail'
                        ? 'The Claude CLI is not connected yet. Set it up in the '
                        : anthropicCliProbe.kind === 'ok'
                          ? 'Permissions and advanced settings live in the '
                          : 'Checking the Claude CLI connection… Settings live in the '}
                      <button
                        type="button"
                        className="gz-link-button"
                        onClick={() => setSection('anthropicCli')}
                      >
                        Anthropic Claude CLI
                      </button>{' '}
                      tab.
                    </p>
                  </>
                )}

                {provider === 'ollama' && (
                  <>
                    <SettingField label="Default model">
                      <ModelPicker
                        provider="ollama"
                        value={config?.defaultModel?.ollama}
                        onChange={(v) => void saveDefaultModel('ollama', v)}
                        placeholder="First local model"
                      />
                    </SettingField>
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

                {provider === 'apple-foundation-models' && <AppleFoundationModelsStatus />}

                {provider === 'remote' && (
                  <SettingField
                    label="Default model"
                    hint={
                      <>
                        Only the model runs on the other device; your files and chats stay here.
                        While it can't be reached, a model installed on this computer answers
                        instead. Connect or forget devices in the{' '}
                        <button
                          type="button"
                          className="gz-link-button"
                          onClick={() => setSection('remoteServers')}
                        >
                          Remote servers
                        </button>{' '}
                        tab.
                      </>
                    }
                  >
                    <ModelPicker
                      provider="remote"
                      value={config?.defaultModel?.remote}
                      // Clearing it would leave nothing that names a server.
                      onChange={(v) => {
                        if (v) void saveDefaultModel('remote', v);
                      }}
                      placeholder="Choose a model"
                    />
                  </SettingField>
                )}

                {(provider === 'llama-cpp' || provider === 'mlx') && (
                  <SettingField
                    label="Default model"
                    hint={
                      <>
                        Download models and tune advanced settings in the{' '}
                        <button
                          type="button"
                          className="gz-link-button"
                          onClick={() => setSection(provider === 'mlx' ? 'mlx' : 'llamaCpp')}
                        >
                          {provider === 'mlx' ? mlxTabLabel : llamaCppTabLabel}
                        </button>{' '}
                        tab.
                      </>
                    }
                  >
                    <ModelPicker
                      provider={provider}
                      value={config?.defaultModel?.[provider]}
                      onChange={(v) => void saveDefaultModel(provider, v)}
                      placeholder="First local model"
                    />
                  </SettingField>
                )}

                {provider === 'ds4' && (
                  <SettingField
                    label="Default model"
                    hint={
                      <>
                        Download DwarfStar models and tune SSD streaming in the{' '}
                        <button
                          type="button"
                          className="gz-link-button"
                          onClick={() => setSection('ds4')}
                        >
                          {ds4TabLabel}
                        </button>{' '}
                        tab.
                      </>
                    }
                  >
                    <ModelPicker
                      provider="ds4"
                      value={config?.defaultModel?.ds4}
                      onChange={(v) => void saveDefaultModel('ds4', v)}
                      placeholder="First local model"
                    />
                  </SettingField>
                )}
                <DefaultModelAdvancedTuning
                  config={config}
                  provider={provider}
                  onConfigUpdated={setConfig}
                />
              </SettingsSection>

              <SettingsSection
                id="settings-night-shift-model"
                title="Night Shift model"
                hint="Night Shift uses the default provider and model unless you choose a separate, hands-off model here — a larger but slower model can think more carefully overnight. A crew member's own model choice still takes priority."
              >
                <SettingCheck
                  label="Use a specific model by default during Night Shift"
                  checked={nightShiftModelOverride?.enabled === true}
                  onChange={(enabled) => {
                    const inheritedModel =
                      nightShiftModelOverride?.model ?? config?.defaultModel?.[nightShiftProvider];
                    void saveNightShiftModelOverride({
                      enabled,
                      ...(enabled && inheritedModel ? { model: inheritedModel } : {}),
                    });
                  }}
                />
                {nightShiftModelOverride?.enabled === true && (
                  <>
                    <SettingField label="Provider">
                      <div
                        className="gz-tray"
                        role="radiogroup"
                        onKeyDown={onRadioKeyDown}
                        aria-label="Night Shift provider"
                      >
                        {nightShiftProviderChoices.map((choice) => (
                          <button
                            key={choice.id}
                            type="button"
                            // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                            role="radio"
                            aria-checked={nightShiftProvider === choice.id}
                            tabIndex={
                              nightShiftProvider === choice.id ||
                              (providerBlocked(nightShiftProvider) &&
                                choice ===
                                  nightShiftProviderChoices.find(
                                    (candidate) => !providerBlocked(candidate.id),
                                  ))
                                ? 0
                                : -1
                            }
                            className={`gz-key${
                              nightShiftProvider === choice.id ? ' gz-key-active' : ''
                            }`}
                            disabled={providerBlocked(choice.id)}
                            onClick={() =>
                              void saveNightShiftModelOverride({
                                enabled: true,
                                provider: choice.id,
                                model:
                                  choice.id === 'remote'
                                    ? startingRemoteModel(config?.defaultModel?.remote)
                                    : config?.defaultModel?.[choice.id],
                              })
                            }
                            title={
                              providerBlocked(choice.id)
                                ? blockedProviderTitle(choice.id)
                                : choice.title
                            }
                          >
                            {choice.label}
                          </button>
                        ))}
                      </div>
                    </SettingField>
                    <SettingField label="Model">
                      <ModelPicker
                        provider={nightShiftProvider}
                        value={nightShiftModelOverride.model}
                        onChange={(model) => void saveNightShiftModelOverride({ model })}
                      />
                    </SettingField>
                  </>
                )}
              </SettingsSection>

              {/* The optional media models (images, image reading, speech) used to
                  sit on first-run setup. First run now asks only for the chat
                  model, so the recommended set that fits this device lives here. */}
              <SettingsSection
                id="settings-media-models"
                title="Media models"
                hint="Optional models that let Gezel make images, read them, and speak and listen — the ones that fit this device."
              >
                <RecommendedMediaDownloads />
              </SettingsSection>

              <GeneralistModeSection
                value={config?.generalistMode}
                setStatus={setStatus}
                onSaved={(res) => {
                  setConfig(res);

                  window.dispatchEvent(new CustomEvent('gezel:config-updated', { detail: res }));
                }}
              />

              <SettingsSection
                id="settings-tool-filtering"
                title="Tool filtering"
                hint="Give each crew member only the tools their role actually needs. A smaller toolbox keeps them focused and makes every reply faster and cheaper — it matters most with small on-device models. Known roles (Meester, Crew Lead, Reviewer, Copywriter, Designer, Planner) start with a sensible set; each crew member's own Toolsets tab can override it."
              >
                <div className="provider-switch">
                  <button
                    type="button"
                    className={`provider-pill${
                      (config?.toolFilterMode ?? 'always') === 'always'
                        ? ' provider-pill-active'
                        : ''
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
                      (config?.toolFilterMode ?? 'always') === 'never'
                        ? ' provider-pill-active'
                        : ''
                    }`}
                    onClick={() => void saveToolFilterMode('never')}
                  >
                    Never
                  </button>
                </div>
              </SettingsSection>

              <MemorySection
                config={config}
                onRetrievalChange={setRetrieval}
                onTaskReferencesChange={setTaskReferences}
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

              <SettingsSection
                id="settings-copilot"
                title="GitHub Copilot"
                hint="A Copilot-enabled GitHub account is required. Gezel supports two sign-in modes — the Copilot CLI is the simpler default."
              >
                {/* Connection status ─ reflects the most recent probe. */}
                <CopilotConnectionStatus
                  probe={copilotProbe}
                  mode={hasGithubToken ? 'pat' : 'cli'}
                  inUse={copilotInUse}
                  onRetest={() => void runCopilotProbe()}
                />

                {/* Option 1 — CLI. Collapses to a single "Signed in as …" line
                  when we know the account; expands to full install/login
                  instructions when not signed in or when the user asks. */}
                <div className="gz-setting">
                  <div className="gz-setting-row">
                    <span className="gz-setting-label">
                      {copilotSignedInViaCli ? (
                        <>
                          Signed in as <code>{copilotLogin}</code>
                        </>
                      ) : (
                        'Sign in with the Copilot CLI'
                      )}
                    </span>
                    {!hasGithubToken && copilotProbe.kind === 'ok' && (
                      <span className="home-copilot-recommended">Active</span>
                    )}
                    {copilotSignedInViaCli && (
                      <button
                        type="button"
                        className="gz-link-button"
                        onClick={() => setShowCliHelp((s) => !s)}
                      >
                        {showCliHelp ? 'Hide' : 'Login instructions'}
                      </button>
                    )}
                  </div>
                  {(showCliHelp || !copilotSignedInViaCli) && (
                    <>
                      <p className="gz-setting-hint">
                        Gezel bundles the Node runtime. The Copilot CLI can be installed into your
                        Gezel home, or Gezel can use a compatible CLI you already have. Click below
                        to sign in through GitHub; the credential lands in <code>~/.copilot</code>{' '}
                        and the status above refreshes automatically.
                      </p>
                      <CopilotLoginCommand
                        installDir={config?.copilotCliInstallDir}
                        onComplete={() => void runCopilotProbe()}
                      />
                    </>
                  )}
                </div>
              </SettingsSection>

              <SettingsSection
                id="settings-copilot-token"
                title="Alternative sign-in: GitHub token"
                hint={
                  <>
                    Use a classic{' '}
                    <a href="https://github.com/settings/tokens" target="_blank" rel="noreferrer">
                      GitHub personal access token
                    </a>{' '}
                    with the <code>copilot</code> scope.
                    {hasGithubToken && copilotProbe.kind === 'ok' && copilotLogin && (
                      <>
                        {' '}
                        Signed in as <code>{copilotLogin}</code>.
                      </>
                    )}
                  </>
                }
                actions={
                  hasGithubToken && copilotProbe.kind === 'ok' ? (
                    <span className="home-copilot-recommended">Active</span>
                  ) : undefined
                }
              >
                {hasGithubToken || showPatForm ? (
                  <SettingField
                    label="GitHub token"
                    controlId="settings-github-token"
                    hint={
                      hasGithubToken ? (
                        <>
                          <code>&lt;Stored GitHub token&gt;</code>{' '}
                          <button
                            type="button"
                            className="gz-link-button"
                            onClick={clearGitHubToken}
                          >
                            Clear
                          </button>
                        </>
                      ) : undefined
                    }
                  >
                    <div className="gz-setting-row">
                      <input
                        id="settings-github-token"
                        type="password"
                        placeholder={
                          hasGithubToken ? 'Replace GitHub token…' : 'Paste GitHub token…'
                        }
                        value={tokenDraft}
                        onChange={(e) => setTokenDraft(e.target.value)}
                      />
                      <button type="button" onClick={saveGitHubToken} disabled={!tokenDraft.trim()}>
                        Save
                      </button>
                    </div>
                  </SettingField>
                ) : (
                  <button type="button" className="secondary" onClick={() => setShowPatForm(true)}>
                    Use a GitHub token instead…
                  </button>
                )}
              </SettingsSection>

              <SettingsSection
                id="settings-copilot-turns"
                title="Copilot turns"
                hint="What Copilot may use during a turn, and how long a turn may run."
              >
                <SettingCheck
                  label="Sandbox Copilot to gezel tools only"
                  hint={
                    <>
                      New Copilot threads deny the CLI&rsquo;s built-in tools (<code>bash</code>,{' '}
                      <code>web_fetch</code>, <code>view</code>, file ops, <code>grep</code>) and
                      work through gezel&rsquo;s tools instead, which gives you an audit trail for
                      every action and the same behavior across providers. Each crew member&rsquo;s
                      Settings tab can override this.
                    </>
                  }
                  checked={config?.sandboxCopilot === true}
                  onChange={(checked) => {
                    void api.updateConfig({ sandboxCopilot: checked }).then(setConfig);
                  }}
                />
                <SettingField
                  label="Hard turn timeout"
                  controlId="settings-copilot-turn-timeout"
                  hint={
                    <>
                      The total wall-clock cap from when a turn gets its queue slot to when the
                      model finishes. If it fires before the model signals <code>session.idle</code>
                      , the turn ends with a &ldquo;Turn stopped before finishing&rdquo; banner.
                      Raise it for work that runs long shell or Playwright chains. Leave it empty
                      for the default, 10 minutes.
                    </>
                  }
                >
                  <div className="gz-setting-inline">
                    <input
                      id="settings-copilot-turn-timeout"
                      type="number"
                      min={1}
                      placeholder="default"
                      aria-label="Hard turn timeout (minutes)"
                      aria-describedby={settingHintId('settings-copilot-turn-timeout')}
                      value={copilotTurnTimeoutDraft}
                      onChange={(event) => setCopilotTurnTimeoutDraft(event.target.value)}
                    />
                    <span>minutes</span>
                    <button
                      type="button"
                      onClick={() => void saveCopilotTurnTimeout()}
                      disabled={
                        copilotTurnTimeoutDraft.trim() ===
                        (config?.copilotTurnTimeoutMin ? String(config.copilotTurnTimeoutMin) : '')
                      }
                    >
                      Save
                    </button>
                  </div>
                </SettingField>
              </SettingsSection>

              {copilotUsage && (
                <SettingsSection id="settings-copilot-usage" title="Usage">
                  <ProviderUsagePanel
                    label="GitHub Copilot"
                    data={copilotUsage}
                    showTitle={false}
                  />
                </SettingsSection>
              )}
            </>
          )}

          {section === 'openai' && (
            <>
              <SettingsSection
                id="settings-openai"
                title="OpenAI"
                hint="Uses an OpenAI API key. Billing and usage run through your OpenAI account, independent of GitHub Copilot."
              >
                <ol className="gz-setting-steps">
                  <li>
                    Go to{' '}
                    <a href="https://platform.openai.com/api-keys" target="_blank" rel="noreferrer">
                      platform.openai.com/api-keys
                    </a>{' '}
                    and create a secret key with access to the models you want to use.
                  </li>
                  <li>Paste it below. Organization ID is optional.</li>
                </ol>
                <SettingField
                  label="API key"
                  controlId="settings-openai-key"
                  hint={
                    hasOpenaiKey ? (
                      <>
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
                        <button type="button" className="gz-link-button" onClick={clearOpenaiKey}>
                          Clear
                        </button>
                      </>
                    ) : undefined
                  }
                >
                  <div className="gz-setting-row">
                    <input
                      id="settings-openai-key"
                      type="password"
                      placeholder={hasOpenaiKey ? 'Replace key…' : 'Paste OpenAI API key (sk-…)'}
                      aria-label="OpenAI API key"
                      value={openaiKeyDraft}
                      onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                    />
                    <input
                      type="text"
                      placeholder="Organization (optional)"
                      aria-label="Organization (optional)"
                      value={openaiOrgDraft}
                      onChange={(e) => setOpenaiOrgDraft(e.target.value)}
                    />
                    <button type="button" onClick={saveOpenaiKey} disabled={!openaiKeyDraft.trim()}>
                      Save
                    </button>
                  </div>
                </SettingField>
                {hasOpenaiKey && (
                  <SettingField label="Default model">
                    <div className="gz-setting-row">
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
                  </SettingField>
                )}
              </SettingsSection>
              {openaiUsage && (
                <SettingsSection id="settings-openai-usage" title="Usage">
                  <ProviderUsagePanel label="OpenAI" data={openaiUsage} showTitle={false} />
                </SettingsSection>
              )}
            </>
          )}

          {section === 'codexCli' && (
            <SettingsSection
              id="settings-codex-cli"
              title="OpenAI Codex CLI (command line interface)"
              hint={
                <>
                  Drives a locally-installed{' '}
                  <a href="https://github.com/openai/codex" target="_blank" rel="noreferrer">
                    Codex CLI
                  </a>{' '}
                  once per chat turn.
                </>
              }
            >
              <SettingField label="Connection">
                <div className="gz-setting-row">
                  {codexCliProbe.kind === 'ok' && (
                    <span className="provider-connection-state" data-tone="success">
                      ✓ Codex CLI ready ({codexCliProbe.modelCount} models)
                    </span>
                  )}
                  {codexCliProbe.kind === 'fail' && (
                    <span className="provider-connection-state" data-tone="danger">
                      Not connected
                    </span>
                  )}
                  {(codexCliProbe.kind === 'idle' || codexCliProbe.kind === 'probing') && (
                    <span className="gz-setting-hint">Testing…</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void runCodexCliProbe()}
                    disabled={codexCliProbe.kind === 'probing'}
                  >
                    {codexCliProbe.kind === 'probing' ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                {codexCliProbe.kind === 'fail' && (
                  <div className="provider-connection-callout">
                    <p>{codexCliProbe.error}</p>
                    <ol>
                      <li>
                        Install the Codex CLI globally and run <code>codex login</code> (or export
                        an <code>OPENAI_API_KEY</code>) so the CLI app is ready to use.
                      </li>
                      <li>
                        or, optionally pin an explicit binary path under Advanced — gezel uses{' '}
                        <code>$PATH</code> by default.
                      </li>
                      <li>
                        Click Test connection. Once Codex is connected, you can pick a default model
                        and reasoning effort here.
                      </li>
                    </ol>
                  </div>
                )}
              </SettingField>

              <SettingField
                label="Default permission"
                hint="Gezel’s narrow destructive-command guard stays on in every mode. Projects and individual crew members can override this default."
              >
                <div>
                  <div
                    className="gz-tray gz-tray--described"
                    role="radiogroup"
                    onKeyDown={onRadioKeyDown}
                    aria-label="Default Codex access"
                  >
                    {CODEX_PERMISSION_CHOICES.map((choice) => {
                      const selected = codexPermissionCurrent === choice.id;
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons; a native radio cannot carry the keys-in-trays treatment.
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          className={`gz-key${selected ? ' gz-key-active' : ''}`}
                          onClick={() => void saveCodexCli({ defaultPermissionMode: choice.id })}
                        >
                          {choice.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="gz-tray-description">
                    <strong>{codexPermissionChoice.label}</strong> —{' '}
                    {codexPermissionChoice.description}
                  </p>
                </div>
              </SettingField>

              {codexCliProbe.kind === 'ok' && (
                <SettingField label="Default model">
                  <ModelPicker
                    provider="codex-cli"
                    value={config?.defaultModel?.['codex-cli']}
                    onChange={(v) => void saveDefaultModel('codex-cli', v)}
                  />
                </SettingField>
              )}

              {codexCliProbe.kind === 'ok' && codexCliReasoningSupported !== false && (
                <SettingField label="Reasoning effort">
                  <EffortTray
                    provider="codex-cli"
                    model={config?.defaultModel?.['codex-cli']}
                    defaultModel="gpt-6.1-sol"
                    value={config?.codexCli?.defaultReasoningEffort ?? ''}
                    onChange={(value) =>
                      void saveCodexCli({
                        defaultReasoningEffort: value as CodexCliReasoningEffort | undefined,
                      })
                    }
                  />
                </SettingField>
              )}

              <details className="gz-setting-more">
                <summary>Advanced</summary>
                <div className="gz-setting-stack">
                  <SettingField label="Binary path" controlId="settings-codex-binary">
                    <div className="gz-setting-row">
                      <input
                        id="settings-codex-binary"
                        type="text"
                        placeholder="(auto — found on PATH)"
                        aria-label="Codex CLI binary path"
                        value={codexCliBinaryDraft}
                        onChange={(e) => setCodexCliBinaryDraft(e.target.value)}
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
                  </SettingField>
                  <SettingField label="Gezel tools">
                    <SettingCheck
                      label="Give Codex Gezel's tools, such as search, memories, and tasks"
                      hint="Disable to run Codex with only its built-in tools."
                      checked={config?.codexCli?.manageRuntimeFiles !== false}
                      onChange={(checked) => void saveCodexCli({ manageRuntimeFiles: checked })}
                    />
                  </SettingField>
                </div>
              </details>
            </SettingsSection>
          )}

          {section === 'anthropic' && (
            <SettingsSection
              id="settings-anthropic"
              title="Anthropic Claude"
              hint="Uses an Anthropic API key. Billing and usage run through your Anthropic console, independent of GitHub Copilot or OpenAI."
            >
              <ol className="gz-setting-steps">
                <li>
                  Go to{' '}
                  <a
                    href="https://platform.claude.com/settings/keys"
                    target="_blank"
                    rel="noreferrer"
                  >
                    platform.claude.com/settings/keys
                  </a>{' '}
                  and create an API key.
                </li>
                <li>Paste it below.</li>
              </ol>
              <SettingField
                label="API key"
                controlId="settings-anthropic-key"
                hint={
                  hasAnthropicKey ? (
                    <>
                      Current key:{' '}
                      <code>
                        {'•'.repeat(8)}…{(config?.anthropicApiKey ?? '').slice(-4)}
                      </code>{' '}
                      <button type="button" className="gz-link-button" onClick={clearAnthropicKey}>
                        Clear
                      </button>
                    </>
                  ) : undefined
                }
              >
                <div className="gz-setting-row">
                  <input
                    id="settings-anthropic-key"
                    type="password"
                    placeholder={
                      hasAnthropicKey ? 'Replace key…' : 'Paste Anthropic API key (sk-ant-…)'
                    }
                    aria-label="Anthropic API key"
                    value={anthropicKeyDraft}
                    onChange={(e) => setAnthropicKeyDraft(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={saveAnthropicKey}
                    disabled={!anthropicKeyDraft.trim()}
                  >
                    Save
                  </button>
                </div>
              </SettingField>
              {hasAnthropicKey && (
                <SettingField
                  label="Default model"
                  hint="Each reply re-sends the conversation so far; Gezel marks it for Anthropic's caching, so follow-up turns cost a fraction of the first."
                >
                  <div className="gz-setting-row">
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
                </SettingField>
              )}
            </SettingsSection>
          )}

          {section === 'anthropicCli' && (
            <SettingsSection
              id="settings-anthropic-cli"
              title="Anthropic Claude CLI (command line interface)"
              hint={
                <>
                  Drives a locally-installed{' '}
                  <a
                    href="https://docs.claude.com/en/docs/claude-code/overview"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Claude Code CLI
                  </a>{' '}
                  once per chat turn.
                </>
              }
            >
              <SettingField label="Connection">
                <div className="gz-setting-row">
                  {anthropicCliProbe.kind === 'ok' && (
                    <span className="provider-connection-state" data-tone="success">
                      ✓ Claude CLI ready ({anthropicCliProbe.modelCount} models)
                    </span>
                  )}
                  {anthropicCliProbe.kind === 'fail' && (
                    <span className="provider-connection-state" data-tone="danger">
                      Not connected
                    </span>
                  )}
                  {(anthropicCliProbe.kind === 'idle' || anthropicCliProbe.kind === 'probing') && (
                    <span className="gz-setting-hint">Testing…</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void runAnthropicCliProbe()}
                    disabled={anthropicCliProbe.kind === 'probing'}
                  >
                    {anthropicCliProbe.kind === 'probing' ? 'Testing…' : 'Test connection'}
                  </button>
                </div>
                {anthropicCliProbe.kind === 'fail' && (
                  <div className="provider-connection-callout">
                    <p>{anthropicCliProbe.error}</p>
                    <ol>
                      <li>
                        Install Claude Code and run <code>claude /status</code> in a terminal to
                        confirm it is signed in, so the CLI app is ready to use.
                      </li>
                      <li>
                        or, optionally pin an explicit binary path under Advanced — gezel uses{' '}
                        <code>$PATH</code> by default.
                      </li>
                      <li>
                        Click Test connection. Once Claude is connected, you can pick a default
                        model here.
                      </li>
                    </ol>
                  </div>
                )}
              </SettingField>

              <SettingField
                label="Default permission"
                hint="Projects and individual crew members can override this default."
              >
                <div>
                  <div
                    className="gz-tray gz-tray--described"
                    role="radiogroup"
                    onKeyDown={onRadioKeyDown}
                    aria-label="Default permission"
                  >
                    {CLAUDE_PERMISSION_CHOICES.map((choice) => {
                      const selected = claudePermissionCurrent === choice.id;
                      return (
                        <button
                          key={choice.id}
                          type="button"
                          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of key buttons is the shared keys-in-trays pattern.
                          role="radio"
                          aria-checked={selected}
                          tabIndex={selected ? 0 : -1}
                          className={`gz-key${selected ? ' gz-key-active' : ''}`}
                          onClick={() =>
                            void saveAnthropicCli({ defaultPermissionMode: choice.id })
                          }
                        >
                          {choice.label}
                        </button>
                      );
                    })}
                  </div>
                  <p className="gz-tray-description">
                    <strong>{claudePermissionChoice.label}</strong> —{' '}
                    {claudePermissionChoice.description}
                  </p>
                </div>
              </SettingField>

              {anthropicCliProbe.kind === 'ok' && (
                <SettingField label="Default model">
                  <ModelPicker
                    provider="anthropic-cli"
                    value={config?.defaultModel?.['anthropic-cli']}
                    onChange={(v) => void saveDefaultModel('anthropic-cli', v)}
                    placeholder="Gezel default (Claude Sonnet)"
                  />
                </SettingField>
              )}

              {anthropicCliProbe.kind === 'ok' && anthropicCliReasoningSupported === true && (
                <SettingField label="Reasoning effort">
                  <EffortPicker
                    provider="anthropic-cli"
                    model={config?.defaultModel?.['anthropic-cli']}
                    value={config?.defaultReasoningEffort?.['anthropic-cli']}
                    onChange={(value) => void saveDefaultEffort('anthropic-cli', value)}
                  />
                </SettingField>
              )}

              <details className="gz-setting-more">
                <summary>Advanced</summary>
                <div className="gz-setting-stack">
                  <SettingField label="Binary path" controlId="settings-claude-binary">
                    <div className="gz-setting-row">
                      <input
                        id="settings-claude-binary"
                        type="text"
                        placeholder="(auto — found on PATH)"
                        aria-label="Claude CLI binary path"
                        value={anthropicCliBinaryDraft}
                        onChange={(e) => setAnthropicCliBinaryDraft(e.target.value)}
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
                  </SettingField>
                  <SettingField label="Gezel tools">
                    <SettingCheck
                      label="Give Claude Gezel's tools, such as search, memories, and tasks"
                      hint="Disable to run Claude with only its built-in tools."
                      checked={config?.anthropicCli?.manageRuntimeFiles !== false}
                      onChange={(checked) => void saveAnthropicCli({ manageRuntimeFiles: checked })}
                    />
                  </SettingField>
                  <SettingField
                    label="Pool size"
                    controlId="settings-claude-pool-size"
                    hint="Each ready process stays with one chat thread, so later turns skip the start-up wait. More processes mean faster replies when several chats run at once, and more memory (about 100–200 MB each). When the pool is full, the idle process that was used longest ago is closed."
                  >
                    <div className="gz-setting-inline">
                      <input
                        id="settings-claude-pool-size"
                        type="number"
                        min={1}
                        max={32}
                        aria-describedby={settingHintId('settings-claude-pool-size')}
                        value={config?.anthropicCli?.poolSize ?? 4}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          if (Number.isFinite(n) && n >= 1 && n <= 32) {
                            void saveAnthropicCli({ poolSize: n });
                          }
                        }}
                      />
                      <span>Claude processes kept ready</span>
                    </div>
                  </SettingField>
                  <SettingField
                    label="Concurrency"
                    controlId="settings-claude-concurrency"
                    hint="How many turns can run through Claude at once. Defaults to the pool size. Lower it to keep some ready processes in reserve. Setting it higher still works, but extra processes are started temporarily."
                  >
                    <div className="gz-setting-inline">
                      <input
                        id="settings-claude-concurrency"
                        type="number"
                        min={1}
                        max={32}
                        aria-describedby={settingHintId('settings-claude-concurrency')}
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
                      />
                      <span>turns running at the same time</span>
                    </div>
                  </SettingField>
                  <SettingField
                    label="Idle timeout"
                    controlId="settings-claude-idle-timeout"
                    hint="Close a ready process after this long without a turn. The timer restarts on every turn."
                  >
                    <div className="gz-setting-inline">
                      <input
                        id="settings-claude-idle-timeout"
                        type="number"
                        min={60}
                        max={3600}
                        step={60}
                        aria-label="Idle timeout (seconds)"
                        aria-describedby={settingHintId('settings-claude-idle-timeout')}
                        value={config?.anthropicCli?.workerIdleSec ?? 600}
                        onChange={(e) => {
                          const n = Number.parseInt(e.target.value, 10);
                          if (Number.isFinite(n) && n >= 60 && n <= 3600) {
                            void saveAnthropicCli({ workerIdleSec: n });
                          }
                        }}
                      />
                      <span>seconds</span>
                    </div>
                  </SettingField>
                </div>
              </details>
            </SettingsSection>
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
              <MediaSearchCard />
              <FaceRecognitionCard />
            </>
          )}

          {section === 'audio' && (
            <section>
              <AudioEngineSettings />
            </section>
          )}

          {section === 'webSearch' && (
            <>
              <SettingsSection
                id="settings-web-search"
                title="Web search"
                hint="Powers the web search tools Gezel uses to discover content on the internet. Pick one search backend; configure a key only for the providers you choose."
              >
                <SettingField label="Provider" controlId="settings-web-search-provider">
                  <select
                    id="settings-web-search-provider"
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
                </SettingField>
                <SettingField
                  label="Fallback"
                  controlId="settings-web-search-fallback"
                  hint="Used when the primary is unavailable or errors."
                >
                  <select
                    id="settings-web-search-fallback"
                    aria-describedby={settingHintId('settings-web-search-fallback')}
                    value={config?.webSearch?.fallbackProvider ?? 'unset'}
                    onChange={(e) =>
                      void saveWebSearchFallback(e.target.value as 'brave' | 'wikipedia' | 'unset')
                    }
                  >
                    <option value="unset">None</option>
                    <option value="wikipedia">Wikipedia</option>
                    <option value="brave">Brave Search</option>
                  </select>
                </SettingField>
              </SettingsSection>
              <SettingsSection
                id="settings-brave-search"
                title="Brave Search"
                hint={
                  <>
                    Free tier: 2,000 queries a month, one query a second. Get a key at{' '}
                    <a
                      href="https://api.search.brave.com/app/keys"
                      target="_blank"
                      rel="noreferrer"
                    >
                      api.search.brave.com/app/keys
                    </a>
                    .
                  </>
                }
              >
                <SettingField
                  label="API key"
                  controlId="settings-brave-key"
                  hint={
                    config?.hasBraveSearchApiKey ? (
                      <>
                        Current key:{' '}
                        <code>
                          {'•'.repeat(8)}…{(config?.braveSearchApiKey ?? '').slice(-4)}
                        </code>{' '}
                        <button type="button" className="gz-link-button" onClick={clearBraveKey}>
                          Clear
                        </button>
                      </>
                    ) : undefined
                  }
                >
                  <div className="gz-setting-row">
                    <input
                      id="settings-brave-key"
                      type="password"
                      placeholder={
                        config?.hasBraveSearchApiKey
                          ? 'Replace key…'
                          : 'Paste Brave Search API key…'
                      }
                      aria-label="Brave Search API key"
                      value={braveKeyDraft}
                      onChange={(e) => setBraveKeyDraft(e.target.value)}
                    />
                    <button type="button" onClick={saveBraveKey} disabled={!braveKeyDraft.trim()}>
                      Save
                    </button>
                  </div>
                </SettingField>
              </SettingsSection>
            </>
          )}

          {section === 'channels' && config?.showWorkInProgressFeatures === true && (
            <ChannelsSettings config={config} onConfigChanged={setConfig} />
          )}

          {section === 'connectedApps' && <ConnectedAppsPanel />}
          {section === 'accounts' && <AccountsPanel />}
          {section === 'remoteServers' && <RemoteServersPanel />}

          {section === 'knowledge' && <KnowledgeCatalogsCard />}

          {section === 'toolsets' && (
            <SettingsSection
              id="settings-shared-toolsets"
              title="Shared toolsets"
              hint="Toolsets here are available to every crew member in addition to their own."
            >
              <ToolsetsEditor scope={{ kind: 'shared' }} subject="every crew member" />
            </SettingsSection>
          )}

          {section === 'securityCompliance' && (
            <SecurityComplianceSettings config={config} onConfigChanged={setConfig} />
          )}

          {section === 'about' && (
            <>
              <SettingsSection id="settings-about" title="About">
                {health && (
                  <dl className="settings-facts">
                    <dt>Version</dt>
                    <dd>{health.version === '0.0.0' ? 'development build' : health.version}</dd>
                    <dt>Running since</dt>
                    <dd>{formatStartedAt(health.startedAt)}</dd>
                  </dl>
                )}
                <LocalEngineStatus />
                <AutostartToggle />
                <BackgroundServiceStatus />
                <p className="gz-setting-hint">
                  Something not working right?{' '}
                  <ReportErrorLink
                    className="gz-link-button"
                    label="Report a problem on GitHub"
                    report={{ surface: 'settings-about', message: '' }}
                  />
                </p>
              </SettingsSection>
              <SettingsSection
                id="settings-system-health"
                title="System health"
                hint="What's running under the hood — the local daemon, your Node runtime, the OS, and the system browser toolset used for web actions."
              >
                <HealthStrip />
              </SettingsSection>
              <SettingsSection
                id="settings-updates"
                title="Updates"
                hint="Gezel checks public GitHub release metadata when the desktop app launches. No personal data is sent. Turn this off to stop automatic checks; you can still choose “Check for updates” from the tray menu."
              >
                <SettingCheck
                  label="Check for updates automatically when Gezel starts"
                  checked={config?.autoUpdateChecks !== false}
                  onChange={(checked) => void saveAutoUpdateChecks(checked)}
                />
                <UpdateStatus />
              </SettingsSection>
              <GildeUpdatesCard />
              <StorageUsageCard />
              <SettingsSection id="settings-advanced" title="Advanced">
                <SettingCheck
                  label="Show advanced features"
                  hint="Reveals advanced, power-user surfaces — currently the Scripts area in the sidebar."
                  checked={config?.showAdvancedFeatures === true}
                  onChange={(checked) => void saveShowAdvancedFeatures(checked)}
                />
                <SettingCheck
                  label="Show preview features"
                  hint="Preview features are usable but still changing shape. The current preview is Channels, which lets Gezel send messages to a webhook, such as a Slack channel or a phone notification service."
                  checked={config?.showWorkInProgressFeatures === true}
                  onChange={(checked) => void saveShowWorkInProgressFeatures(checked)}
                />
              </SettingsSection>
              <SettingsSection
                id="settings-debug-mode"
                title="Debug mode"
                hint="Shows the working parts everywhere: each step and the thinking in chat, task ids, model names, and every project's developer tabs. Also turns on verbose diagnostics — tool-call internals, bridge startup traces, chat send/response bodies, and ambient-scheduler cadence reasoning — and enables additional tools."
              >
                <SettingCheck
                  label="Debug mode"
                  checked={config?.debugMode === true}
                  onChange={(checked) => void saveDebugMode(checked)}
                />
                <SettingCheck
                  label="On startup, reset all template-based crew members back to defaults"
                  checked={config?.resetTemplatesOnStartup === true}
                  onChange={(checked) => void saveResetTemplatesOnStartup(checked)}
                />
                <button type="button" className="secondary" onClick={() => void openLogsFolder()}>
                  Open logs folder
                </button>
              </SettingsSection>
              <SettingsLegalSection />
              {/* Removing the app is the lifecycle action, so it comes last. */}
              {isDarwin && window.__GEZEL__?.uninstall && (
                <SettingsSection
                  id="settings-uninstall"
                  title="Uninstall"
                  hint="Remove Gezel and its machine-wide background service. You can keep downloaded models and your work for a later reinstall, or choose exactly which data to delete."
                  actions={
                    <button type="button" className="danger" onClick={requestMacUninstall}>
                      Uninstall Gezel…
                    </button>
                  }
                />
              )}
            </>
          )}

          {section === 'benchmarks' && <BenchmarksView />}
        </Suspense>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}

/**
 * One standing crew role (Meester, Scribe, Librarian, Inspector): a label,
 * the gezel who holds it, and a hint. The picker itself names the holder, so
 * there is no card above it repeating the same gezel. Its last item opens a
 * small form that creates a fresh gezel for the role.
 */
function RoleAssignmentField({
  controlId,
  label,
  hint,
  value,
  gezels,
  roleBasedNameOnly,
  placeholder,
  newItemLabel,
  createLabel,
  createHint,
  onAssign,
  onCreate,
}: {
  controlId: string;
  label: string;
  hint: string;
  value: string | undefined;
  gezels: GezelSummary[];
  roleBasedNameOnly: boolean;
  placeholder: string;
  newItemLabel: string;
  createLabel: string;
  createHint: string;
  onAssign: (id: string) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Settings shows no save notes, so a failure here would otherwise be silent:
  // the form closed and no gezel appeared (1.26313.105 audit).
  const [failure, setFailure] = useState<string | null>(null);
  const close = () => {
    setCreating(false);
    setName('');
    setFailure(null);
  };
  return (
    <SettingField label={label} controlId={controlId} hint={hint}>
      <Select.Root
        value={value ?? ''}
        onValueChange={(next) => {
          if (next === '__new') {
            setCreating(true);
            setName('');
            setFailure(null);
            return;
          }
          setFailure(null);
          onAssign(next).catch((err: unknown) =>
            setFailure(`Couldn't change the ${label}: ${(err as Error).message}`),
          );
        }}
      >
        <Select.Trigger id={controlId} aria-describedby={settingHintId(controlId)}>
          <Select.Value placeholder={placeholder} />
        </Select.Trigger>
        <Select.Content>
          {gezels.map((gezel) => (
            <Select.Item key={gezel.id} value={gezel.id}>
              {assignmentLabel(gezel, roleBasedNameOnly)}
            </Select.Item>
          ))}
          <Select.Item value="__new">{newItemLabel}</Select.Item>
        </Select.Content>
      </Select.Root>
      {creating && (
        <form
          className="gz-setting-panel"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setFailure(null);
            try {
              await onCreate(name);
              close();
            } catch (err) {
              setFailure(`Couldn't create the ${label}: ${(err as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            aria-label={`Name for the new ${label}`}
            placeholder="Name (leave blank for a random pick)"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
          />
          <p className="gz-setting-hint">{createHint}</p>
          <div className="gz-setting-panel-actions">
            <button type="button" className="secondary" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Creating…' : createLabel}
            </button>
          </div>
        </form>
      )}
      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
    </SettingField>
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
    <SettingField
      label="Reasoning mode"
      hint="This model supports a thinking phase, and spends its output budget on it before streaming any reply; if the budget runs out first, the chat bubble is empty. Auto uses Gezel's family-aware default (off for reasoning models), Always on shows the thinking, and Always off skips it for faster direct answers."
    >
      <div className="gz-setting-row">
        {(['auto', 'on', 'off'] as const).map((m) => (
          <label key={m} className="gz-setting-option">
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
    </SettingField>
  );
}

/**
 * Inline status badge for the Copilot panel. Distinguishes the two auth
 * modes ("via CLI" vs "via PAT") based on whether a PAT is stored at the
 * time the probe succeeded, and offers a retest button so the user can
 * re-verify after running `copilot login` without leaving the page.
 */
/**
 * Whether Copilot runs anything here: the default provider, the Night Shift's
 * override, a crew member's own provider, or a stored GitHub token.
 */
export function copilotIsInUse(
  config: Pick<ConfigResponse, 'provider' | 'nightShift' | 'hasGithubToken'> | null | undefined,
  gezels: readonly Pick<GezelSummary, 'provider'>[],
): boolean {
  return (
    config?.provider === 'copilot' ||
    config?.nightShift?.modelOverride?.provider === 'copilot' ||
    config?.hasGithubToken === true ||
    gezels.some((g) => g.provider === 'copilot')
  );
}

function CopilotConnectionStatus({
  probe,
  mode,
  inUse,
  onRetest,
}: {
  probe: { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok' } | { kind: 'fail'; error: string };
  mode: 'cli' | 'pat';
  inUse: boolean;
  onRetest: () => void;
}) {
  const label = mode === 'pat' ? 'via GitHub token' : 'via Copilot CLI';
  return (
    <SettingField label="Connection">
      <div className="gz-setting-row">
        {probe.kind === 'probing' && <span className="gz-setting-hint">Checking connection…</span>}
        {probe.kind === 'ok' && (
          <span className="provider-connection-state" data-tone="success">
            ● Connected {label}
          </span>
        )}
        {/* The provider's own error ("Pending response rejected since
          connection got disposed") stays in the tooltip for whoever needs it. */}
        {probe.kind === 'fail' && (
          <span className="provider-connection-state" data-tone="danger" title={probe.error}>
            ● Not connected. Sign in below, then test the connection again.
          </span>
        )}
        {probe.kind === 'idle' && (
          <span className="gz-setting-hint">
            {inUse ? 'Not checked yet' : 'Not set up. Sign in below to use Copilot.'}
          </span>
        )}
        <button type="button" onClick={onRetest} disabled={probe.kind === 'probing'}>
          Test connection
        </button>
      </div>
    </SettingField>
  );
}
