import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import type {
  CodexPermissionMode,
  GezelSummary,
  Project,
  ProjectApprovalsResponse,
  ProjectDetail,
  ProjectTabVisibility,
} from '@bendyline/gezel';
import {
  getProjectType,
  listProjectTypes,
  normalizeCodexPermissionMode,
  resolveProjectTypeId,
} from '@bendyline/gezel';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AutosaveStatus } from '../components/AutosaveStatus.js';
import { queueComposerPrefill } from '../components/ChatComposer.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ExportToolbarControls } from '../components/DocumentExport/index.js';
import { type FileEntry, FileTree } from '../components/FileTree.js';
import { GezelPicker } from '../components/GezelPicker.js';
import { HtmlPreviewFrame, type HtmlPreviewLogEntry } from '../components/HtmlPreviewFrame.js';
import { ProjectMemoriesEditor } from '../components/MemoriesTree.js';
import { ProjectActionsMenu, ProjectContextMenu } from '../components/ProjectActionsMenu.js';
import type { ProjectTemplateGezelOptions } from '../components/ProjectAddGezelDialog.js';
import { ProjectChat } from '../components/ProjectChat.js';
import { ProjectConnectionsTab } from '../components/ProjectConnectionsTab.js';
import { ProjectCrewRoster } from '../components/ProjectCrewRoster.js';
import { ProjectGitStatusBar } from '../components/ProjectGitStatusBar.js';
import { ProjectMailTab } from '../components/ProjectMailTab.js';
import { ProjectOutputPane } from '../components/ProjectOutputPane.js';
import { ProjectPropertiesEditor } from '../components/ProjectPropertiesEditor.js';
import { PromoteToTabButton } from '../components/PromoteToTabButton.js';
import {
  createArtifactsContentContainer,
  createDocumentLinkProvider,
} from '../components/SquisqIntegration/index.js';
import { ToolsetsEditor } from '../components/ToolsetsEditor.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { consumeCreate } from '../components/nav-intents.js';
import { consumeOpenFile } from '../components/pending-open-file.js';
import {
  type AiProviderEditabilityConfig,
  projectEditableViaAiProvider,
  projectUsesCodex,
} from '../components/project-ai-editability.js';
import { makeReportActionFenceRenderers } from '../components/report-actions/ReportActionFence.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useCompactLayout } from '../components/useCompactLayout.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { crewLeadLabel, crewLeadLabelLower } from '../labels.js';
import { Select, Tabs } from '../primitives/index.js';
import { useEffectiveTheme } from '../theme.js';
import { FileMapView } from './FileMapView.js';
import { HistoryView } from './HistoryView.js';
import { ProjectGitHubView } from './ProjectGithubView.js';
import { ProjectOverviewView } from './ProjectOverviewView.js';
import { TasksView } from './TasksView.js';
import { NewProjectDialog } from './projects/NewProjectDialog.js';

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(name);
}

function isVideo(name: string): boolean {
  return /\.(mp4|webm|mov|m4v|avi|mkv|ogv)$/i.test(name);
}

function isAudio(name: string): boolean {
  return /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(name);
}

/**
 * Sentinel `content` markers for files we render via a binary blob rather
 * than the text editor. `openFileEntry` sets one of these instead of reading
 * the file as text; the viewer panel switches on them.
 */
const MEDIA_IMAGE = '__IMAGE__';
const MEDIA_VIDEO = '__VIDEO__';
const MEDIA_AUDIO = '__AUDIO__';
const BINARY_FILE = '__BINARY__';

/** Sentinels whose `content` is not editable text — they render a viewer. */
const NON_TEXT_CONTENT = new Set([MEDIA_IMAGE, MEDIA_VIDEO, MEDIA_AUDIO, BINARY_FILE]);

/** The media sentinel for a file name, or null when it isn't recognized media. */
function mediaSentinel(name: string): string | null {
  if (isImage(name)) return MEDIA_IMAGE;
  if (isVideo(name)) return MEDIA_VIDEO;
  if (isAudio(name)) return MEDIA_AUDIO;
  return null;
}

/**
 * Heuristic: does this text (decoded UTF-8 from the read API) look like raw
 * binary rather than something a human edits? A NUL byte never appears in
 * real text, and decoding binary as UTF-8 yields a sea of U+FFFD replacement
 * characters and stray control bytes. We sample the head so a huge artifact
 * doesn't cost a full scan. This is the backstop that keeps an unrecognized
 * binary extension (anything not caught by isImage/isVideo/isAudio) out of
 * the text editor.
 */
function looksBinary(content: string): boolean {
  const sample = content.slice(0, 4096);
  if (!sample) return false;
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    // U+FFFD (replacement char) or a control byte that isn't tab/LF/CR.
    if (code === 0xfffd || code < 9 || (code > 13 && code < 32)) suspicious++;
  }
  return suspicious / sample.length > 0.1;
}

const SELECTED_PROJECT_STORAGE_KEY = 'gezel:projects:selectedId';

function projectInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const ch = Array.from(trimmed)[0];
  return ch ? ch.toUpperCase() : '?';
}

function isHtml(name: string): boolean {
  return /\.html?$/i.test(name);
}

function isMarkdown(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

function parentDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

type FileTab = 'workspace' | 'artifacts';
type ProjectTab =
  | 'settings'
  | 'about'
  | 'overview'
  | 'chat'
  | 'tasks'
  | 'packages'
  | 'workspace'
  | 'artifacts'
  | 'github'
  | 'mail'
  | 'connections'
  | 'map'
  | 'history'
  // Compact-only: when the project area is too narrow for the output
  // pane to sit beside the content, it becomes its own tab instead.
  | 'output';

type ConfigurableProjectTab = keyof ProjectTabVisibility;

const PROJECT_TAB_VISIBILITY_OPTIONS: ReadonlyArray<{
  key: ConfigurableProjectTab;
  label: string;
}> = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'workspace', label: 'Workspace' },
  { key: 'artifacts', label: 'Artifacts' },
  { key: 'map', label: 'Village' },
];

/** Missing overrides keep each tab's historical behavior. */
function projectTabIsVisible(
  project: Pick<Project, 'tabVisibility' | 'projectTypeId' | 'detectedProjectType'>,
  tab: ConfigurableProjectTab,
): boolean {
  if (tab === 'map') return project.tabVisibility?.map ?? isMappableProject(project);
  return project.tabVisibility?.[tab] !== false;
}

// Output-pane split width, persisted as a fraction of the project-body
// width (the output pane's share). Global like the chat-rail split so
// the ratio is stable across projects + reloads. Clamped so neither
// side can be squeezed to nothing.
// v1 values were written while the CSS grid used unsupported multiplication,
// so dragging appeared to do nothing and the stored number did not represent
// a choice the user could see. Start v2 at the real 42% default.
const OUTPUT_FRACTION_STORAGE_KEY = 'gezel:project-output-fraction:v2';
const MIN_OUTPUT_FRACTION = 0.18;
const MAX_OUTPUT_FRACTION = 0.7;
const DEFAULT_OUTPUT_FRACTION = 0.42;

function clampOutputFraction(f: number): number {
  if (!Number.isFinite(f)) return DEFAULT_OUTPUT_FRACTION;
  return Math.max(MIN_OUTPUT_FRACTION, Math.min(MAX_OUTPUT_FRACTION, f));
}

function readStoredOutputFraction(): number {
  if (typeof window === 'undefined') return DEFAULT_OUTPUT_FRACTION;
  try {
    const raw = window.localStorage.getItem(OUTPUT_FRACTION_STORAGE_KEY);
    if (!raw) return DEFAULT_OUTPUT_FRACTION;
    return clampOutputFraction(Number.parseFloat(raw));
  } catch {
    return DEFAULT_OUTPUT_FRACTION;
  }
}

/**
 * Per-tab glyph for the compact (narrow / mobile) project tab bar, where
 * word labels are swapped for icons + tooltips so all tabs fit without a
 * horizontal scroller. All strokes use `currentColor`, so each icon
 * inherits the trigger's muted → active color treatment for free.
 */
/**
 * The "Village" tab is for codebases and other file-heavy projects. We gate it
 * on the project's auto-detected type (recomputed each content-index scan from
 * the file mix): shown for code-ish / data types and for as-yet-unclassified
 * projects, hidden for the clearly text/media creative types where a settlement
 * of files isn't useful. It degrades gracefully (empty state) regardless.
 */
const NON_MAPPABLE_TYPES = new Set(['content-writing', 'media-production', 'design-prototype']);
function isMappableProject(p: {
  projectTypeId?: string;
  detectedProjectType?: { id: string };
}): boolean {
  const typeId = resolveProjectTypeId(p);
  return !typeId || !NON_MAPPABLE_TYPES.has(typeId);
}

/** Whether the project should surface the Mail tab (email-typed or has a mailbox). */
function isEmailProject(p: {
  projectTypeId?: string;
  detectedProjectType?: { id: string };
  mail?: { accounts?: unknown[] };
}): boolean {
  return resolveProjectTypeId(p) === 'email' || (p.mail?.accounts?.length ?? 0) > 0;
}

function ProjectTabIcon({ tab }: { tab: ProjectTab }) {
  // Decorative — the trigger carries the accessible name via aria-label +
  // title, so the SVG is aria-hidden. One wrapper, per-tab inner shapes.
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {tabIconShapes(tab)}
    </svg>
  );
}

function tabIconShapes(tab: ProjectTab) {
  switch (tab) {
    case 'output':
      return (
        <>
          <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.2" />
          <path d="M6.5 5.6 L9.8 7.5 L6.5 9.4 Z" fill="currentColor" stroke="none" />
          <line x1="5.5" y1="13.4" x2="10.5" y2="13.4" />
        </>
      );
    case 'chat':
      return (
        <path d="M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v4.4a1.6 1.6 0 0 1-1.6 1.6H6.4L3.4 13V8.6A1.6 1.6 0 0 1 2.6 7Z" />
      );
    case 'about':
      return (
        <>
          <circle cx="8" cy="8" r="6" />
          <line x1="8" y1="7.4" x2="8" y2="11" />
          <circle cx="8" cy="5" r="0.5" fill="currentColor" stroke="none" />
        </>
      );
    case 'tasks':
      return (
        <>
          <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2" />
          <path d="M5.4 8 L7.2 9.8 L10.6 6" />
        </>
      );
    case 'packages':
      return (
        <>
          <path d="M8 2.4 L12.6 4 V7.2 C12.6 10 10.6 12 8 13.2 C5.4 12 3.4 10 3.4 7.2 V4 Z" />
          <path d="M6 7.6 L7.4 9 L10 5.9" />
        </>
      );
    case 'workspace':
      return (
        <path d="M2.6 5.4 A1 1 0 0 1 3.6 4.4 H6 L7.3 5.8 H12.4 A1 1 0 0 1 13.4 6.8 V11.6 A1 1 0 0 1 12.4 12.6 H3.6 A1 1 0 0 1 2.6 11.6 Z" />
      );
    case 'artifacts':
      return (
        <>
          <path d="M4.4 2.6 H8.6 L11.6 5.6 V13 A0.4 0.4 0 0 1 11.2 13.4 H4.4 A0.4 0.4 0 0 1 4 13 V3 A0.4 0.4 0 0 1 4.4 2.6 Z" />
          <path d="M8.4 2.6 V5.6 H11.4" />
        </>
      );
    case 'github':
      return (
        <>
          <circle cx="4.6" cy="4.2" r="1.5" />
          <circle cx="4.6" cy="11.8" r="1.5" />
          <circle cx="11.4" cy="5.6" r="1.5" />
          <path d="M4.6 5.7 V10.3" />
          <path d="M11.4 7.1 C11.4 9.4 9.4 9.6 7.2 9.7 C5.6 9.8 4.6 10 4.6 11" />
        </>
      );
    case 'mail':
      return (
        <>
          <rect x="2.5" y="4" width="11" height="8" rx="0.7" />
          <path d="M2.8 4.6 L8 8.6 L13.2 4.6" />
        </>
      );
    case 'connections':
      return (
        <>
          <path d="M6 10 L4.2 11.8 A2.2 2.2 0 0 1 4.2 8.6 L5.6 7.2" />
          <path d="M10 6 L11.8 4.2 A2.2 2.2 0 0 1 11.8 7.4 L10.4 8.8" />
          <path d="M6.4 9.6 L9.6 6.4" />
        </>
      );
    case 'history':
      return (
        <>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.6 V8 L10.4 9.4" />
        </>
      );
    case 'map':
      return (
        <>
          <path d="M1.6 13.4 V7.2 L5.6 3.8 L9.6 7.2 V13.4" />
          <path d="M9.6 13.4 V9 L12 6.9 L14.4 9 V13.4" />
          <path d="M4.4 13.4 V10.2 H6.8 V13.4" />
          <path d="M1.2 13.4 H14.8" />
        </>
      );
    case 'overview':
      return (
        <>
          <circle cx="8" cy="8" r="5.8" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
          <line x1="8" y1="2.2" x2="8" y2="4.4" />
          <line x1="8" y1="11.6" x2="8" y2="13.8" />
          <line x1="2.2" y1="8" x2="4.4" y2="8" />
          <line x1="11.6" y1="8" x2="13.8" y2="8" />
        </>
      );
    default:
      // settings — sliders read more cleanly than a tiny gear at 16px.
      return (
        <>
          <line x1="3" y1="5" x2="13" y2="5" />
          <line x1="3" y1="11" x2="13" y2="11" />
          <circle cx="6" cy="5" r="1.5" fill="var(--panel)" />
          <circle cx="10" cy="11" r="1.5" fill="var(--panel)" />
        </>
      );
  }
}

interface AvailableCredential {
  name: string;
  label: string;
  stored: boolean;
  allowedOrigins: string[];
  originSource: 'provider' | 'webhook' | 'project';
}

function credentialDestinationHint(credential: AvailableCredential): string | null {
  if (!credential.stored) return null;
  if (credential.allowedOrigins.length === 0) {
    return credential.originSource === 'webhook'
      ? 'Configure an HTTPS webhook URL in Settings → Channels first'
      : 'No HTTPS destination configured';
  }
  const destinations = credential.allowedOrigins.map((origin) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  });
  return `Restricted to ${destinations.join(', ')}`;
}

interface ProjectsViewProps {
  /** When set, mounts in detail-only mode: hides the listing sidebar and
   *  auto-opens the given project. Used for the unified tab-bar surface
   *  where a project tab renders the detail directly under the bar. */
  forceProjectId?: string;
  /** Narrow form factor (VS Code chat sidebar, mobile). Forwarded to
   *  ProjectChat so the right-rail commands/references panel is
   *  suppressed; the chat surface gets the full pane width. Other
   *  tabs render unchanged today — refine per-tab as we polish the
   *  embedded experience. */
  compact?: boolean;
}

/** Tab-content wrapper that mounts ProjectsView in detail-only mode. The
 *  shadowed name `ProjectDetail` would collide with the schema type of the
 *  same name imported from `@bendyline/gezel`, so the component carries a
 *  `View` suffix. */
export function ProjectDetailView({
  projectId,
  compact = false,
}: {
  projectId: string;
  compact?: boolean;
}) {
  return <ProjectsView forceProjectId={projectId} compact={compact} />;
}

export function ProjectsView({ forceProjectId, compact = false }: ProjectsViewProps = {}) {
  const detailOnly = forceProjectId !== undefined;
  // Auto-compact: observe the outermost container's width and flip
  // to compact layout when it drops below the threshold. The
  // explicit `compact` prop is OR-merged in — a host that knows
  // it's narrow (VS Code webview) can force compact even if the
  // measurement hasn't landed yet on cold mount. See
  // [components/useCompactLayout.ts](../components/useCompactLayout.ts).
  const containerRef = useRef<HTMLDivElement | null>(null);
  const autoCompact = useCompactLayout(containerRef);
  const effectiveCompact = compact || autoCompact;
  const editorTheme = useEffectiveTheme();
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<ProjectDetail | null>(null);
  const [changingArchive, setChangingArchive] = useState(false);
  const [recentlyAddedGezelId, setRecentlyAddedGezelId] = useState<string | undefined>(undefined);
  // Consume a pending "+" intent from the sidebar synchronously on first
  // render (the event below covers the already-mounted case). Never in
  // detail-only mode — a single project tab has no create UI.
  const [createMode, setCreateMode] = useState<'crew' | 'solo' | null>(() =>
    !detailOnly && consumeCreate('project') ? 'crew' : null,
  );
  const [pkgName, setPkgName] = useState('');
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [packageScripts, setPackageScripts] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<ProjectApprovalsResponse | null>(null);

  const [tab, setTab] = useState<ProjectTab>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('gezel.projectsSidebarCollapsed') === '1';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem('gezel.projectsSidebarCollapsed', sidebarCollapsed ? '1' : '0');
    } catch {}
  }, [sidebarCollapsed]);
  // `fileTab` is the active view inside the Workspace/Artifacts file
  // panel. Derived from the main tab — Workspace and Artifacts are
  // now their own top-level tabs rather than a sub-tabs inside a
  // combined "Files" panel. `null` when the current tab isn't a file
  // panel.
  const fileTab: FileTab | null =
    tab === 'workspace' ? 'workspace' : tab === 'artifacts' ? 'artifacts' : null;
  const [workspaceFiles, setWorkspaceFiles] = useState<FileEntry[]>([]);
  const [workspaceHtmlFiles, setWorkspaceHtmlFiles] = useState<string[]>([]);
  const [artifactFiles, setArtifactFiles] = useState<FileEntry[]>([]);
  const [workspaceTruncated, setWorkspaceTruncated] = useState(false);
  const [artifactsTruncated, setArtifactsTruncated] = useState(false);
  const [openFile, setOpenFile] = useState<{
    path: string;
    content: string;
    source: FileTab;
  } | null>(null);
  const [newFileName, setNewFileName] = useState('');
  // Output-pane visibility override. `null` = follow the auto default
  // (visible when the workspace has a previewable index.html); an
  // explicit boolean is the user's toggle choice, persisted per project
  // so it survives reloads and project switches. See the toggle in the
  // entity-tabs-row and [ProjectOutputPane](../components/ProjectOutputPane.tsx).
  const [outputOverride, setOutputOverride] = useState<boolean | null>(null);
  // When the selected project has an applied custom project type that pins an
  // Output page (its dashboard), this holds that page so the output pane can
  // show it ahead of the workspace auto-ranker. See docs/project-types.md.
  const [typePage, setTypePage] = useState<{
    entry: string;
    label: string;
    pageTools?: string[];
  } | null>(null);
  const [gezels, setGezels] = useState<GezelSummary[]>([]);
  const [projectLocalGezelRoster, setProjectLocalGezelRoster] = useState<{
    projectId: string;
    gezels: GezelSummary[];
  } | null>(null);
  const [aiProviderConfig, setAiProviderConfig] = useState<AiProviderEditabilityConfig | null>(
    null,
  );
  const [boekwachterGezelId, setBoekwachterGezelId] = useState<string | undefined>();
  const [workingDirDraft, setWorkingDirDraft] = useState('');
  const [showAllowWritesConfirm, setShowAllowWritesConfirm] = useState(false);
  const [writesJournal, setWritesJournal] = useState<
    Array<{
      at: string;
      op: 'write' | 'delete' | 'mkdir' | 'rename';
      path: string;
      fromPath?: string;
      bytes?: number;
      gezelId?: string;
    }>
  >([]);
  const [githubUrlDraft, setGitHubUrlDraft] = useState('');
  const [gitStatus, setGitStatus] = useState<string>('');
  const [availableCredentials, setAvailableCredentials] = useState<AvailableCredential[]>([]);
  const configuredCredentials = availableCredentials.filter((credential) => credential.stored);

  const refresh = useCallback(async () => {
    try {
      setProjects((await api.listProjects()).projects);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const activeProjects = useMemo(() => projects.filter((project) => !project.archived), [projects]);
  const archivedProjects = useMemo(
    () => projects.filter((project) => project.archived),
    [projects],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Archive/restore originates from either a rail menu or the open-project
  // header. Keep both the grouped list and the loaded detail in sync from one
  // event; the global sidebar listens to the same event and hides/reveals its
  // row immediately.
  useEffect(() => {
    const onUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ projectId?: string; project?: ProjectDetail }>).detail;
      if (!detail?.projectId) return;
      if (!detail.project) {
        void refresh();
        return;
      }
      setProjects((current) =>
        current.map((project) =>
          project.id === detail.projectId ? { ...project, ...detail.project } : project,
        ),
      );
      setSelected((current) => (current?.id === detail.projectId ? detail.project! : current));
    };
    window.addEventListener('gezel:project-updated', onUpdated);
    return () => window.removeEventListener('gezel:project-updated', onUpdated);
  }, [refresh]);

  // Already-mounted case: a "+" click while the listing is open arrives as
  // an event (the lazy initializer above only runs on a fresh mount).
  useEffect(() => {
    if (detailOnly) return;
    const onNew = () => {
      consumeCreate('project');
      setCreateMode('crew');
    };
    window.addEventListener('gezel:new-project', onNew);
    return () => window.removeEventListener('gezel:new-project', onNew);
  }, [detailOnly]);

  // A project was deleted (via the Project Actions menu here or in the
  // sidebar, or by a gezel through the API). Refresh the rail and, if the
  // open project is the one that vanished, clear the detail pane.
  useEffect(() => {
    const onDeleted = (ev: Event) => {
      const projectId = (ev as CustomEvent<{ projectId?: string }>).detail?.projectId;
      void refresh();
      if (projectId) setSelected((current) => (current?.id === projectId ? null : current));
    };
    window.addEventListener('gezel:project-deleted', onDeleted);
    return () => window.removeEventListener('gezel:project-deleted', onDeleted);
  }, [refresh]);

  const refreshGezels = useCallback(async () => {
    try {
      setGezels((await api.listGezels()).gezels);
    } catch (err) {
      console.error('[ProjectsView] listGezels failed', err);
    }
  }, []);

  const refreshProjectConfig = useCallback(async () => {
    try {
      const config = await api.getConfig();
      setBoekwachterGezelId(config.boekwachterGezelId);
      setAiProviderConfig(config);
    } catch {
      /* non-fatal — the status bar keeps the scoped edits control */
    }
  }, []);

  useEffect(() => {
    void refreshGezels();
    void refreshProjectConfig();
  }, [refreshGezels, refreshProjectConfig]);

  useEffect(() => {
    const onConfigUpdated = () => void refreshProjectConfig();
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => window.removeEventListener('gezel:config-updated', onConfigUpdated);
  }, [refreshProjectConfig]);

  useEffect(() => {
    const onGezelUpdated = () => void refreshGezels();
    window.addEventListener('gezel:gezel-updated', onGezelUpdated);
    return () => window.removeEventListener('gezel:gezel-updated', onGezelUpdated);
  }, [refreshGezels]);

  const selectedProjectId = selected?.id;
  useEffect(() => {
    if (!selectedProjectId) {
      setProjectLocalGezelRoster(null);
      return;
    }
    let cancelled = false;
    const refreshProjectLocalGezels = () => {
      api
        .listProjectLocalGezels(selectedProjectId)
        .then((response) => {
          if (!cancelled) {
            setProjectLocalGezelRoster({ projectId: selectedProjectId, gezels: response.gezels });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setProjectLocalGezelRoster({ projectId: selectedProjectId, gezels: [] });
          }
        });
    };
    const onGezelUpdated = () => refreshProjectLocalGezels();
    refreshProjectLocalGezels();
    window.addEventListener('gezel:gezel-updated', onGezelUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:gezel-updated', onGezelUpdated);
    };
  }, [selectedProjectId]);

  const aiAccess = useMemo(() => {
    if (!selected) return { editableViaAiProvider: false, codexInUse: false };
    const projectLocalGezels =
      projectLocalGezelRoster?.projectId === selected.id ? projectLocalGezelRoster.gezels : [];
    return {
      editableViaAiProvider: projectEditableViaAiProvider(
        selected,
        gezels,
        projectLocalGezels,
        aiProviderConfig,
      ),
      codexInUse: projectUsesCodex(selected, gezels, projectLocalGezels, aiProviderConfig),
    };
  }, [selected, gezels, projectLocalGezelRoster, aiProviderConfig]);

  const effectiveCodexMode = normalizeCodexPermissionMode(
    selected?.codexPermissionMode ?? aiProviderConfig?.codexCli?.defaultPermissionMode,
  );

  const addProjectGezel = useCallback(
    async (gezelId: string) => {
      if (!selected) return;
      const result = await api.addGezelToProject(selected.id, gezelId);
      setRecentlyAddedGezelId(gezelId);
      setSelected((current) =>
        current?.id === selected.id ? { ...current, gezelIds: result.gezelIds } : current,
      );
    },
    [selected],
  );

  const removeProjectGezel = useCallback(
    async (gezelId: string) => {
      if (!selected) return;
      const result = await api.removeGezelFromProject(selected.id, gezelId);
      setSelected((current) =>
        current?.id === selected.id ? { ...current, gezelIds: result.gezelIds } : current,
      );
    },
    [selected],
  );

  const createProjectTemplateGezel = useCallback(
    async (templateId: string, options: ProjectTemplateGezelOptions) => {
      if (!selected) return;
      const projectId = selected.id;
      let created = await api.createGezelFromTemplate(templateId, {
        name: options.name,
        ...(options.gender ? { gender: options.gender } : {}),
      });
      if (options.appearanceSeed !== undefined) {
        const { poppetje } = await api.rerollGezelPoppetje(created.id, {
          seed: options.appearanceSeed,
        });
        created = { ...created, poppetje };
      }
      const membership = await api.addGezelToProject(projectId, created.id);
      setRecentlyAddedGezelId(created.id);
      setGezels((current) => [...current.filter((gezel) => gezel.id !== created.id), created]);
      setSelected((current) =>
        current?.id === projectId ? { ...current, gezelIds: membership.gezelIds } : current,
      );
      window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail: created }));
    },
    [selected],
  );

  const refreshFiles = useCallback(async (id: string) => {
    const [ws, art] = await Promise.all([
      api.listProjectWorkspace(id, '', true),
      api.listProjectArtifacts(id, '', true),
    ]);
    setWorkspaceFiles(ws.files);
    setArtifactFiles(art.files);
    setWorkspaceTruncated(ws.truncated === true);
    setArtifactsTruncated(art.truncated === true);
  }, []);

  // Output discovery has deliberately tighter traversal rules than the full
  // Workspace file tree: no node_modules/dot-folders, and at most four
  // containing folders from the workspace root.
  const refreshOutputFiles = useCallback(async (id: string) => {
    const res = await api.listProjectWorkspaceHtmlPages(id);
    setWorkspaceHtmlFiles(res.files.map((file) => file.path));
  }, []);

  const refreshProjectFiles = useCallback(
    async (id: string) => {
      await Promise.all([refreshFiles(id), refreshOutputFiles(id)]);
    },
    [refreshFiles, refreshOutputFiles],
  );

  // Re-list files whenever the user switches to a file panel. Chat-driven
  // tool calls (write_artifact, delete_artifact) land on disk immediately
  // but the tree here only re-reads on explicit UI actions — without this
  // effect the tab would sit on a stale snapshot until the user performed
  // a manual refresh action like renaming a file.
  useEffect(() => {
    if (fileTab === null || !selected) return;
    void refreshProjectFiles(selected.id);
  }, [fileTab, selected, refreshProjectFiles]);

  useEffect(() => {
    if (tab !== 'packages' || !selected) {
      setPackageScripts({});
      setApprovals(null);
      return;
    }
    api
      .listPackageScripts(selected.id)
      .then((res) => setPackageScripts(res.scripts))
      .catch((err) => {
        console.warn('[ProjectsView] listPackageScripts failed', err);
        setPackageScripts({});
      });
    api
      .getProjectApprovals(selected.id)
      .then(setApprovals)
      .catch((err) => {
        console.warn('[ProjectsView] getProjectApprovals failed', err);
        setApprovals(null);
      });
  }, [tab, selected]);

  // Switching between the Workspace and Artifacts tabs should clear the
  // viewer — otherwise the user would see a workspace file after
  // jumping to Artifacts and get confused about what source it came
  // from. (Previously handled by the inner Tabs.Root's onValueChange.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: fileTab is the reset trigger.
  useEffect(() => {
    setOpenFile(null);
  }, [fileTab]);

  // Refresh the workspace-writes journal when the user lands on the
  // Settings tab (which hosts the project brief + settings sections). Surfaces "what has
  // a gezel changed recently?" inline next to the allow-writes toggle so
  // reviewing damage is one glance.
  useEffect(() => {
    if (tab !== 'about' || !selected) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.listWorkspaceWrites(selected.id, 20);
        if (!cancelled) setWritesJournal(res.entries);
      } catch {
        /* non-fatal — the section just stays empty */
      }
      try {
        const res = await api.listAvailableCredentials();
        if (!cancelled) {
          setAvailableCredentials(
            res.credentials.map((credential) => {
              const wire = credential as typeof credential & {
                allowedOrigins?: string[];
                originSource?: AvailableCredential['originSource'];
              };
              return {
                name: credential.name,
                label: credential.label,
                stored: credential.stored,
                allowedOrigins: wire.allowedOrigins ?? credential.defaultOrigins,
                originSource:
                  wire.originSource ??
                  (credential.name.startsWith('webhook.') ? 'webhook' : 'provider'),
              };
            }),
          );
        }
      } catch {
        /* non-fatal — grants UI hides */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, selected]);

  const toggleGrant = useCallback(
    async (credentialName: string, grant: boolean) => {
      if (!selected) return;
      const current = selected.grantedCredentials ?? [];
      const next = grant
        ? Array.from(new Set([...current, credentialName]))
        : current.filter((n) => n !== credentialName);
      const credential = availableCredentials.find((item) => item.name === credentialName);
      if (grant && (credential?.allowedOrigins.length ?? 0) === 0) {
        setError(`Configure an HTTPS destination for ${credentialName} before granting it.`);
        return;
      }
      try {
        const updated = await api.updateProject(selected.id, {
          grantedCredentials: next,
        });
        setSelected(updated);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selected, availableCredentials],
  );

  /**
   * Seed the project-chat composer with a formatted complaint about a
   * preview-pane JavaScript error. **Does not auto-send** — the user
   * lands on the Chat tab with the message pre-filled in the composer,
   * can edit or expand it with more context, and hits Send themselves.
   * Auto-sending proved disorienting (the message disappeared into a
   * session switch and left no UI trace for the user to verify it
   * landed), whereas a pre-filled draft makes the intent explicit and
   * reversible.
   */
  const complainAboutPreviewError = useCallback(
    (entry: HtmlPreviewLogEntry, file: { path: string; source: FileTab }): void => {
      if (!selected) return;
      const message = formatPreviewComplaint(entry, file);
      queueComposerPrefill(selected.id, message);
      setTab('chat');
    },
    [selected],
  );

  /**
   * Land a captured output-pane "debug frame" (screenshot + browser-state
   * report) in the project-chat composer. Like {@link
   * complainAboutPreviewError}, it pre-fills rather than auto-sends — the
   * user reviews the frame, adds a question, and hits Send themselves —
   * and reveals the Chat tab so the seeded draft is visible.
   */
  const injectDebugFrame = useCallback(
    (markdown: string): void => {
      if (!selected) return;
      queueComposerPrefill(selected.id, markdown);
      setTab('chat');
    },
    [selected],
  );

  const openProject = useCallback(
    async (id: string) => {
      const project = await api.getProject(id);
      setSelected(project);
      setOpenFile(null);
      setWorkspaceFiles([]);
      setWorkspaceHtmlFiles([]);
      setArtifactFiles([]);
      setTab('chat');
      setWorkingDirDraft(project.workingDir ?? '');
      setGitHubUrlDraft(project.github?.url ?? '');
      setGitStatus('');
      await refreshOutputFiles(id);
      // Emit a project-opened event so the top-nav MRU (see App.tsx)
      // can promote this project to the front of its recents list.
      window.dispatchEvent(
        new CustomEvent('gezel:project-opened', {
          detail: { id: project.id, name: project.name },
        }),
      );
    },
    [refreshOutputFiles],
  );

  // Open a specific file in the (already-selected) project. Takes an explicit
  // projectId rather than relying on `selected` so it works right after an
  // `openProject` whose `setSelected` hasn't flushed yet (the search quick-open
  // path). Switches to the right file panel, then loads the file.
  const focusFile = useCallback(async (projectId: string, path: string, source: FileTab) => {
    setTab(source);
    const name = path.slice(path.lastIndexOf('/') + 1);
    const media = mediaSentinel(name);
    if (media) {
      setOpenFile({ path, content: media, source });
      return;
    }
    const res =
      source === 'workspace'
        ? await api.readProjectWorkspaceFile(projectId, path)
        : await api.readProjectArtifact(projectId, path);
    const content = looksBinary(res.content) ? BINARY_FILE : res.content;
    setOpenFile({ ...res, content, source });
  }, []);

  // Respond to nav-shortcut clicks from the top-bar MRU chips in App.tsx:
  // the shortcut dispatches `gezel:open-project` with the id, and we open
  // the project here as if the user had clicked it in the sidebar.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId) void openProject(detail.projectId);
    };
    window.addEventListener('gezel:open-project', onOpen);
    return () => window.removeEventListener('gezel:open-project', onOpen);
  }, [openProject]);

  // Open a file in the currently-selected project (the already-open case — no
  // remount). The cross-project remount case is handled by the mailbox consume
  // in the forceProjectId effect below; draining it here keeps a queued intent
  // from firing later on a manual navigation.
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const d = (e as CustomEvent<{ projectId?: string; path?: string; source?: FileTab }>).detail;
      if (!d?.path || !d.source) return;
      if (selected && (!d.projectId || d.projectId === selected.id)) {
        consumeOpenFile(selected.id);
        void focusFile(selected.id, d.path, d.source);
      }
    };
    window.addEventListener('gezel:open-file', onOpenFile);
    return () => window.removeEventListener('gezel:open-file', onOpenFile);
  }, [selected, focusFile]);

  // Detail-only mode: open the forced project on mount / change, then consume
  // any queued "open this file" intent the search left for this project.
  useEffect(() => {
    if (!forceProjectId) return;
    void openProject(forceProjectId).then(() => {
      const intent = consumeOpenFile(forceProjectId);
      if (intent) void focusFile(forceProjectId, intent.path, intent.source);
    });
  }, [forceProjectId, openProject, focusFile]);

  /**
   * Hook the dialog-driven create flow up to the rest of the page: refresh
   * the sidebar, promote the new project to selected, reset side state. The
   * dialog itself owns the form + validation + API call.
   */
  const handleProjectCreated = useCallback(
    async (created: ProjectDetail) => {
      await refresh();
      setSelected(created);
      setOpenFile(null);
      setWorkspaceFiles([]);
      setWorkspaceHtmlFiles([]);
      setArtifactFiles([]);
      setTab('chat');
      setWorkingDirDraft('');
      setGitHubUrlDraft('');
      setGitStatus('');
      await refreshOutputFiles(created.id);
    },
    [refresh, refreshOutputFiles],
  );

  const install = useCallback(async () => {
    if (!selected || !pkgName.trim()) return;
    setLog('installing…');
    try {
      const res = await api.installPackage(selected.id, { name: pkgName.trim() });
      setLog(res.log);
      setSelected(res.project);
      setPkgName('');
    } catch (err) {
      setLog((err as Error).message);
    }
  }, [pkgName, selected]);

  const saveGitHubUrl = useCallback(
    async (nextRaw: string) => {
      if (!selected) return;
      const next = nextRaw.trim();
      const current = selected.github?.url ?? '';
      if (next === current) return;
      try {
        if (next === '') {
          const updated = await api.updateProject(selected.id, { github: null });
          setSelected(updated);
          setGitStatus('Unlinked.');
          return;
        }
        const updated = await api.updateProject(selected.id, { github: { url: next } });
        setSelected(updated);
        setGitStatus('Cloning…');
        try {
          const res = await api.cloneProjectGit(selected.id);
          const after = await api.getProject(selected.id);
          setSelected(after);
          setGitStatus(res.adopted ? 'Adopted existing checkout.' : 'Cloned.');
        } catch (err) {
          const message = (err as Error).message || 'clone failed';
          setGitStatus(`Linked, but clone failed: ${message}`);
        }
      } catch (err) {
        setGitStatus(`save failed: ${(err as Error).message}`);
      }
    },
    [selected],
  );

  const saveWorkingDir = useCallback(
    async (nextRaw: string) => {
      if (!selected) return;
      const next = nextRaw.trim() || undefined;
      const current = selected.workingDir ?? undefined;
      if (next === current) return;
      try {
        const updated = await api.setProjectWorkingDir(selected.id, next);
        setSelected(updated);
        await refreshProjectFiles(selected.id);
      } catch (err) {
        // Path was probably invalid. Keep the draft so the user can fix it;
        // surface a console error for now. A proper inline error UI can land
        // alongside other project-config validation later.
        console.error('setProjectWorkingDir failed:', err);
      }
    },
    [selected, refreshProjectFiles],
  );

  const saveAllowGezelWrites = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, { allowGezelWrites: next });
        setSelected(updated);
      } catch (err) {
        console.error('updateProject(allowGezelWrites) failed:', err);
      }
    },
    [selected],
  );

  const saveCodexPermissionMode = useCallback(
    async (next: CodexPermissionMode) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, { codexPermissionMode: next });
        setSelected(updated);
      } catch (err) {
        console.error('updateProject(codexPermissionMode) failed:', err);
      }
    },
    [selected],
  );

  const saveIndexingEnabled = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, { indexingEnabled: next });
        setSelected(updated);
        if (next) {
          // This was an explicit user action; start the first scan now instead
          // of waiting for the background MRU cadence.
          void api.refreshProjectIndex(selected.id).catch(() => {});
        }
      } catch (err) {
        console.error('updateProject(indexingEnabled) failed:', err);
      }
    },
    [selected],
  );

  const saveMeesterProgressCheckExemption = useCallback(
    async (exempt: boolean) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, {
          nudgeConfig: {
            ...selected.nudgeConfig,
            enabled: !exempt,
          },
        });
        setSelected(updated);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selected],
  );

  const saveTabVisibility = useCallback(
    async (key: ConfigurableProjectTab, visible: boolean) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, {
          tabVisibility: {
            ...selected.tabVisibility,
            [key]: visible,
          },
        });
        setSelected(updated);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [selected],
  );

  const openFileEntry = useCallback(
    async (entry: FileEntry, source: FileTab) => {
      if (!selected || entry.isDirectory) return;
      // Media is rendered from a binary blob, never read as text. Reading an
      // MP4/MP3/etc. through the text API and feeding it to EditorShell paints
      // the raw bytes as garbled characters.
      const media = mediaSentinel(entry.name);
      if (media) {
        setOpenFile({ path: entry.path, content: media, source });
      } else {
        const res =
          source === 'workspace'
            ? await api.readProjectWorkspaceFile(selected.id, entry.path)
            : await api.readProjectArtifact(selected.id, entry.path);
        // Backstop for binary types we don't recognize by extension: keep raw
        // bytes out of the text editor.
        const content = looksBinary(res.content) ? BINARY_FILE : res.content;
        setOpenFile({ ...res, content, source });
      }
    },
    [selected],
  );

  // Stable identity + functional setState. Inline arrow + stale closure here
  // used to churn the EditorShell's `[markdownSource, onChange]` effect every
  // render, producing a feedback loop that ate click events on the file tree.
  const handleEditorContentChange = useCallback((source: string) => {
    setOpenFile((prev) => (prev ? { ...prev, content: source } : prev));
  }, []);

  const saveArtifact = useCallback(async () => {
    if (
      !selected ||
      !openFile ||
      openFile.source !== 'artifacts' ||
      NON_TEXT_CONTENT.has(openFile.content)
    )
      return;
    await api.writeProjectArtifact(selected.id, openFile.path, openFile.content);
    await refreshFiles(selected.id);
  }, [selected, openFile, refreshFiles]);

  const createArtifact = useCallback(async () => {
    if (!selected || !newFileName.trim()) return;
    await api.writeProjectArtifact(selected.id, newFileName.trim(), '');
    setNewFileName('');
    await refreshFiles(selected.id);
  }, [selected, newFileName, refreshFiles]);

  const deleteArtifact = useCallback(
    async (entry: FileEntry) => {
      if (!selected) return;
      await api.deleteProjectArtifact(selected.id, entry.path);
      if (openFile?.path === entry.path) setOpenFile(null);
      await refreshFiles(selected.id);
    },
    [selected, openFile, refreshFiles],
  );

  const reveal = useCallback(
    async (which: 'workspace' | 'artifacts') => {
      if (!selected) return;
      await api.revealProject(selected.id, which);
    },
    [selected],
  );

  const imageUrl = useCallback(
    (path: string, source: FileTab) =>
      selected
        ? `/api/projects/${selected.id}/${source === 'workspace' ? 'workspace' : 'artifacts'}/read?path=${encodeURIComponent(path)}&raw=1`
        : '',
    [selected],
  );

  const activeEntries = fileTab === 'workspace' ? workspaceFiles : artifactFiles;
  const isReadOnly = fileTab === 'workspace';

  // Output pane: the set of previewable workspace HTML files, whether a
  // previewable index.html exists (drives the auto-on default), and the
  // resolved visibility (per-project user override wins over the auto
  // default). The toggle persists the override to localStorage.
  const hasIndexHtml = useMemo(
    () => workspaceHtmlFiles.some((p) => /(^|\/)index\.html?$/i.test(p)),
    [workspaceHtmlFiles],
  );
  // Load the persisted per-project override whenever the project changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the selected project id.
  useEffect(() => {
    if (!selected) {
      setOutputOverride(null);
      return;
    }
    try {
      const raw = window.localStorage.getItem(`gezel.projectOutputVisible:${selected.id}`);
      setOutputOverride(raw === null ? null : raw === '1');
    } catch {
      setOutputOverride(null);
    }
  }, [selected?.id]);
  // Resolve the pinned type page (if any) whenever the selected project's
  // applied project type changes. The provenance on project.json carries the
  // type id/version/source; the page entry lives on the type's manifest, so
  // we fetch the detail to read `pages.entry`.
  const projectTypeProvenance = selected?.projectType;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the provenance identity below.
  useEffect(() => {
    let cancelled = false;
    if (!projectTypeProvenance) {
      setTypePage(null);
      return;
    }
    void (async () => {
      try {
        const detail = await api.getCatalogItem('project-type', projectTypeProvenance.id, {
          source: projectTypeProvenance.source,
          version: projectTypeProvenance.version,
        });
        const pages = detail.manifest.kind === 'project-type' ? detail.manifest.pages : undefined;
        // Only names that resolve to a declared tool open the bridge — a
        // typo'd pages.tools entry must not widen the invokable surface.
        const declared =
          detail.manifest.kind === 'project-type'
            ? new Set((detail.manifest.tools ?? []).map((t) => t.name))
            : new Set<string>();
        const pageTools = (pages?.tools ?? []).filter((name) => declared.has(name));
        if (!cancelled) {
          setTypePage(
            pages?.entry
              ? {
                  entry: pages.entry,
                  label: 'Dashboard',
                  ...(pageTools.length > 0 ? { pageTools } : {}),
                }
              : null,
          );
        }
      } catch {
        if (!cancelled) setTypePage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectTypeProvenance?.id, projectTypeProvenance?.version, projectTypeProvenance?.source]);

  // A pinned type page makes the pane worth showing even without a workspace
  // index.html — the user's explicit toggle still wins.
  const outputVisible =
    Boolean(selected) && (outputOverride ?? (hasIndexHtml || Boolean(typePage)));
  const toggleOutput = useCallback(() => {
    if (!selected) return;
    const next = !outputVisible;
    setOutputOverride(next);
    try {
      window.localStorage.setItem(`gezel.projectOutputVisible:${selected.id}`, next ? '1' : '0');
    } catch {
      /* quota / private mode — state still lives in memory */
    }
  }, [selected, outputVisible]);

  // Resizable splitter between the output pane and the tab content. The
  // output pane is the LEFT column, so dragging the grip right grows it.
  // Reuses the chat-rail `body.chat-rail-resizing` class to suppress
  // iframe pointer-capture during the drag.
  const projectBodyRef = useRef<HTMLDivElement | null>(null);
  const [outputFraction, setOutputFraction] = useState<number>(() => readStoredOutputFraction());
  const outputDragState = useRef<{ startX: number; startFraction: number; width: number } | null>(
    null,
  );
  const commitOutputFraction = useCallback((next: number) => {
    const clamped = clampOutputFraction(next);
    setOutputFraction(clamped);
    try {
      window.localStorage.setItem(OUTPUT_FRACTION_STORAGE_KEY, clamped.toFixed(4));
    } catch {
      /* quota / private mode — state still in memory */
    }
  }, []);
  const onOutputGripMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      outputDragState.current = {
        startX: e.clientX,
        startFraction: outputFraction,
        width: projectBodyRef.current?.clientWidth ?? 1,
      };
      document.body.classList.add('chat-rail-resizing');
      document.body.style.cursor = 'col-resize';
      const onMove = (ev: MouseEvent) => {
        const st = outputDragState.current;
        if (!st || st.width <= 0) return;
        // Output is on the left: moving right (positive delta) grows it.
        commitOutputFraction(st.startFraction + (ev.clientX - st.startX) / st.width);
      };
      const onUp = () => {
        outputDragState.current = null;
        document.body.style.cursor = '';
        document.body.classList.remove('chat-rail-resizing');
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [outputFraction, commitOutputFraction],
  );
  const onOutputGripKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 0.08 : 0.02;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        commitOutputFraction(outputFraction + step);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        commitOutputFraction(outputFraction - step);
      } else if (e.key === 'Home') {
        e.preventDefault();
        commitOutputFraction(MIN_OUTPUT_FRACTION);
      } else if (e.key === 'End') {
        e.preventDefault();
        commitOutputFraction(MAX_OUTPUT_FRACTION);
      }
    },
    [outputFraction, commitOutputFraction],
  );

  // Compact (narrow / mobile) form factor: the output pane can't sit
  // beside the content, so it becomes its own tab. It's offered whenever
  // the workspace has any previewable HTML.
  const compactOutputAvailable = effectiveCompact && workspaceHtmlFiles.length > 0;
  // Keep the active tab valid as the form factor / availability changes:
  // 'output' only exists in compact mode while there's output to show.
  useEffect(() => {
    if (tab === 'output' && !compactOutputAvailable) setTab('chat');
  }, [tab, compactOutputAvailable]);
  // Wide: output pane sits beside the content (resizable). Compact: it
  // takes over the body as the active 'output' tab. The tab content is
  // hidden only in the compact-output case.
  const showOutputBeside = !effectiveCompact && outputVisible;
  const showOutputAsTab = compactOutputAvailable && tab === 'output';

  // Clicking a row opens the project in the right pane — both in listing
  // mode (the Projects area tab) and detail-only mode (a single-project
  // tab, where the row click also acts as a "switch project from the
  // sidebar"). Single-project tabs in the global MRU still come from the
  // outside (chat references, MCP `gezel:open-tab` dispatches); they aren't
  // produced from the listing anymore.
  const handleProjectRowClick = useCallback(
    (id: string) => {
      void openProject(id);
      if (!detailOnly) {
        try {
          window.localStorage.setItem(SELECTED_PROJECT_STORAGE_KEY, id);
        } catch {
          /* ignore */
        }
      }
    },
    [detailOnly, openProject],
  );

  const toggleSelectedArchive = useCallback(async () => {
    if (!selected || selected.id === 'default' || changingArchive) return;
    setChangingArchive(true);
    try {
      const updated = await api.updateProject(selected.id, { archived: !selected.archived });
      window.dispatchEvent(
        new CustomEvent('gezel:project-updated', {
          detail: { projectId: selected.id, project: updated },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingArchive(false);
    }
  }, [changingArchive, selected]);

  const renderProjectRailRows = (items: Project[], archived: boolean) =>
    items.map((p) => (
      <ProjectContextMenu
        key={p.id}
        project={p}
        onDeleted={() => void refresh()}
        onChanged={() => void refresh()}
      >
        <li className={`project-rail-row${archived ? ' project-rail-row-archived' : ''}`}>
          <button
            type="button"
            className={`project-rail-name${selected?.id === p.id ? ' active' : ''}`}
            onClick={() => handleProjectRowClick(p.id)}
            title={p.name}
          >
            {sidebarCollapsed ? (
              projectInitial(p.name)
            ) : (
              <>
                {p.name}
                {p.storageScope === 'machine-shared' && (
                  <span
                    className="machine-shared-badge"
                    title="Shared with accounts on this machine"
                  >
                    Shared
                  </span>
                )}
              </>
            )}
          </button>
          {!sidebarCollapsed && (
            <ProjectActionsMenu
              project={p}
              onDeleted={() => void refresh()}
              onChanged={() => void refresh()}
            />
          )}
        </li>
      </ProjectContextMenu>
    ));

  // Restore the most recently inline-selected project when the listing
  // mounts (Tab area remounts whenever the user switches away and back).
  // Skip in detail-only mode — `forceProjectId` is the source of truth there.
  useEffect(() => {
    if (detailOnly) return;
    if (selected) return;
    if (projects.length === 0) return;
    let saved: string | null = null;
    try {
      saved = window.localStorage.getItem(SELECTED_PROJECT_STORAGE_KEY);
    } catch {
      saved = null;
    }
    if (saved && projects.some((p) => p.id === saved)) {
      void openProject(saved);
    }
  }, [detailOnly, selected, projects, openProject]);

  return (
    <div
      ref={containerRef}
      className={`two-col${sidebarCollapsed && !detailOnly ? ' sidebar-collapsed' : ''}${detailOnly ? ' detail-only' : ''}${effectiveCompact ? ' is-compact' : ''}`}
    >
      {!detailOnly && (
        <NewProjectDialog
          open={createMode !== null}
          mode={createMode ?? 'crew'}
          onClose={() => setCreateMode(null)}
          onCreated={handleProjectCreated}
        />
      )}
      {!detailOnly && (
        <aside className={`side${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div className="area-toolbar">
            {!sidebarCollapsed && (
              <>
                <button
                  type="button"
                  className="area-toolbar-btn"
                  onClick={() => setCreateMode('crew')}
                >
                  + New Project
                </button>
                <button
                  type="button"
                  className="area-toolbar-btn"
                  onClick={() => setCreateMode('solo')}
                  title="A solo project — one ambachtsman handles everything"
                >
                  + New Job
                </button>
              </>
            )}
            <button
              type="button"
              className="area-toolbar-toggle"
              onClick={() => setSidebarCollapsed((v) => !v)}
              title={sidebarCollapsed ? 'Expand project list' : 'Collapse project list'}
              aria-label={sidebarCollapsed ? 'Expand project list' : 'Collapse project list'}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
          </div>
          {sidebarCollapsed && (
            <div className="new-row collapsed-create-row" aria-label="Create">
              <button
                type="button"
                className="collapsed-create-btn"
                onClick={() => setCreateMode('crew')}
                title="New Project"
                aria-label="New Project"
              >
                <span className="collapsed-create-symbol" aria-hidden="true">
                  +
                </span>
                <span className="collapsed-create-label">Project</span>
              </button>
              <button
                type="button"
                className="collapsed-create-btn"
                onClick={() => setCreateMode('solo')}
                title="New Job (solo project)"
                aria-label="New Job"
              >
                <span className="collapsed-create-symbol" aria-hidden="true">
                  +
                </span>
                <span className="collapsed-create-label">Job</span>
              </button>
            </div>
          )}
          <ul>{renderProjectRailRows(activeProjects, false)}</ul>
          {archivedProjects.length > 0 && (
            <section
              className={`project-archive-section${sidebarCollapsed ? ' is-collapsed' : ''}`}
              aria-labelledby="archived-projects-heading"
            >
              <h3 id="archived-projects-heading">Archived projects</h3>
              <ul>{renderProjectRailRows(archivedProjects, true)}</ul>
            </section>
          )}
          {error && !sidebarCollapsed && <p className="error">{error}</p>}
        </aside>
      )}
      <section className="main">
        {!detailOnly && !selected ? (
          <p className="placeholder">Pick a project on the left to view it here.</p>
        ) : selected ? (
          <>
            <div className="entity-tabs-row project-tabs-row">
              {/* Wide layout: the toggle shows/hides the side-by-side
                  output pane. In compact mode the pane becomes a tab
                  instead (below), so the toggle is suppressed. */}
              {!effectiveCompact && (
                <button
                  type="button"
                  className={`output-toggle${outputVisible ? ' is-active' : ''}`}
                  onClick={toggleOutput}
                  title={outputVisible ? 'Hide output pane' : 'Show output pane'}
                  aria-label={outputVisible ? 'Hide output pane' : 'Show output pane'}
                  aria-pressed={outputVisible}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <rect
                      x="1.5"
                      y="2.5"
                      width="13"
                      height="9"
                      rx="1.2"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                    />
                    <path d="M6.4 5.4 L10 7.5 L6.4 9.6 Z" fill="currentColor" />
                    <line
                      x1="5"
                      y1="13.6"
                      x2="11"
                      y2="13.6"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
              <Tabs.Root value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
                <Tabs.List>
                  {/* Data-driven so the compact form factor can swap each
                      word label for an icon + tooltip without duplicating
                      the trigger markup. 'output' is compact-only (it has
                      its own pane in the wide layout). */}
                  {(
                    [
                      { value: 'output', label: 'Output', show: compactOutputAvailable },
                      { value: 'chat', label: 'Chat', show: true },
                      {
                        value: 'overview',
                        label: 'Overview',
                        show: projectTabIsVisible(selected, 'overview'),
                      },
                      {
                        value: 'tasks',
                        label: 'Tasks',
                        show: projectTabIsVisible(selected, 'tasks'),
                      },
                      {
                        value: 'packages',
                        label: 'Approvals',
                        show: projectTabIsVisible(selected, 'approvals'),
                      },
                      {
                        value: 'workspace',
                        label: 'Workspace',
                        show: projectTabIsVisible(selected, 'workspace'),
                      },
                      {
                        value: 'artifacts',
                        label: 'Artifacts',
                        show: projectTabIsVisible(selected, 'artifacts'),
                      },
                      { value: 'github', label: 'GitHub', show: Boolean(selected.github?.url) },
                      { value: 'mail', label: 'Mail', show: isEmailProject(selected) },
                      {
                        value: 'map',
                        label: 'Village',
                        show: projectTabIsVisible(selected, 'map'),
                      },
                      { value: 'about', label: 'Settings', show: true },
                    ] as Array<{ value: ProjectTab; label: string; show: boolean }>
                  )
                    .filter((t) => t.show)
                    .map((t) =>
                      effectiveCompact ? (
                        <Tabs.Trigger
                          key={t.value}
                          value={t.value}
                          data-testid={`project-tab-${t.value}`}
                          className="gz-tab-icon"
                          aria-label={t.label}
                          title={t.label}
                        >
                          <ProjectTabIcon tab={t.value} />
                        </Tabs.Trigger>
                      ) : (
                        <Tabs.Trigger
                          key={t.value}
                          value={t.value}
                          data-testid={`project-tab-${t.value}`}
                        >
                          {t.label}
                        </Tabs.Trigger>
                      ),
                    )}
                </Tabs.List>
              </Tabs.Root>
              {/* Hide the promote affordance when this view is itself
                  the standalone tab — the project would just re-activate
                  the tab the user is already on. */}
              {!detailOnly && <PromoteToTabButton target={{ kind: 'project', id: selected.id }} />}
              {selected.archived && (
                <span className="project-archived-badge" title="Hidden from primary navigation">
                  Archived
                </span>
              )}
              {selected.id !== 'default' && (
                <button
                  type="button"
                  className="project-archive-header-action"
                  onClick={() => void toggleSelectedArchive()}
                  disabled={changingArchive}
                  title={selected.archived ? 'Restore project' : 'Archive project'}
                  aria-label={selected.archived ? 'Restore project' : 'Archive project'}
                >
                  <svg
                    width="15"
                    height="15"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.35"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M2.5 5.2h11v8.1h-11z" />
                    <path d="M1.8 2.7h12.4v2.5H1.8zM6 8h4" />
                    {selected.archived && <path d="m5.5 11 2.5-2.5 2.5 2.5" />}
                  </svg>
                  <span>{selected.archived ? 'Restore' : 'Archive'}</span>
                </button>
              )}
            </div>

            <div
              ref={projectBodyRef}
              className={`project-body${showOutputBeside ? ' has-output' : ''}${
                effectiveCompact ? ' project-body-compact' : ''
              }`}
              style={
                showOutputBeside
                  ? {
                      ['--project-output-width' as string]: `${(outputFraction * 100).toFixed(2)}%`,
                    }
                  : undefined
              }
            >
              {(showOutputBeside || showOutputAsTab) && (
                <ProjectOutputPane
                  key={selected.id}
                  projectId={selected.id}
                  htmlFiles={workspaceHtmlFiles}
                  typePage={typePage ?? undefined}
                  onClose={showOutputAsTab ? () => setTab('chat') : toggleOutput}
                  onDebugFrame={injectDebugFrame}
                />
              )}
              {showOutputBeside && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label="Resize output pane"
                  tabIndex={0}
                  className="chat-rail-grip project-output-grip"
                  onMouseDown={onOutputGripMouseDown}
                  onKeyDown={onOutputGripKeyDown}
                />
              )}
              {!showOutputAsTab && (
                <div className="project-body-content">
                  {tab === 'about' && (
                    <div className="project-about-page">
                      <ProjectCrewRoster
                        project={selected}
                        gezels={gezels}
                        boekwachterGezelId={boekwachterGezelId}
                        recentlyAddedGezelId={recentlyAddedGezelId}
                        onAddGezel={addProjectGezel}
                        onCreateTemplateGezel={createProjectTemplateGezel}
                        onRemoveGezel={removeProjectGezel}
                      />

                      <ProjectDocEditor
                        key={`${selected.id}:about`}
                        resourceKey={`project:${selected.id}:about`}
                        id="project-about-overview"
                        label="About this project"
                        hint="Flows into the system prompt when a chat is scoped to this project."
                        initial={selected.about ?? ''}
                        onSave={async (value) => {
                          const updated = await api.updateProject(selected.id, {
                            about: value,
                          });
                          setSelected((current) =>
                            current?.id === updated.id ? { ...current, about: value } : current,
                          );
                          return updated;
                        }}
                      />

                      <ProjectDocEditor
                        key={`${selected.id}:mission`}
                        resourceKey={`project:${selected.id}:mission`}
                        id="project-about-mission"
                        label="Mission objectives"
                        hint="A concrete list of what success looks like. Also flows into the system prompt."
                        initial={selected.missionObjectives ?? ''}
                        onSave={async (value) => {
                          const updated = await api.updateProject(selected.id, {
                            missionObjectives: value,
                          });
                          setSelected((current) =>
                            current?.id === updated.id
                              ? { ...current, missionObjectives: value }
                              : current,
                          );
                          return updated;
                        }}
                      />

                      <ProjectMemoriesEditor
                        key={`${selected.id}:memories`}
                        projectId={selected.id}
                        projectName={selected.name}
                      />

                      <section
                        id="project-about-connections"
                        className="project-about-section project-about-anchor"
                      >
                        <ProjectConnectionsTab project={selected} onProjectChange={setSelected} />
                      </section>

                      <section
                        id="project-about-settings"
                        className="project-about-section project-about-anchor"
                      >
                        <h3 className="project-about-section-title">Settings</h3>
                        <div className="project-config">
                          <label className="config-label">
                            Working directory
                            <div className="new-row">
                              <input
                                placeholder="External path (leave blank for internal)"
                                value={workingDirDraft}
                                onChange={(e) => setWorkingDirDraft(e.target.value)}
                                onBlur={() => void saveWorkingDir(workingDirDraft)}
                              />
                              {window.__GEZEL__?.selectDirectory && (
                                <button
                                  type="button"
                                  onClick={async () => {
                                    const picked = await window.__GEZEL__?.selectDirectory?.({
                                      title: 'Choose working directory',
                                      defaultPath: workingDirDraft || undefined,
                                    });
                                    if (picked) {
                                      setWorkingDirDraft(picked);
                                      void saveWorkingDir(picked);
                                    }
                                  }}
                                  title="Browse for folder"
                                >
                                  Browse…
                                </button>
                              )}
                            </div>
                            <small className="muted">
                              {selected.workingDir
                                ? `External: ${selected.workingDir}`
                                : 'Using internal workspace'}
                            </small>
                          </label>

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            Allow gezellen to modify the workspace directory
                            <div className="new-row" style={{ alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={selected.allowGezelWrites ?? !selected.workingDir}
                                onChange={(e) => {
                                  const next = e.target.checked;
                                  // Flipping ON for an external workingDir prompts a
                                  // confirmation — models will be able to modify files
                                  // in that user-supplied path. Internal workspaces
                                  // (our folder) flip silently.
                                  if (next && selected.workingDir) {
                                    setShowAllowWritesConfirm(true);
                                  } else {
                                    void saveAllowGezelWrites(next);
                                  }
                                }}
                              />
                              <span className="muted small">
                                {selected.workingDir
                                  ? 'Off by default for external dirs. Turn on only if you trust gezellen to edit files at this path.'
                                  : 'Internal workspace — on by default. Turn off to make this project read-only for gezellen.'}
                              </span>
                            </div>
                          </label>

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            Index this project's workspace
                            <div className="new-row" style={{ alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={selected.indexingEnabled !== false}
                                onChange={(event) => void saveIndexingEnabled(event.target.checked)}
                              />
                              <span className="muted small">
                                Builds file search, commands, the Village map, and AI summaries.
                                Turn it off for lightweight projects such as games or language
                                practice.
                              </span>
                            </div>
                          </label>

                          <div className="config-label" style={{ marginTop: '0.75rem' }}>
                            Project properties
                            <ProjectPropertiesEditor
                              project={selected}
                              onProjectChange={setSelected}
                            />
                            <small className="muted">
                              Shared values gezellen and recurring craftbooks draw from — set the
                              designated language once and every translation run uses it.
                            </small>
                          </div>

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            GitHub repository
                            <div className="new-row">
                              <input
                                placeholder="https://github.com/owner/repo"
                                value={githubUrlDraft}
                                onChange={(e) => setGitHubUrlDraft(e.target.value)}
                                onBlur={() => void saveGitHubUrl(githubUrlDraft)}
                              />
                            </div>
                            <small className="muted">
                              {selected.github?.url
                                ? selected.github.checkoutDir
                                  ? `Linked. Checkout: ${selected.github.checkoutDir}${selected.github.branch ? ` (${selected.github.branch})` : ''}`
                                  : 'Linked. Use the GitHub tab to clone.'
                                : 'Optional. When set, gezels gain a GitHub-linked checkout and a new GitHub tab.'}
                              {gitStatus && (
                                <>
                                  {' '}
                                  — <span className="status">{gitStatus}</span>
                                </>
                              )}
                            </small>
                          </label>

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            {crewLeadLabel(selected)}
                            <div className="new-row">
                              <GezelPicker
                                gezels={gezels}
                                value={selected.voormanGezelId}
                                noneLabel={`(no ${crewLeadLabelLower(selected)})`}
                                ariaLabel={crewLeadLabel(selected)}
                                onValueChange={async (gezelId) => {
                                  const updated = await api.updateProject(selected.id, {
                                    voormanGezelId: gezelId,
                                  });
                                  setSelected(updated);
                                }}
                              />
                            </div>
                            <small className="muted">
                              {selected.mode === 'solo'
                                ? 'The single gezel who handles this entire job — the ambachtsman. Mentioned in the system prompt for any chat scoped here. Team-management tools are stripped from their thread.'
                                : 'The gezel who acts as voorman (foreman) of this project. Mentioned in the system prompt for any chat scoped here.'}
                            </small>
                          </label>

                          <div className="config-label" style={{ marginTop: '0.75rem' }}>
                            <label className="new-row" style={{ alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={selected.nudgeConfig?.enabled === false}
                                onChange={(e) =>
                                  void saveMeesterProgressCheckExemption(e.target.checked)
                                }
                              />
                              <span>Exclude from Meester progress check-ins</span>
                            </label>
                            <small className="muted">
                              For long-running or ambient projects. The Meester won’t ask the
                              project lead for overall progress; direct chats and the project’s own
                              work continue.
                            </small>
                          </div>

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            Project type
                            <div className="new-row">
                              <Select.Root
                                value={selected.projectTypeId || '__AUTO__'}
                                onValueChange={async (v) => {
                                  const updated = await api.updateProject(selected.id, {
                                    projectTypeId: v === '__AUTO__' ? null : v,
                                  });
                                  setSelected(updated);
                                }}
                              >
                                <Select.Trigger>
                                  <Select.Value />
                                </Select.Trigger>
                                <Select.Content>
                                  <Select.Item value="__AUTO__">
                                    {(() => {
                                      const detected = getProjectType(
                                        selected.detectedProjectType?.id,
                                      );
                                      return detected
                                        ? `Auto-detect (${detected.label})`
                                        : 'Auto-detect';
                                    })()}
                                  </Select.Item>
                                  {listProjectTypes().map((t) => (
                                    <Select.Item key={t.id} value={t.id}>
                                      {t.label}
                                    </Select.Item>
                                  ))}
                                </Select.Content>
                              </Select.Root>
                            </div>
                            <small className="muted">
                              Tunes which craftbooks the command rail suggests for this project.
                              Auto-detect classifies the project from its files and About text.
                            </small>
                          </label>

                          <fieldset className="project-tab-settings">
                            <legend>Project tabs</legend>
                            <p className="muted small">
                              Keep this project focused by hiding work areas it does not use.
                            </p>
                            <div className="project-tab-settings-grid">
                              {PROJECT_TAB_VISIBILITY_OPTIONS.map((option) => (
                                <label key={option.key} className="new-row">
                                  <input
                                    type="checkbox"
                                    checked={projectTabIsVisible(selected, option.key)}
                                    onChange={(event) =>
                                      void saveTabVisibility(option.key, event.target.checked)
                                    }
                                  />
                                  <span>{option.label}</span>
                                </label>
                              ))}
                            </div>
                            <small className="muted">
                              Chat and Settings always stay available. Output appears whenever the
                              project has a previewable page.
                            </small>
                          </fieldset>

                          {configuredCredentials.length > 0 && (
                            <div className="project-credentials">
                              <h4>Granted credentials</h4>
                              <p className="muted small">
                                Credentials are stored once for your whole workspace and shared
                                across projects you grant them to. Scripts and MCP tools running in
                                this project can resolve only the names checked below. They never
                                see the raw values.
                              </p>
                              <ul className="credentials-list">
                                {configuredCredentials.map((c) => {
                                  const granted = (selected.grantedCredentials ?? []).includes(
                                    c.name,
                                  );
                                  const destinationHint = credentialDestinationHint(c);
                                  return (
                                    <li key={c.name}>
                                      <label className="new-row" style={{ alignItems: 'center' }}>
                                        <input
                                          type="checkbox"
                                          checked={granted}
                                          disabled={
                                            !granted && (!c.stored || c.allowedOrigins.length === 0)
                                          }
                                          onChange={(e) =>
                                            void toggleGrant(c.name, e.target.checked)
                                          }
                                        />
                                        <span>
                                          <code>{c.name}</code>
                                          <span className="muted small"> — {c.label}</span>
                                          {destinationHint && (
                                            <span className="muted small">
                                              {' '}
                                              — {destinationHint}
                                            </span>
                                          )}
                                        </span>
                                      </label>
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          )}

                          <div className="project-writes-log">
                            <h4>Recent workspace changes</h4>
                            {writesJournal.length === 0 ? (
                              <p className="muted small">
                                No workspace mutations recorded yet. Gezels that call{' '}
                                <code>write_file</code>, <code>delete_path</code>,{' '}
                                <code>make_dir</code>, or <code>rename</code> will show up here.
                              </p>
                            ) : (
                              <ul>
                                {writesJournal.map((entry, i) => (
                                  <li key={`${entry.at}:${i}`}>
                                    <span className={`writes-op writes-op-${entry.op}`}>
                                      {entry.op}
                                    </span>
                                    <code>
                                      {entry.op === 'rename'
                                        ? `${entry.fromPath} → ${entry.path}`
                                        : entry.path}
                                    </code>
                                    {entry.bytes !== undefined && (
                                      <span className="muted small">
                                        {' '}
                                        · {formatBytes(entry.bytes)}
                                      </span>
                                    )}
                                    {entry.gezelId && (
                                      <span className="muted small"> · by {entry.gezelId}</span>
                                    )}
                                    <span className="muted small">
                                      {' '}
                                      · {formatRelativeTime(entry.at)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        </div>
                      </section>

                      <section
                        id="project-about-toolsets"
                        className="project-about-section project-about-anchor"
                      >
                        <h3 className="project-about-section-title">Toolsets</h3>
                        <ToolsetsEditor
                          scope={{ kind: 'project', projectId: selected.id }}
                          subject={selected.name}
                          hint="Available to every gezel working in this project. Project MCP files are discovered automatically."
                        />
                      </section>

                      <section
                        id="project-about-history"
                        className="project-about-section project-about-anchor"
                      >
                        <h3 className="project-about-section-title">History</h3>
                        <div className="project-about-history">
                          <HistoryView projectId={selected.id} />
                        </div>
                      </section>

                      <nav className="project-about-toc" aria-label="About sections">
                        <div className="project-about-toc-title">On this page</div>
                        <a href="#project-about-crew">Assigned gezellen</a>
                        <a href="#project-about-overview">About this project</a>
                        <a href="#project-about-mission">Mission objectives</a>
                        <a href="#project-about-memories">Project memories</a>
                        <a href="#project-about-connections">Connections</a>
                        <a href="#project-about-settings">Settings</a>
                        <a href="#project-about-toolsets">Toolsets</a>
                        <a href="#project-about-history">History</a>
                      </nav>
                    </div>
                  )}

                  <ConfirmDialog
                    open={showAllowWritesConfirm}
                    title="Enable workspace writes?"
                    message={
                      selected.workingDir ? (
                        <>
                          Gezels will be able to create, modify, and delete files inside{' '}
                          <code>{selected.workingDir}</code>. Every change is logged in the Settings
                          section. You can turn this back off at any time.
                        </>
                      ) : null
                    }
                    confirmLabel="Enable"
                    danger
                    onConfirm={async () => {
                      await saveAllowGezelWrites(true);
                      setShowAllowWritesConfirm(false);
                    }}
                    onCancel={() => setShowAllowWritesConfirm(false)}
                  />

                  {tab === 'packages' && (
                    <div className="project-config">
                      <p className="muted small" style={{ marginTop: 0 }}>
                        Each gezel asks the runtime before installing a package or running a script.
                        Decisions persist per project — once approved, future calls run
                        automatically.
                      </p>

                      <h4 className="project-section-heading">Approved npm packages</h4>
                      <ul>
                        {approvals?.npmApproved.map((p) => (
                          <li key={`${p.package}@${p.version}`}>
                            <strong>{p.package}</strong> <code>{p.version}</code>{' '}
                            <span className="muted small">
                              (
                              {p.approvedBy === 'shipped' ? 'shipped allowlist' : 'approved by you'}
                              )
                            </span>
                          </li>
                        ))}
                        {(!approvals || approvals.npmApproved.length === 0) && (
                          <li className="muted">No project-specific npm approvals yet.</li>
                        )}
                      </ul>

                      {approvals && approvals.npmDeclined.length > 0 && (
                        <>
                          <h4 className="project-section-heading">Declined npm packages</h4>
                          <ul>
                            {approvals.npmDeclined.map((p) => (
                              <li key={`${p.package}@${p.version}`}>
                                <strong>{p.package}</strong> <code>{p.version}</code>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      <h4 className="project-section-heading">
                        Approved scripts (run via package.json)
                      </h4>
                      <ul>
                        {approvals &&
                          Object.entries(approvals.scriptApprovals).map(([name, decision]) => (
                            <li key={`script-${name}`}>
                              <strong>{name}</strong>{' '}
                              <span
                                className={`muted small${decision === 'declined' ? ' error' : ''}`}
                              >
                                ({decision})
                              </span>
                            </li>
                          ))}
                        {(!approvals || Object.keys(approvals.scriptApprovals).length === 0) && (
                          <li className="muted">No script approvals on file yet.</li>
                        )}
                      </ul>

                      {approvals && Object.keys(approvals.npxApprovals).length > 0 && (
                        <>
                          <h4 className="project-section-heading">Approved npx binaries</h4>
                          <ul>
                            {Object.entries(approvals.npxApprovals).map(([name, decision]) => (
                              <li key={`npx-${name}`}>
                                <strong>{name}</strong>{' '}
                                <span
                                  className={`muted small${decision === 'declined' ? ' error' : ''}`}
                                >
                                  ({decision})
                                </span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}

                      <h4 className="project-section-heading">Install a package</h4>
                      <div className="new-row">
                        <input
                          placeholder="npm package name"
                          value={pkgName}
                          onChange={(e) => setPkgName(e.target.value)}
                        />
                        <button type="button" onClick={install}>
                          Install
                        </button>
                      </div>
                      <ul>
                        {selected.packages.map((p) => (
                          <li key={p.name}>
                            {p.name} <code>{p.version}</code>
                          </li>
                        ))}
                        {selected.packages.length === 0 && (
                          <li className="muted">
                            No packages installed in this project's workspace.
                          </li>
                        )}
                      </ul>

                      <h4 className="project-section-heading">
                        Available scripts (from <code>package.json</code>)
                      </h4>
                      <p className="muted small" style={{ marginTop: '-0.25rem' }}>
                        Listed scripts are eligible for first-use approval when a gezel calls{' '}
                        <code>run_package_script</code>.
                      </p>
                      <ul>
                        {Object.entries(packageScripts).map(([name, body]) => (
                          <li key={name}>
                            <strong>{name}</strong>
                            {': '}
                            <code>{body}</code>
                          </li>
                        ))}
                        {Object.keys(packageScripts).length === 0 && (
                          <li className="muted">no scripts defined in package.json</li>
                        )}
                      </ul>
                      {log && <pre className="log">{log}</pre>}
                    </div>
                  )}

                  {fileTab !== null && (
                    <div className="project-files-layout">
                      <div className="file-tree-panel">
                        <div className="file-tree-header">
                          <span className="file-tree-title">
                            {fileTab === 'workspace' ? 'Workspace' : 'Artifacts'}
                          </span>
                          <button
                            type="button"
                            className="tree-reveal-btn"
                            onClick={() => void reveal(fileTab)}
                            title="Open in file manager"
                          >
                            Open
                          </button>
                        </div>
                        {fileTab === 'artifacts' && (
                          <div style={{ padding: '0.35rem 0.5rem' }}>
                            <div className="new-row">
                              <input
                                placeholder="new-file.md"
                                value={newFileName}
                                onChange={(e) => setNewFileName(e.target.value)}
                                style={{ fontSize: '0.8rem' }}
                              />
                              <button
                                type="button"
                                onClick={createArtifact}
                                disabled={!newFileName.trim()}
                                style={{ fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                              >
                                +
                              </button>
                            </div>
                          </div>
                        )}
                        <div className="file-tree">
                          {activeEntries.length === 0 && (
                            <p className="muted" style={{ padding: '0.5rem', fontSize: '0.85rem' }}>
                              {fileTab === 'workspace'
                                ? selected.workingDir
                                  ? 'Workspace directory is empty.'
                                  : 'No external working directory set. Use the internal workspace or set an external path under the Settings tab.'
                                : 'No artifacts yet. Your gezellen will store reports and outputs here.'}
                            </p>
                          )}
                          <FileTree
                            entries={activeEntries}
                            selectedPath={openFile?.path}
                            onSelect={(e) => void openFileEntry(e, fileTab)}
                            onDelete={fileTab === 'artifacts' ? deleteArtifact : undefined}
                          />
                          {(fileTab === 'workspace' ? workspaceTruncated : artifactsTruncated) && (
                            <p className="muted" style={{ padding: '0.5rem', fontSize: '0.8rem' }}>
                              This folder has more files than can be shown — the listing is
                              incomplete. Use "Open" above to browse everything in your file
                              manager.
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="file-viewer-panel">
                        {openFile ? (
                          openFile.content === MEDIA_IMAGE ? (
                            <div className="image-preview">
                              <AuthedImagePreview
                                projectId={selected.id}
                                path={openFile.path}
                                source={openFile.source}
                              />
                              <p className="muted" style={{ textAlign: 'center' }}>
                                {openFile.path}
                              </p>
                            </div>
                          ) : openFile.content === MEDIA_VIDEO ? (
                            <div className="image-preview">
                              <AuthedMediaPreview
                                kind="video"
                                projectId={selected.id}
                                path={openFile.path}
                                source={openFile.source}
                              />
                              <p className="muted" style={{ textAlign: 'center' }}>
                                {openFile.path}
                              </p>
                            </div>
                          ) : openFile.content === MEDIA_AUDIO ? (
                            <div className="image-preview">
                              <AuthedMediaPreview
                                kind="audio"
                                projectId={selected.id}
                                path={openFile.path}
                                source={openFile.source}
                              />
                              <p className="muted" style={{ textAlign: 'center' }}>
                                {openFile.path}
                              </p>
                            </div>
                          ) : openFile.content === BINARY_FILE ? (
                            <div className="image-preview">
                              <p className="muted" style={{ textAlign: 'center' }}>
                                Binary file — no text preview available.
                              </p>
                              <p className="muted" style={{ textAlign: 'center' }}>
                                {openFile.path}
                              </p>
                            </div>
                          ) : isHtml(openFile.path) ? (
                            <HtmlFileViewer
                              projectId={selected.id}
                              file={openFile}
                              isReadOnly={isReadOnly}
                              editorTheme={editorTheme}
                              onEditorChange={handleEditorContentChange}
                              onSave={saveArtifact}
                              onComplainAboutPreviewError={complainAboutPreviewError}
                            />
                          ) : isMarkdown(openFile.path) && openFile.source === 'artifacts' ? (
                            <ProjectMarkdownArtifactEditor
                              key={`${openFile.source}:${openFile.path}`}
                              projectId={selected.id}
                              path={openFile.path}
                              content={openFile.content}
                              isReadOnly={isReadOnly}
                              editorTheme={editorTheme}
                              onChange={handleEditorContentChange}
                              onSave={saveArtifact}
                            />
                          ) : (
                            <div className="editor-wrap" style={{ height: '100%' }}>
                              <EditorShell
                                key={`${openFile.source}:${openFile.path}`}
                                initialMarkdown={openFile.content}
                                fileName={openFile.path}
                                onChange={isReadOnly ? undefined : handleEditorContentChange}
                                height="100%"
                                colorScheme={editorTheme}
                                showPlayTab={false}
                                fullWidth
                                toolbarSlotRight={
                                  !isReadOnly ? (
                                    <button
                                      type="button"
                                      onClick={saveArtifact}
                                      style={{ marginLeft: '0.5rem' }}
                                    >
                                      Save
                                    </button>
                                  ) : undefined
                                }
                              />
                            </div>
                          )
                        ) : (
                          <p className="placeholder" style={{ padding: '2rem' }}>
                            Select a file from the tree to view{' '}
                            {fileTab === 'artifacts' ? 'or edit ' : ''}it.
                          </p>
                        )}
                      </div>
                    </div>
                  )}

                  {tab === 'chat' && (
                    <ProjectChat key={selected.id} project={selected} compact={effectiveCompact} />
                  )}

                  {tab === 'tasks' && <TasksView projectId={selected.id} />}

                  {tab === 'github' && selected.github?.url && (
                    <ProjectGitHubView project={selected} onProjectChange={setSelected} />
                  )}

                  {tab === 'mail' && (
                    <ProjectMailTab project={selected} onProjectChange={setSelected} />
                  )}

                  {tab === 'map' && <FileMapView projectId={selected.id} />}
                  {tab === 'overview' && (
                    <ProjectOverviewView projectId={selected.id} project={selected} />
                  )}
                </div>
              )}
            </div>

            {/* Ambient project state (index, branch, status, edits) reads as a
                status bar along the bottom edge rather than a row of chrome
                above the tabs — same controls, out of the way of the content
                they describe. Its menus open upward from here. */}
            <ProjectGitStatusBar
              projectId={selected.id}
              compact={effectiveCompact}
              allowGezelWrites={selected.allowGezelWrites}
              workingDir={selected.workingDir ?? null}
              onAllowWritesChange={(next) => {
                // Enabling writes on a user-supplied external dir prompts the
                // same confirmation the Settings checkbox uses; everything
                // else flips directly.
                if (next && selected.workingDir) {
                  setShowAllowWritesConfirm(true);
                } else {
                  void saveAllowGezelWrites(next);
                }
              }}
              editableViaAiProvider={aiAccess.editableViaAiProvider}
              codexMode={aiAccess.codexInUse ? effectiveCodexMode : undefined}
              onCodexModeChange={aiAccess.codexInUse ? saveCodexPermissionMode : undefined}
              onOpenGitHub={selected.github?.url ? () => setTab('github') : undefined}
              status={selected.status ?? 'active'}
              statusLocked={selected.archived === true}
              onStatusChange={async (v) => {
                const updated = await api.updateProject(selected.id, { status: v });
                setSelected(updated);
              }}
            />
          </>
        ) : (
          <p className="placeholder project-loading">Loading project…</p>
        )}
      </section>
    </div>
  );
}

/**
 * File viewer for `.html` files in the workspace or artifacts tree.
 * Two tabs — Preview renders the page through the service's sandboxed
 * capability-protected static preview route for artifacts or workspace,
 * so relative `<link>` / `<script>` / `<img>` references
 * resolve against sibling files; Source drops back to the normal
 * EditorShell for viewing / editing the raw markup. A Refresh button
 * in the Preview tab bumps the iframe key so the reload picks up any
 * sibling-file edits the user or a gezel has made since.
 */

/**
 * Markdown-artifact editor with the full squisq feature set — Play
 * tab, the Files panel for image uploads (writes land in the parent
 * directory next to the markdown), the DocBlocks-style Export menu,
 * version history, and a sibling-artifact link picker. The
 * editor talks to `projects/{id}/artifacts/<dir>/` through a
 * `ContentContainer` adapter so image references in the doc resolve
 * relative to the doc's directory.
 *
 * Workspace files (code) and non-markdown artifacts keep the plain
 * EditorShell — the squisq concepts (themes, playback, exporting to
 * PowerPoint) only make sense for prose / markdown.
 */
function ProjectMarkdownArtifactEditor({
  projectId,
  path,
  content,
  isReadOnly,
  editorTheme,
  onChange,
  onSave,
}: {
  projectId: string;
  path: string;
  content: string;
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onChange: (source: string) => void;
  onSave: () => void | Promise<void>;
}) {
  const root = useMemo(() => parentDir(path), [path]);
  const primaryDocumentFilename = useMemo(() => basenameOf(path), [path]);
  const container = useMemo(
    () =>
      createArtifactsContentContainer({
        projectId,
        root,
        client: api,
        primaryDocumentFilename,
      }),
    [projectId, root, primaryDocumentFilename],
  );
  const documentLinkProvider = useMemo(
    () =>
      createDocumentLinkProvider({
        client: api,
        currentDocumentPath: path,
        source: 'project-artifacts',
        projectId,
      }),
    [projectId, path],
  );
  // Reports may embed gezel-action recommendation blocks — register the
  // fence renderer so they mount as live, fireable cards INSIDE the
  // editor (instead of Monaco code insets).
  const fenceRenderers = useMemo(
    () => makeReportActionFenceRenderers({ projectId, reportPath: path }),
    [projectId, path],
  );
  return (
    <div className="editor-wrap" style={{ height: '100%' }}>
      <EditorShell
        initialMarkdown={content}
        fileName={path}
        onChange={isReadOnly ? undefined : onChange}
        height="100%"
        colorScheme={editorTheme}
        fullWidth
        workspaceContainer={container}
        documentLinkProvider={documentLinkProvider}
        fenceRenderers={fenceRenderers}
        allowVersioning={!isReadOnly}
        versionBasename={primaryDocumentFilename}
        outline
        toolbarSlotAfterActions={
          !isReadOnly ? <TransformToolbarButton context="generic" /> : undefined
        }
        toolbarSlotRight={
          <>
            {!isReadOnly && (
              <button type="button" onClick={() => void onSave()} style={{ marginLeft: '0.5rem' }}>
                Save
              </button>
            )}
            <ExportToolbarControls
              selectedFile={path}
              mediaContainer={container}
              mediaSource={{ kind: 'project-artifacts', projectId }}
            />
          </>
        }
      />
    </div>
  );
}

/**
 * Image preview that fetches through the authenticated client + renders
 * via a blob URL. `<img src="/api/...?raw=1">` would 401 because the
 * `<img>` element can't send a bearer token; this mirrors the pattern
 * `fetchSessionImage` / `fetchProjectAttachment` use on the chat side.
 */
function AuthedImagePreview({
  projectId,
  path,
  source,
}: {
  projectId: string;
  path: string;
  source: FileTab;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    void (async () => {
      try {
        const blob =
          source === 'workspace'
            ? await api.fetchProjectWorkspaceBlob(projectId, path)
            : await api.fetchProjectArtifactBlob(projectId, path);
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setBlobUrl(currentUrl);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [projectId, path, source]);
  if (error) return <p className="muted small">Preview failed: {error}</p>;
  if (!blobUrl) return <p className="muted small">Loading…</p>;
  return <img src={blobUrl} alt={path} />;
}

/**
 * Authenticated `<video>`/`<audio>` preview. Same auth fence as
 * AuthedImagePreview — `<video src="/api/...">` would 401 because the element
 * can't carry a bearer token, so we fetch the blob and play it from an object
 * URL.
 */
function AuthedMediaPreview({
  kind,
  projectId,
  path,
  source,
}: {
  kind: 'video' | 'audio';
  projectId: string;
  path: string;
  source: FileTab;
}) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    void (async () => {
      try {
        const blob =
          source === 'workspace'
            ? await api.fetchProjectWorkspaceBlob(projectId, path)
            : await api.fetchProjectArtifactBlob(projectId, path);
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setBlobUrl(currentUrl);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [projectId, path, source]);
  if (error) return <p className="muted small">Preview failed: {error}</p>;
  if (!blobUrl) return <p className="muted small">Loading…</p>;
  if (kind === 'audio') {
    // biome-ignore lint/a11y/useMediaCaption: user-generated audio artifact; no caption track exists.
    return <audio src={blobUrl} controls style={{ width: '100%' }} />;
  }
  // biome-ignore lint/a11y/useMediaCaption: user-generated video artifact; no caption track exists.
  return <video src={blobUrl} controls style={{ maxWidth: '100%', maxHeight: '100%' }} />;
}

function HtmlFileViewer({
  projectId,
  file,
  isReadOnly,
  editorTheme,
  onEditorChange,
  onSave,
  onComplainAboutPreviewError,
}: {
  projectId: string;
  file: { path: string; content: string; source: FileTab };
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onEditorChange: (source: string) => void;
  onSave: () => void | Promise<void>;
  /**
   * Optional "Complain about this" handler — rendered per-entry on
   * the preview-error panel. The parent seeds a project-chat
   * message with the given entry + the file path the user was
   * previewing, and navigates to the chat tab.
   */
  onComplainAboutPreviewError?: (
    entry: HtmlPreviewLogEntry,
    file: { path: string; source: FileTab },
  ) => void | Promise<void>;
}) {
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  const [refreshKey, setRefreshKey] = useState(0);
  const [logs, setLogs] = useState<HtmlPreviewLogEntry[]>([]);
  const [logsCollapsed, setLogsCollapsed] = useState(false);
  const [complainBusyAt, setComplainBusyAt] = useState<number | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const complain = useCallback(
    async (entry: HtmlPreviewLogEntry) => {
      if (!onComplainAboutPreviewError) return;
      setComplainBusyAt(entry.at);
      try {
        await onComplainAboutPreviewError(entry, { path: file.path, source: file.source });
      } finally {
        setComplainBusyAt(undefined);
      }
    },
    [onComplainAboutPreviewError, file.path, file.source],
  );
  const appendLog = useCallback((entry: HtmlPreviewLogEntry) => {
    // Cap at 50 entries so a pathological loop doesn't balloon memory.
    // Newest-first keeps the likely-useful entries visible without scrolling.
    setLogs((prev) => [entry, ...prev].slice(0, 50));
    setLogsCollapsed(false);
  }, []);
  const refreshPreview = useCallback(() => {
    setRefreshKey((k) => k + 1);
    setLogs([]);
  }, []);
  const openInBrowser = useCallback(() => {
    if (!previewUrl) return;
    // Electron's `setWindowOpenHandler` in packages/app intercepts
    // `window.open` and routes the URL to `shell.openExternal`, so this
    // opens the user's default system browser instead of a new
    // Electron window.
    window.open(previewUrl, '_blank', 'noopener,noreferrer');
  }, [previewUrl]);
  return (
    <div className="html-file-viewer">
      <Tabs.Root value={mode} onValueChange={(v) => setMode(v as 'preview' | 'source')}>
        <div className="html-file-viewer-bar">
          <Tabs.List>
            <Tabs.Trigger value="preview">Preview</Tabs.Trigger>
            <Tabs.Trigger value="source">Source</Tabs.Trigger>
          </Tabs.List>
          {mode === 'preview' && (
            <>
              <button
                type="button"
                onClick={refreshPreview}
                className="html-file-viewer-refresh"
                title="Reload the preview"
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={openInBrowser}
                disabled={!previewUrl}
                className="html-file-viewer-refresh"
                title="Open this page in your default system browser"
              >
                Open in browser
              </button>
            </>
          )}
        </div>
      </Tabs.Root>
      {mode === 'preview' ? (
        <>
          <HtmlPreviewFrame
            projectId={projectId}
            path={file.path}
            source={file.source}
            title={file.path}
            className="html-file-viewer-iframe"
            refreshKey={refreshKey}
            onLog={appendLog}
            onUrlReady={setPreviewUrl}
          />
          {logs.length > 0 && (
            <HtmlPreviewLogPanel
              logs={logs}
              collapsed={logsCollapsed}
              onToggleCollapsed={() => setLogsCollapsed((c) => !c)}
              onClear={() => setLogs([])}
              {...(onComplainAboutPreviewError ? { onComplain: complain } : {})}
              {...(complainBusyAt !== undefined ? { complainBusyAt } : {})}
            />
          )}
        </>
      ) : (
        <div className="editor-wrap">
          <EditorShell
            key={`${file.source}:${file.path}`}
            initialMarkdown={file.content}
            fileName={file.path}
            onChange={isReadOnly ? undefined : onEditorChange}
            height="100%"
            colorScheme={editorTheme}
            showPlayTab={false}
            fullWidth
            toolbarSlotRight={
              !isReadOnly ? (
                <button
                  type="button"
                  onClick={() => void onSave()}
                  style={{ marginLeft: '0.5rem' }}
                >
                  Save
                </button>
              ) : undefined
            }
          />
        </div>
      )}
    </div>
  );
}

/**
 * Error / log panel shown under the iframe when a preview page emits
 * a runtime error, an unhandled rejection, or `console.error` via the
 * injected preview shim. Collapsible so a single noisy line doesn't
 * shove the iframe offscreen, clearable so the user can reset the
 * state when they've understood the failure. Newest first so the most
 * recent event sits at the top.
 */
function HtmlPreviewLogPanel({
  logs,
  collapsed,
  onToggleCollapsed,
  onClear,
  onComplain,
  complainBusyAt,
}: {
  logs: HtmlPreviewLogEntry[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onClear: () => void;
  /**
   * When set, a per-entry "Complain about this" button appears and
   * passes the entry back to the parent. The parent is expected to
   * seed a project-chat message with the error details + navigate
   * the user to the chat tab.
   */
  onComplain?: (entry: HtmlPreviewLogEntry) => void | Promise<void>;
  /** `entry.at` of the entry whose complain button is currently in-flight, if any. */
  complainBusyAt?: number;
}) {
  return (
    <div className="html-preview-log">
      <div className="html-preview-log-bar">
        <strong>
          {logs.length} preview error{logs.length === 1 ? '' : 's'}
        </strong>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="html-preview-log-toggle"
          title={collapsed ? 'Show errors' : 'Hide errors'}
        >
          {collapsed ? 'Show' : 'Hide'}
        </button>
        <button
          type="button"
          onClick={onClear}
          className="html-preview-log-toggle"
          title="Clear error log"
        >
          Clear
        </button>
      </div>
      {!collapsed && (
        <ul className="html-preview-log-entries">
          {logs.map((entry, i) => (
            <li key={`${entry.at}-${i}`} className={`html-preview-log-${entry.kind}`}>
              <span className="html-preview-log-kind">{entry.kind}</span>
              <span className="html-preview-log-message">{formatPreviewLog(entry)}</span>
              {(entry.detail.filename || entry.detail.lineno) && (
                <span className="html-preview-log-loc muted small">
                  {entry.detail.filename ? entry.detail.filename.split('/').pop() : ''}
                  {entry.detail.lineno ? `:${entry.detail.lineno}` : ''}
                  {entry.detail.colno ? `:${entry.detail.colno}` : ''}
                </span>
              )}
              {entry.detail.stack && (
                <pre className="html-preview-log-stack">{entry.detail.stack}</pre>
              )}
              {onComplain && (
                <button
                  type="button"
                  className="html-preview-log-complain"
                  disabled={complainBusyAt === entry.at}
                  onClick={() => void onComplain(entry)}
                  title="Send this error to the project chat as a new message"
                >
                  {complainBusyAt === entry.at ? 'Sending…' : 'Complain about this'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatPreviewLog(entry: HtmlPreviewLogEntry): string {
  if (entry.kind === 'console.error') {
    return (entry.detail.args ?? []).join(' ');
  }
  return entry.detail.message ?? '(unknown error)';
}

/**
 * Build a chat message seeded from a preview-pane JavaScript error.
 * Includes the file the user was previewing, the kind of event
 * (runtime error / rejection / console.error), the message, the
 * filename+line+col if reported, and the stack trace when available.
 * The format is prose so the gezel reads it as a user report rather
 * than a structured log.
 */
function formatPreviewComplaint(
  entry: HtmlPreviewLogEntry,
  file: { path: string; source: FileTab },
): string {
  const lines: string[] = [];
  lines.push(
    `I was previewing \`${file.source}/${file.path}\` and the browser surfaced a JavaScript error.`,
  );
  lines.push('');
  lines.push(`- **Kind:** ${entry.kind}`);
  const message = formatPreviewLog(entry);
  if (message) lines.push(`- **Message:** ${message}`);
  if (entry.detail.filename) {
    const loc = entry.detail.filename;
    const withPos = [
      loc,
      entry.detail.lineno ? String(entry.detail.lineno) : null,
      entry.detail.colno ? String(entry.detail.colno) : null,
    ]
      .filter(Boolean)
      .join(':');
    lines.push(`- **Location:** ${withPos}`);
  }
  if (entry.url) lines.push(`- **Preview URL:** ${entry.url}`);
  if (entry.detail.stack) {
    lines.push('');
    lines.push('Stack trace:');
    lines.push('```');
    lines.push(entry.detail.stack);
    lines.push('```');
  }
  lines.push('');
  lines.push(
    "Can you take a look and figure out what's going wrong? Feel free to edit the file directly.",
  );
  return lines.join('\n');
}

/**
 * Per-project markdown editor for `about` / `missionObjectives`. Uses Squisq
 * for consistency with the rest of the markdown editing surface, with the
 * same debounced auto-save pattern as the gezel about.md flow.
 */
function ProjectDocEditor({
  resourceKey,
  id,
  label,
  hint,
  initial,
  onSave,
}: {
  resourceKey: string;
  id: string;
  label: string;
  hint: string;
  initial: string;
  onSave: (value: string) => Promise<unknown>;
}) {
  const editorTheme = useEffectiveTheme();
  // Baseline on the editor-canonical form: Squisq re-emits its own
  // serialization of unchanged content at mount, and a raw-text baseline
  // reads that as an edit (false "unsaved changes" + a spurious write on
  // open). See markdown-baseline.ts.
  const normalizedInitial = useMemo(() => normalizeMarkdownBaseline(initial), [initial]);
  const autosave = useSerializedAutosave({
    resourceKey,
    initialValue: normalizedInitial,
    save: onSave,
  });

  const handleDocChange = useCallback(
    (source: string) => {
      autosave.update(source);
    },
    [autosave.update],
  );

  return (
    <section id={id} className="project-doc-editor project-about-anchor">
      <h3 className="project-doc-editor-title">{label}</h3>
      <p className="muted small" style={{ marginTop: 0, marginBottom: '0.4rem' }}>
        {hint}
      </p>
      <div className="editor-wrap">
        <EditorShell
          initialMarkdown={autosave.desiredValue()}
          onChange={handleDocChange}
          height="240px"
          colorScheme={editorTheme}
          showPlayTab={false}
          fullWidth
          toolbarSlotAfterActions={<TransformToolbarButton context="generic" />}
          statusBarSlotRight={<AutosaveStatus autosave={autosave} />}
        />
      </div>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const deltaSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86_400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86_400)}d ago`;
}
