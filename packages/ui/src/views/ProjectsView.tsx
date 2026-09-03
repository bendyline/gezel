import { EditorShell, useEditorContext } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import type {
  BoekwachterIssue,
  BoekwachterIssueDismissalReason,
  BoekwachterIssueStatus,
  ClaudePermissionMode,
  CodexPermissionMode,
  FileReviewResponse,
  GezelSummary,
  ListFileIssuesResponse,
  Project,
  ProjectApprovalsResponse,
  ProjectDetail,
  ProjectTabVisibility,
  WorkspaceIndexFile,
  WorkspaceIndexStatus,
} from '@bendyline/gezel';
import {
  MANAGED_WORKSPACE_WRITE_SETTING_LABEL,
  getProjectType,
  isSharedLibraryProject,
  listProjectTypes,
  normalizeCodexPermissionMode,
  projectManagedWorkspaceWritable,
  resolveProjectTypeId,
} from '@bendyline/gezel';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { AutosaveStatus } from '../components/AutosaveStatus.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ExportToolbarControls } from '../components/DocumentExport/index.js';
import { DocumentNarration } from '../components/DocumentNarration.js';
import { FileFlatList } from '../components/FileFlatList.js';
import { type FileEntry, FileTree } from '../components/FileTree.js';
import { FileHiddenKey, FileViewModeKeys } from '../components/FileViewModeKeys.js';
import { FindSimilarImages } from '../components/FindSimilarImages.js';
import { GezelPicker } from '../components/GezelPicker.js';
import { HtmlPreviewFrame, type HtmlPreviewLogEntry } from '../components/HtmlPreviewFrame.js';
import { ProjectMemoriesEditor } from '../components/MemoriesTree.js';
import { ProjectActionsMenu, ProjectContextMenu } from '../components/ProjectActionsMenu.js';
import type { ProjectTemplateGezelOptions } from '../components/ProjectAddGezelDialog.js';
import { ProjectCrewRoster } from '../components/ProjectCrewRoster.js';
import { ProjectGitStatusBar } from '../components/ProjectGitStatusBar.js';
import { ProjectIcon } from '../components/ProjectIcon.js';
import { ProjectKnowledgeRow } from '../components/ProjectKnowledgeRow.js';
import { ProjectOutputPane } from '../components/ProjectOutputPane.js';
import { ProjectPanePlaceholder } from '../components/ProjectPanePlaceholder.js';
import { ProjectPropertiesEditor } from '../components/ProjectPropertiesEditor.js';
import { ironCalcEngineFactory } from '../components/SquisqIntegration/calculation.js';
import {
  type OutsideInLayout,
  chooseOutsideInSource,
  createArtifactsContentContainer,
  createDocumentLinkProvider,
  createDocumentMediaProvider,
  createProjectContentContainer,
  createVersionCompatibleContentContainer,
  deriveContainerScope,
  documentVersionBasename,
  importOutsideInDocument,
  isOutsideInInternalPath,
  isOutsideInMarkdownEditingEnabled,
  relativePath,
  renderOutsideInDocument,
  resolveOutsideInLayout,
  runtimePathForTarget,
  withOutsideInMarkdownEditing,
  withOutsideInMetadata,
} from '../components/SquisqIntegration/index.js';
import { ToolsetsEditor } from '../components/ToolsetsEditor.js';
import {
  WorkspaceIndexPane,
  WorkspaceIndexToggle,
  indexTone,
  workspaceIndexLabel,
} from '../components/WorkspaceIndexPane.js';
import { WorkspaceIssueFixDialog } from '../components/WorkspaceIssueFixDialog.js';
import { queueComposerPrefill } from '../components/composer-prefill.js';
import { useDiffpackCount } from '../components/diffpacks/useDiffpacks.js';
import {
  BINARY_FILE,
  type FileBrowserCustomList,
  FileBrowserPane,
  MEDIA_IMAGE,
  NON_TEXT_CONTENT,
  NonTextFilePreview,
  looksBinary,
  mediaSentinel,
  projectFileSource,
  useFileMutations,
} from '../components/file-browser/index.js';
import {
  ARTIFACT_VIEW_MODES,
  type FileViewMode,
  WORKSPACE_VIEW_MODES,
  aggregateIssuesByFile,
  coerceFileViewMode,
  compareFilesByMtimeDesc,
  describeSeverities,
  fileEntryFromPath,
  fileHiddenStorageKey,
  fileViewStorageKey,
  formatRelativeFileTime,
  sortAggregates,
} from '../components/file-view-modes.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { navigateToTab } from '../components/nav-actions.js';
import { consumeCreate } from '../components/nav-intents.js';
import { consumeOpenFile } from '../components/pending-open-file.js';
import {
  type AiProviderEditabilityConfig,
  projectUsesClaude,
  projectUsesCodex,
  resolveProjectClaudePermissionMode,
  resolveProjectWorkspaceAccess,
} from '../components/project-ai-editability.js';
import { makeReportActionFenceRenderers } from '../components/report-actions/ReportActionFence.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useCompactLayout } from '../components/useCompactLayout.js';
import { useShowWorkInProgressFeatures } from '../components/useShowWorkInProgressFeatures.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { crewLeadLabel, crewLeadLabelLower } from '../labels.js';
import { Select, Tabs } from '../primitives/index.js';
import { formatAbsoluteTime, formatRelativeTime } from '../relative-time.js';
import { useEffectiveTheme } from '../theme.js';
import { NewProjectDialog } from './projects/NewProjectDialog.js';
import { formatPreviewComplaint, formatPreviewLog } from './projects/project-preview-log.js';

const loadProjectChatModule = () => import('../components/ProjectChat.js');
const loadProjectConnectionsModule = () => import('../components/ProjectConnectionsTab.js');
const loadProjectMailModule = () => import('../components/ProjectMailTab.js');
const loadDiffpackReviewModule = () => import('../components/diffpacks/DiffpackReviewView.js');
const loadFileMapModule = () => import('./FileMapView.js');
const loadHistoryModule = () => import('./HistoryView.js');
const loadProjectGitHubModule = () => import('./ProjectGithubView.js');
const loadProjectOverviewModule = () => import('./ProjectOverviewView.js');
const loadTasksModule = () => import('./TasksView.js');

const ProjectChat = lazy(() =>
  loadProjectChatModule().then(({ ProjectChat }) => ({ default: ProjectChat })),
);
const ProjectConnectionsTab = lazy(() =>
  loadProjectConnectionsModule().then(({ ProjectConnectionsTab }) => ({
    default: ProjectConnectionsTab,
  })),
);
const ProjectMailTab = lazy(() =>
  loadProjectMailModule().then(({ ProjectMailTab }) => ({ default: ProjectMailTab })),
);
const DiffpackReviewView = lazy(() =>
  loadDiffpackReviewModule().then(({ DiffpackReviewView }) => ({ default: DiffpackReviewView })),
);
const FileMapView = lazy(() =>
  loadFileMapModule().then(({ FileMapView }) => ({ default: FileMapView })),
);
const HistoryView = lazy(() =>
  loadHistoryModule().then(({ HistoryView }) => ({ default: HistoryView })),
);
const ProjectGitHubView = lazy(() =>
  loadProjectGitHubModule().then(({ ProjectGitHubView }) => ({ default: ProjectGitHubView })),
);
const ProjectOverviewView = lazy(() =>
  loadProjectOverviewModule().then(({ ProjectOverviewView }) => ({ default: ProjectOverviewView })),
);
const TasksView = lazy(() => loadTasksModule().then(({ TasksView }) => ({ default: TasksView })));

const SELECTED_PROJECT_STORAGE_KEY = 'gezel:projects:selectedId';

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

function indexedIssueCountForEntry(
  entry: FileEntry,
  issues: ListFileIssuesResponse | null,
): number {
  if (!issues) return 0;
  if (!entry.isDirectory) {
    return issues.issues.filter((issue) => issue.path === entry.path).length;
  }
  const prefix = `${entry.path.replace(/\/$/, '')}/`;
  return issues.issues.filter((issue) => issue.path.startsWith(prefix)).length;
}

type FileTab = 'workspace' | 'artifacts';

interface WorkspaceSourceRevealRequest {
  path: string;
  line: number;
  requestId: number;
}
interface OutsideInOpenFile {
  layout: OutsideInLayout;
  sourcePath: string;
  editingEnabled: boolean;
}
interface PreparedOutsideInDocument extends OutsideInOpenFile {
  content: string;
}
type ProjectTab =
  | 'settings'
  | 'about'
  | 'overview'
  | 'chat'
  | 'tasks'
  | 'packages'
  | 'workspace'
  | 'artifacts'
  | 'proposals'
  | 'github'
  | 'mail'
  | 'connections'
  | 'map'
  | 'history'
  // Compact-only: when the project area is too narrow for the output
  // pane to sit beside the content, it becomes its own tab instead.
  | 'output';

function preloadProjectTab(tab: ProjectTab): void {
  let loading: Promise<unknown> | undefined;
  switch (tab) {
    case 'chat':
      loading = loadProjectChatModule();
      break;
    case 'tasks':
      loading = loadTasksModule();
      break;
    case 'proposals':
      loading = loadDiffpackReviewModule();
      break;
    case 'github':
      loading = loadProjectGitHubModule();
      break;
    case 'mail':
      loading = loadProjectMailModule();
      break;
    case 'map':
      loading = loadFileMapModule();
      break;
    case 'overview':
      loading = loadProjectOverviewModule();
      break;
    case 'about':
      loading = Promise.all([loadProjectConnectionsModule(), loadHistoryModule()]);
      break;
    default:
      break;
  }
  void loading?.catch(() => {});
}

function ProjectPaneBoundary({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<p className="placeholder project-pane-loading">Loading view…</p>}>
      {children}
    </Suspense>
  );
}

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
 * Output-pane visibility used to live only under this localStorage key. It
 * now lives on `project.outputPaneVisible`; these two read and retire a
 * value written by an older build so the user's existing choice isn't lost
 * in the move. The key was per-project and never global.
 *
 * localStorage is the wrong home for it in the desktop shell at all: the
 * renderer's origin is `https://127.0.0.1:<daemon port>`, and the daemon
 * falls back off the canonical port whenever it is taken, silently handing
 * the window an empty store. That is what made a closed pane reappear.
 */
function legacyOutputVisibleKey(projectId: string): string {
  return `gezel.projectOutputVisible:${projectId}`;
}

function readLegacyOutputVisible(projectId: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(legacyOutputVisibleKey(projectId));
    return raw === null ? null : raw === '1';
  } catch {
    return null;
  }
}

function forgetLegacyOutputVisible(projectId: string): void {
  try {
    window.localStorage.removeItem(legacyOutputVisibleKey(projectId));
  } catch {
    /* unavailable — nothing to retire */
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
  connectors?: { type: string }[];
}): boolean {
  return (
    resolveProjectTypeId(p) === 'email' ||
    (p.connectors ?? []).some((b) => b.type.startsWith('mail-'))
  );
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
  const showWorkInProgressFeatures = useShowWorkInProgressFeatures();
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
  const [createMode, setCreateMode] = useState<'crew' | null>(null);
  const [pkgName, setPkgName] = useState('');
  const [log, setLog] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [packageScripts, setPackageScripts] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<ProjectApprovalsResponse | null>(null);

  const [tab, setTab] = useState<ProjectTab>('chat');
  useEffect(() => {
    if (!showWorkInProgressFeatures && tab === 'mail') setTab('about');
  }, [showWorkInProgressFeatures, tab]);
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
  // Per-tab file-panel view mode (tree/flat, sort axis), persisted per
  // project + tab in localStorage. See file-view-modes.ts.
  const [fileViewModes, setFileViewModes] = useState<Record<FileTab, FileViewMode>>({
    workspace: 'tree-alpha',
    artifacts: 'tree-alpha',
  });
  // Per-tab "show hidden files", persisted alongside the view mode. Drives the
  // listing request itself — the exclusions are the walker's, not the tree's.
  const [showHiddenFiles, setShowHiddenFiles] = useState<Record<FileTab, boolean>>({
    workspace: false,
    artifacts: false,
  });
  // Flat index-backed workspace file list ({path, size, mtimeMs}); fetched
  // lazily when the flat "by modified" view is active. Null = not loaded.
  const [workspaceIndexFiles, setWorkspaceIndexFiles] = useState<WorkspaceIndexFile[] | null>(null);
  const [openFile, setOpenFile] = useState<{
    path: string;
    content: string;
    source: FileTab;
    /** On-disk bytes, as reported by the read. Absent for media, which never reads. */
    size?: number;
    outsideIn?: OutsideInOpenFile;
  } | null>(null);
  const [workspaceIndexStatus, setWorkspaceIndexStatus] = useState<WorkspaceIndexStatus | null>(
    null,
  );
  const [workspaceIssues, setWorkspaceIssues] = useState<ListFileIssuesResponse | null>(null);
  const [workspaceIndexError, setWorkspaceIndexError] = useState<string | null>(null);
  const [workspaceReview, setWorkspaceReview] = useState<FileReviewResponse | null>(null);
  const [workspaceReviewLoading, setWorkspaceReviewLoading] = useState(false);
  const [workspaceReviewError, setWorkspaceReviewError] = useState<string | null>(null);
  const [workspaceIndexPaneOpen, setWorkspaceIndexPaneOpen] = useState(false);
  const [workspaceIssueFixRequest, setWorkspaceIssueFixRequest] = useState<{
    path: string;
    issue: BoekwachterIssue;
  } | null>(null);
  const [workspaceSourceReveal, setWorkspaceSourceReveal] =
    useState<WorkspaceSourceRevealRequest | null>(null);
  // In-session output-pane choice, held only until the write to
  // `project.outputPaneVisible` lands (and, for a pre-server-side install,
  // until the localStorage value is migrated). The PROJECT is the source of
  // truth for visibility — never mirror it into state and read the mirror,
  // or the pane flashes open for a frame on every project whose stored
  // answer is "hidden", because an effect cannot run before the first
  // commit that has the project. Carries its project id so a choice made on
  // one project can never resolve the pane for the next one. See the toggle
  // in the entity-tabs-row and
  // [ProjectOutputPane](../components/ProjectOutputPane.tsx).
  const [outputOverride, setOutputOverride] = useState<{
    projectId: string;
    visible: boolean;
  } | null>(null);
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
  const [savingProjectLinks, setSavingProjectLinks] = useState(false);
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
  const linkableProjects = useMemo(() => {
    if (!selected) return [];
    const linked = new Set(selected.linkedProjectIds ?? []);
    return projects.filter(
      (project) =>
        project.id !== selected.id &&
        !isSharedLibraryProject(project) &&
        (!project.archived || linked.has(project.id)),
    );
  }, [projects, selected]);
  const projectLinkLimitReached = (selected?.linkedProjectIds?.length ?? 0) >= 32;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Archive/restore originates from either a rail menu or Project Settings.
  // Keep both the grouped list and the loaded detail in sync from one
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

  // Two ways in, one handler. A "+" click while the listing is already open
  // arrives as the event; a click that had to open the listing first left
  // the intent behind, because the event fired before this listener
  // existed. Both are read here in the mount effect rather than in a render
  // initializer — see `nav-intents.ts` for why that distinction is
  // load-bearing. Never in detail-only mode: a single project tab has no
  // create UI, and swallowing the intent there would strand it.
  useEffect(() => {
    if (detailOnly) return;
    if (consumeCreate('project')) setCreateMode('crew');
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

  const workspaceAccess = useMemo(() => {
    if (!selected) {
      return {
        managedWritable: true,
        nativeWritable: false,
        effectiveWritable: true,
        codexInUse: false,
        claudeInUse: false,
        claudeMode: 'acceptEdits' as const,
      };
    }
    const projectLocalGezels =
      projectLocalGezelRoster?.projectId === selected.id ? projectLocalGezelRoster.gezels : [];
    return {
      ...resolveProjectWorkspaceAccess(selected, gezels, projectLocalGezels, aiProviderConfig),
      codexInUse: projectUsesCodex(selected, gezels, projectLocalGezels, aiProviderConfig),
      claudeInUse: projectUsesClaude(selected, gezels, projectLocalGezels, aiProviderConfig),
      claudeMode: resolveProjectClaudePermissionMode(
        selected,
        gezels,
        projectLocalGezels,
        aiProviderConfig,
      ),
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

  const showWorkspaceHidden = showHiddenFiles.workspace;
  const showArtifactsHidden = showHiddenFiles.artifacts;
  const refreshFiles = useCallback(
    async (id: string) => {
      // Always ask for stats: one fetch powers the alpha tree, the
      // modified-sorted tree, and the artifacts flat view. Cost is bounded by
      // the walker's 500-entry cap.
      const [ws, art] = await Promise.all([
        api.listProjectWorkspace(id, '', true, { stats: true, hidden: showWorkspaceHidden }),
        api.listProjectArtifacts(id, '', true, { stats: true, hidden: showArtifactsHidden }),
      ]);
      setWorkspaceFiles(ws.files);
      setArtifactFiles(art.files);
      setWorkspaceTruncated(ws.truncated === true);
      setArtifactsTruncated(art.truncated === true);
    },
    [showWorkspaceHidden, showArtifactsHidden],
  );

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

  // The workspace tree is an index surface as well as a file browser. Poll
  // the cheap status endpoint and the current review-issue rollup together;
  // both are derived data, so a failed request never blocks file access.
  useEffect(() => {
    if (fileTab !== 'workspace' || !selectedProjectId) return;
    let cancelled = false;
    setWorkspaceIndexStatus(null);
    setWorkspaceIssues(null);
    setWorkspaceIndexError(null);

    const refreshWorkspaceIndexData = async () => {
      const [statusResult, issuesResult] = await Promise.allSettled([
        api.getProjectIndexStatus(selectedProjectId),
        api.toolListFileIssues(selectedProjectId, { maxResults: 1000 }),
      ]);
      if (cancelled) return;
      if (statusResult.status === 'fulfilled') setWorkspaceIndexStatus(statusResult.value);
      if (issuesResult.status === 'fulfilled') setWorkspaceIssues(issuesResult.value);
      if (statusResult.status === 'rejected' && issuesResult.status === 'rejected') {
        const reason = statusResult.reason;
        setWorkspaceIndexError(reason instanceof Error ? reason.message : String(reason));
      } else {
        setWorkspaceIndexError(null);
      }
    };

    void refreshWorkspaceIndexData();
    const timer = window.setInterval(() => void refreshWorkspaceIndexData(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [fileTab, selectedProjectId]);

  // Restore each tab's persisted view mode when the project changes.
  useEffect(() => {
    setWorkspaceIndexFiles(null);
    if (!selectedProjectId) {
      setFileViewModes({ workspace: 'tree-alpha', artifacts: 'tree-alpha' });
      setShowHiddenFiles({ workspace: false, artifacts: false });
      return;
    }
    let workspaceMode: FileViewMode = 'tree-alpha';
    let artifactsMode: FileViewMode = 'tree-alpha';
    let workspaceHidden = false;
    let artifactsHidden = false;
    try {
      workspaceMode = coerceFileViewMode(
        window.localStorage.getItem(fileViewStorageKey(selectedProjectId, 'workspace')),
        'workspace',
      );
      artifactsMode = coerceFileViewMode(
        window.localStorage.getItem(fileViewStorageKey(selectedProjectId, 'artifacts')),
        'artifacts',
      );
      workspaceHidden =
        window.localStorage.getItem(fileHiddenStorageKey(selectedProjectId, 'workspace')) === '1';
      artifactsHidden =
        window.localStorage.getItem(fileHiddenStorageKey(selectedProjectId, 'artifacts')) === '1';
    } catch {}
    setFileViewModes({ workspace: workspaceMode, artifacts: artifactsMode });
    setShowHiddenFiles({ workspace: workspaceHidden, artifacts: artifactsHidden });
  }, [selectedProjectId]);

  const setFileViewMode = useCallback(
    (tabKey: FileTab, mode: FileViewMode) => {
      setFileViewModes((current) => ({ ...current, [tabKey]: mode }));
      if (selectedProjectId) {
        try {
          window.localStorage.setItem(fileViewStorageKey(selectedProjectId, tabKey), mode);
        } catch {}
      }
    },
    [selectedProjectId],
  );

  const setShowHidden = useCallback(
    (tabKey: FileTab, next: boolean) => {
      setShowHiddenFiles((current) => ({ ...current, [tabKey]: next }));
      if (selectedProjectId) {
        try {
          window.localStorage.setItem(
            fileHiddenStorageKey(selectedProjectId, tabKey),
            next ? '1' : '0',
          );
        } catch {}
      }
    },
    [selectedProjectId],
  );

  // Fetch the complete index-backed file list while the flat "by modified"
  // workspace view is active. Keyed on `scannedAt` so a finished re-scan
  // (e.g. after "Index now") refreshes the list through the existing 30s
  // status poll — no extra polling loop.
  const workspaceViewMode = fileViewModes.workspace;
  const indexScannedAt = workspaceIndexStatus?.meta?.scannedAt;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `indexScannedAt` is a deliberate extra dependency — a finished re-scan must refresh the list.
  useEffect(() => {
    if (fileTab !== 'workspace' || workspaceViewMode !== 'flat-modified' || !selectedProjectId) {
      return;
    }
    let cancelled = false;
    api
      .listProjectIndexFilesDetail(selectedProjectId, { hidden: showWorkspaceHidden })
      .then((res) => {
        if (!cancelled) setWorkspaceIndexFiles(res.files);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceIndexFiles(null);
      });
    return () => {
      cancelled = true;
    };
  }, [fileTab, workspaceViewMode, selectedProjectId, indexScannedAt, showWorkspaceHidden]);

  const workspaceReviewPath =
    fileTab === 'workspace' && openFile?.source === 'workspace' ? openFile.path : null;
  const reviewedFileCount = workspaceIndexStatus?.enrichment?.reviews?.reviewed;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a completed background review should refresh the selected file even when its path is unchanged.
  useEffect(() => {
    if (!selectedProjectId || !workspaceReviewPath) {
      setWorkspaceReview(null);
      setWorkspaceReviewLoading(false);
      setWorkspaceReviewError(null);
      return;
    }
    let cancelled = false;
    setWorkspaceReview(null);
    setWorkspaceReviewLoading(true);
    setWorkspaceReviewError(null);
    api
      .toolFileReview(selectedProjectId, { path: workspaceReviewPath })
      .then((response) => {
        if (!cancelled) setWorkspaceReview(response);
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setWorkspaceReviewError(reason instanceof Error ? reason.message : String(reason));
        }
      })
      .finally(() => {
        if (!cancelled) setWorkspaceReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId, workspaceReviewPath, reviewedFileCount]);

  const refreshWorkspaceIssueSurfaces = useCallback(async () => {
    if (!selectedProjectId) return;
    const [issuesResult, reviewResult] = await Promise.all([
      api.toolListFileIssues(selectedProjectId, { maxResults: 1000 }),
      workspaceReviewPath
        ? api.toolFileReview(selectedProjectId, { path: workspaceReviewPath })
        : Promise.resolve(null),
    ]);
    setWorkspaceIssues(issuesResult);
    if (reviewResult) setWorkspaceReview(reviewResult);
  }, [selectedProjectId, workspaceReviewPath]);

  const updateWorkspaceIssue = useCallback(
    async (
      issue: BoekwachterIssue,
      patch: {
        status?: BoekwachterIssueStatus;
        seen?: boolean;
        dismissalReason?: BoekwachterIssueDismissalReason;
      },
    ) => {
      if (!selectedProjectId) return;
      await api.updateBoekwachterIssue(selectedProjectId, { ref: issue.ref, ...patch });
      await refreshWorkspaceIssueSurfaces();
    },
    [refreshWorkspaceIssueSurfaces, selectedProjectId],
  );

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
      setWorkspaceIndexPaneOpen(false);
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
  const focusFile = useCallback(
    async (projectId: string, path: string, source: FileTab, line?: number) => {
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
      // Land on the match, not the top of the file: a search hit carries its
      // line, and the editor-side reveal bridge centers it once mounted.
      if (line) {
        setWorkspaceSourceReveal((current) => ({
          path,
          line,
          requestId: (current?.requestId ?? 0) + 1,
        }));
      }
    },
    [],
  );

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

  // "Turn it on in Project Settings" affordances (overview prose, status-bar
  // note) land the user THERE instead of telling them where to go.
  useEffect(() => {
    const onOpenSettings = (e: Event) => {
      const detail = (e as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId && selected && detail.projectId !== selected.id) return;
      setTab('settings');
    };
    window.addEventListener('gezel:open-project-settings', onOpenSettings);
    return () => window.removeEventListener('gezel:open-project-settings', onOpenSettings);
  }, [selected]);

  // Open a file in the currently-selected project (the already-open case — no
  // remount). The cross-project remount case is handled by the mailbox consume
  // in the forceProjectId effect below; draining it here keeps a queued intent
  // from firing later on a manual navigation.
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const d = (
        e as CustomEvent<{ projectId?: string; path?: string; source?: FileTab; line?: number }>
      ).detail;
      if (!d?.path || !d.source) return;
      if (selected && (!d.projectId || d.projectId === selected.id)) {
        consumeOpenFile(selected.id);
        void focusFile(selected.id, d.path, d.source, d.line);
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
      if (intent) void focusFile(forceProjectId, intent.path, intent.source, intent.line);
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
      setWorkspaceIndexPaneOpen(false);
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

  const saveManagedWorkspaceWrites = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, {
          managedWorkspaceWritePolicy: next ? 'allow' : 'deny',
        });
        setSelected(updated);
      } catch (err) {
        console.error('updateProject(managedWorkspaceWritePolicy) failed:', err);
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

  const saveClaudePermissionMode = useCallback(
    async (next: ClaudePermissionMode) => {
      if (!selected) return;
      try {
        const updated = await api.updateProject(selected.id, { claudePermissionMode: next });
        setSelected(updated);
      } catch (err) {
        console.error('updateProject(claudePermissionMode) failed:', err);
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

  const saveNightlyFixesEnabled = useCallback(
    async (next: boolean) => {
      if (!selected) return;
      try {
        setSelected(await api.updateProject(selected.id, { nightlyFixesEnabled: next }));
      } catch (err) {
        console.error('updateProject(nightlyFixesEnabled) failed:', err);
      }
    },
    [selected],
  );

  const toggleProjectLink = useCallback(
    async (linkedProjectId: string, enabled: boolean) => {
      if (!selected || savingProjectLinks) return;
      const current = selected.linkedProjectIds ?? [];
      const linkedProjectIds = enabled
        ? Array.from(new Set([...current, linkedProjectId]))
        : current.filter((id) => id !== linkedProjectId);
      setSavingProjectLinks(true);
      try {
        const updated = await api.updateProject(selected.id, { linkedProjectIds });
        setSelected(updated);
        setProjects((items) =>
          items.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingProjectLinks(false);
      }
    },
    [savingProjectLinks, selected],
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

  const canWriteProjectFiles = useCallback(
    (source: FileTab): boolean =>
      source === 'artifacts' || projectManagedWorkspaceWritable(selected),
    [selected],
  );

  const prepareOutsideInDocument = useCallback(
    async (entry: FileEntry, source: FileTab): Promise<PreparedOutsideInDocument> => {
      if (!selected) throw new Error('Open a project before viewing this document.');
      const layout = resolveOutsideInLayout(entry.path);
      if (!layout) throw new Error('This file does not support a Markdown companion.');
      const entries = source === 'workspace' ? workspaceFiles : artifactFiles;
      let sourcePath = chooseOutsideInSource(
        layout,
        entries.filter((candidate) => !candidate.isDirectory).map((candidate) => candidate.path),
      );
      let content: string;
      if (sourcePath) {
        const response =
          source === 'workspace'
            ? await api.readProjectWorkspaceFile(selected.id, sourcePath)
            : await api.readProjectArtifact(selected.id, sourcePath);
        content = response.content;
      } else {
        if (!canWriteProjectFiles(source)) {
          throw new Error(
            'Enable workspace writes for this external project before importing its Markdown companion.',
          );
        }
        const blob =
          source === 'workspace'
            ? await api.fetchProjectWorkspaceBlob(selected.id, entry.path)
            : await api.fetchProjectArtifactBlob(selected.id, entry.path);
        const imported = await importOutsideInDocument(await blob.arrayBuffer(), layout);
        const container = createProjectContentContainer({
          projectId: selected.id,
          root: layout.companionDirectory,
          client: api,
          primaryDocumentFilename: layout.markdownFilename,
          source,
        });
        for (const importedEntry of await imported.container.listFiles()) {
          if (/\.md$/i.test(importedEntry.path)) continue;
          const data = await imported.container.readFile(importedEntry.path);
          if (!data) continue;
          await container.writeFile(importedEntry.path, data, importedEntry.mimeType);
        }
        await container.writeDocument(imported.markdown, layout.markdownFilename);
        sourcePath = layout.markdownPath;
        content = imported.markdown;
        await refreshFiles(selected.id);
      }
      const linkedContent = withOutsideInMetadata(content, layout);
      if (linkedContent !== content && canWriteProjectFiles(source)) {
        if (source === 'workspace') {
          await api.writeProjectWorkspaceFile(selected.id, {
            path: sourcePath,
            content: linkedContent,
          });
        } else {
          await api.writeProjectArtifact(selected.id, sourcePath, linkedContent);
        }
      }
      return {
        layout: { ...layout, markdownPath: sourcePath },
        sourcePath,
        content: linkedContent,
        editingEnabled: isOutsideInMarkdownEditingEnabled(linkedContent),
      };
    },
    [selected, workspaceFiles, artifactFiles, canWriteProjectFiles, refreshFiles],
  );

  const openFileEntry = useCallback(
    async (entry: FileEntry, source: FileTab) => {
      if (!selected || entry.isDirectory) return;
      const layout = resolveOutsideInLayout(entry.path);
      if (layout) {
        try {
          const prepared = await prepareOutsideInDocument(entry, source);
          setOpenFile({
            path: entry.path,
            content: prepared.content,
            source,
            outsideIn: {
              layout: prepared.layout,
              sourcePath: prepared.sourcePath,
              editingEnabled: prepared.editingEnabled,
            },
          });
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Could not open this rendered document.');
        }
        return;
      }
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
    [selected, prepareOutsideInDocument],
  );

  const allowOutsideInMarkdownEditing = useCallback(
    async (entry: FileEntry, source: FileTab) => {
      if (!selected || entry.isDirectory) return;
      if (!canWriteProjectFiles(source)) {
        setError('Enable workspace writes before allowing Markdown editing.');
        return;
      }
      try {
        const prepared = await prepareOutsideInDocument(entry, source);
        const original =
          source === 'workspace'
            ? await api.fetchProjectWorkspaceBlob(selected.id, prepared.layout.targetPath)
            : await api.fetchProjectArtifactBlob(selected.id, prepared.layout.targetPath);
        try {
          if (source === 'workspace') {
            await api.writeProjectWorkspaceBinary(
              selected.id,
              prepared.layout.backupPath,
              original,
              original.type || 'application/octet-stream',
              { createOnly: true },
            );
          } else {
            await api.writeProjectArtifactBinary(
              selected.id,
              prepared.layout.backupPath,
              original,
              original.type || 'application/octet-stream',
              { createOnly: true },
            );
          }
        } catch (err) {
          if (!(err instanceof Error) || !err.message.includes('already exists')) throw err;
        }
        const editableContent = withOutsideInMarkdownEditing(prepared.content, prepared.layout);
        if (source === 'workspace') {
          await api.writeProjectWorkspaceFile(selected.id, {
            path: prepared.sourcePath,
            content: editableContent,
          });
        } else {
          await api.writeProjectArtifact(selected.id, prepared.sourcePath, editableContent);
        }
        setOpenFile({
          path: entry.path,
          content: editableContent,
          source,
          outsideIn: {
            layout: prepared.layout,
            sourcePath: prepared.sourcePath,
            editingEnabled: true,
          },
        });
        setError(null);
        await refreshFiles(selected.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not enable Markdown editing.');
      }
    },
    [selected, canWriteProjectFiles, prepareOutsideInDocument, refreshFiles],
  );

  // Stable identity + functional setState. Inline arrow + stale closure here
  // used to churn the EditorShell's `[markdownSource, onChange]` effect every
  // render, producing a feedback loop that ate click events on the file tree.
  const handleEditorContentChange = useCallback((source: string) => {
    setOpenFile((prev) => (prev ? { ...prev, content: source } : prev));
  }, []);

  const saveArtifact = useCallback(
    async (contentOverride?: string) => {
      if (!selected || !openFile || NON_TEXT_CONTENT.has(openFile.content)) return;
      const content = contentOverride ?? openFile.content;
      if (openFile.outsideIn) {
        if (!canWriteProjectFiles(openFile.source) || !openFile.outsideIn.editingEnabled) return;
        const { layout, sourcePath } = openFile.outsideIn;
        const container = createProjectContentContainer({
          projectId: selected.id,
          root: layout.companionDirectory,
          client: api,
          primaryDocumentFilename: basenameOf(sourcePath),
          source: openFile.source,
        });
        const allEntries = openFile.source === 'workspace' ? workspaceFiles : artifactFiles;
        const runtimePath =
          layout.format === 'html'
            ? runtimePathForTarget(
                layout.targetPath,
                new Set(
                  allEntries
                    .filter((entry) => entry.isDirectory)
                    .map((entry) => entry.path.replace(/^\/+/, '')),
                ),
              )
            : undefined;
        const linkedContent = withOutsideInMetadata(content, layout);
        const rendered = await renderOutsideInDocument(
          linkedContent,
          layout,
          container,
          runtimePath ? relativePath(layout.parentDirectory, runtimePath) : undefined,
        );

        if (openFile.source === 'workspace') {
          await api.writeProjectWorkspaceFile(selected.id, {
            path: sourcePath,
            content: linkedContent,
          });
        } else {
          await api.writeProjectArtifact(selected.id, sourcePath, linkedContent);
        }
        if (runtimePath) {
          const { PLAYER_BUNDLE } = await import('@bendyline/squisq-react/standalone-source');
          if (openFile.source === 'workspace') {
            await api.writeProjectWorkspaceFile(selected.id, {
              path: runtimePath,
              content: PLAYER_BUNDLE,
            });
          } else {
            await api.writeProjectArtifact(selected.id, runtimePath, PLAYER_BUNDLE);
          }
        }
        if (openFile.source === 'workspace') {
          await api.writeProjectWorkspaceBinary(
            selected.id,
            layout.targetPath,
            rendered.bytes,
            rendered.mimeType,
          );
        } else {
          await api.writeProjectArtifactBinary(
            selected.id,
            layout.targetPath,
            rendered.bytes,
            rendered.mimeType,
          );
        }
        setOpenFile((current) =>
          current?.path === openFile.path && current.source === openFile.source
            ? { ...current, content: linkedContent }
            : current,
        );
        await refreshProjectFiles(selected.id);
        return;
      }
      // Plain text file. Deliberately no listing refresh: this path is an
      // autosave lane now, and re-walking the tree on every keystroke pause
      // would cost a full directory walk for a change that alters no
      // structure.
      if (!canWriteProjectFiles(openFile.source)) return;
      if (openFile.source === 'workspace') {
        await api.writeProjectWorkspaceFile(selected.id, {
          path: openFile.path,
          content,
        });
      } else {
        await api.writeProjectArtifact(selected.id, openFile.path, content);
      }
    },
    [selected, openFile, canWriteProjectFiles, workspaceFiles, artifactFiles, refreshProjectFiles],
  );

  const imageUrl = useCallback(
    (path: string, source: FileTab) =>
      selected
        ? `/api/projects/${selected.id}/${source === 'workspace' ? 'workspace' : 'artifacts'}/read?path=${encodeURIComponent(path)}&raw=1`
        : '',
    [selected],
  );

  const activeEntries = fileTab === 'workspace' ? workspaceFiles : artifactFiles;
  const showActiveHidden = fileTab ? showHiddenFiles[fileTab] : false;
  // The outside-in sidecar folders (`_squisq`, `*_files`) are hidden for the
  // same reason the walker hides dot-folders — "show hidden files" reveals
  // both, otherwise the artifacts shadow/ folder would open onto nothing.
  const visibleActiveEntries = useMemo(
    () =>
      showActiveHidden
        ? activeEntries
        : activeEntries.filter((entry) => !isOutsideInInternalPath(entry.path)),
    [activeEntries, showActiveHidden],
  );
  const activeViewMode: FileViewMode = fileTab ? fileViewModes[fileTab] : 'tree-alpha';
  // Flat "by modified": prefer the complete index-backed list for the
  // workspace (not capped by the walker); artifacts — and workspaces with
  // indexing disabled or not yet scanned — fall back to the walked entries,
  // which now carry mtimes.
  const flatModifiedEntries = useMemo(() => {
    if (activeViewMode !== 'flat-modified') return [];
    if (fileTab === 'workspace' && workspaceIndexFiles && workspaceIndexFiles.length > 0) {
      return workspaceIndexFiles
        .filter((file) => showActiveHidden || !isOutsideInInternalPath(file.path))
        .map((file) => fileEntryFromPath(file.path, file.mtimeMs))
        .sort(compareFilesByMtimeDesc);
    }
    return visibleActiveEntries
      .filter((entry) => !entry.isDirectory)
      .slice()
      .sort(compareFilesByMtimeDesc);
  }, [activeViewMode, fileTab, workspaceIndexFiles, visibleActiveEntries, showActiveHidden]);
  // Triage views: aggregate the already-polled live issues by file.
  const issueAggregates = useMemo(
    () => aggregateIssuesByFile(workspaceIssues?.issues ?? []),
    [workspaceIssues],
  );
  const issueAggByPath = useMemo(
    () => new Map(issueAggregates.map((agg) => [agg.path, agg])),
    [issueAggregates],
  );
  const flatIssueEntries = useMemo(() => {
    if (activeViewMode !== 'flat-issues' && activeViewMode !== 'flat-criticality') return [];
    return sortAggregates(
      issueAggregates,
      activeViewMode === 'flat-issues' ? 'count' : 'score',
    ).map((agg) => fileEntryFromPath(agg.path));
  }, [activeViewMode, issueAggregates]);
  // The shared browser builds its own flat-by-modified list from the walked
  // entries. The workspace prefers the index-backed list where it exists (not
  // capped by the walker), and owns the two issue-triage lists outright.
  const indexBackedFlatList =
    activeViewMode === 'flat-modified' &&
    fileTab === 'workspace' &&
    workspaceIndexFiles !== null &&
    workspaceIndexFiles.length > 0;
  const fileCustomList: FileBrowserCustomList | null = useMemo(() => {
    if (activeViewMode === 'flat-issues' || activeViewMode === 'flat-criticality') {
      return {
        entries: flatIssueEntries,
        emptyMessage: 'No open review issues.',
        onSelect: (entry) => {
          if (!fileTab) return;
          void openFileEntry(entry, fileTab);
          setWorkspaceIndexPaneOpen(true);
        },
        trailingForEntry: (entry) => {
          const agg = issueAggByPath.get(entry.path);
          if (!agg) return null;
          return (
            <>
              {activeViewMode === 'flat-criticality' ? (
                <span className="file-flat-score" title={`Criticality score ${agg.score}`}>
                  {agg.score}
                </span>
              ) : (
                <span
                  className="workspace-tree-issue-count"
                  title={`${agg.total} Boekwachter issue${agg.total === 1 ? '' : 's'} in this file`}
                >
                  {agg.total}
                </span>
              )}
              <span className="file-flat-severities">{describeSeverities(agg.bySeverity)}</span>
            </>
          );
        },
      };
    }
    if (!indexBackedFlatList) return null;
    return {
      entries: flatModifiedEntries,
      emptyMessage: 'No files yet.',
      trailingForEntry: (entry) =>
        entry.mtimeMs !== undefined ? (
          <span className="file-flat-time" title={formatAbsoluteTime(new Date(entry.mtimeMs))}>
            {formatRelativeFileTime(new Date(entry.mtimeMs).toISOString())}
          </span>
        ) : null,
    };
  }, [
    activeViewMode,
    fileTab,
    flatIssueEntries,
    flatModifiedEntries,
    indexBackedFlatList,
    issueAggByPath,
    openFileEntry,
  ]);
  // One adapter per (project, tab). The file panel itself is the shared
  // browser — everything project-specific reaches it through this source or
  // through the slots below (index summary, review pane, issue lists).
  const fileSource = useMemo(
    () =>
      projectFileSource(selected?.id ?? '', fileTab ?? 'artifacts', {
        canWrite: selected !== null && fileTab !== null && canWriteProjectFiles(fileTab),
      }),
    [selected, fileTab, canWriteProjectFiles],
  );
  const selectFilePath = useCallback(
    (path: string | null) => {
      if (!path) {
        setOpenFile(null);
        return;
      }
      if (!fileTab) return;
      void openFileEntry(fileEntryFromPath(path), fileTab);
    },
    [fileTab, openFileEntry],
  );
  const fileMutations = useFileMutations({
    source: fileSource,
    entries: activeEntries,
    selectedPath: openFile?.path ?? null,
    onSelectPath: selectFilePath,
    refresh: useCallback(async () => {
      if (selected) await refreshProjectFiles(selected.id);
    }, [selected, refreshProjectFiles]),
  });
  // Workspace files are editable exactly when the managed-workspace write
  // policy allows it; artifacts always are. A rendered document additionally
  // needs its explicit Markdown-editing opt-in.
  const isReadOnly = openFile?.outsideIn
    ? !openFile.outsideIn.editingEnabled || !canWriteProjectFiles(openFile.source)
    : fileTab
      ? !canWriteProjectFiles(fileTab)
      : true;
  const selectedWorkspaceIssueCount = workspaceReviewPath
    ? indexedIssueCountForEntry(
        { name: basenameOf(workspaceReviewPath), path: workspaceReviewPath, isDirectory: false },
        workspaceIssues,
      )
    : 0;
  // The reveal bridge anchors to whatever file is open in an editor — search
  // hits carry a line for artifacts too, not only workspace-tab review files.
  // The index toggle itself stays workspace-only (reviews are workspace-scoped).
  const activeWorkspaceSourceReveal =
    workspaceSourceReveal?.path === openFile?.path ? workspaceSourceReveal : null;
  const workspaceIndexToggle: ReactNode = (
    <>
      <WorkspaceSourceLineReveal request={activeWorkspaceSourceReveal} />
      {workspaceReviewPath ? (
        <WorkspaceIndexToggle
          open={workspaceIndexPaneOpen}
          issueCount={selectedWorkspaceIssueCount}
          onToggle={() => setWorkspaceIndexPaneOpen((open) => !open)}
        />
      ) : null}
    </>
  );

  // Output pane: the set of previewable workspace HTML files, whether a
  // previewable index.html exists (drives the auto-on default), and the
  // resolved visibility (per-project user override wins over the auto
  // default). The toggle persists the override onto the project, so it
  // survives reloads, project switches, and the daemon changing ports.
  const hasIndexHtml = useMemo(
    () => workspaceHtmlFiles.some((p) => /(^|\/)index\.html?$/i.test(p)),
    [workspaceHtmlFiles],
  );
  // Retire a leftover localStorage value from before the choice moved
  // server-side: adopt it once, then drop it, so the two can never
  // disagree afterwards. A project that already carries the flag needs
  // nothing here — it is read straight off `selected` below.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the selected project id.
  useEffect(() => {
    if (!selected) {
      setOutputOverride(null);
      return;
    }
    if (typeof selected.outputPaneVisible === 'boolean') {
      forgetLegacyOutputVisible(selected.id);
      return;
    }
    const legacy = readLegacyOutputVisible(selected.id);
    if (legacy === null) return;
    const projectId = selected.id;
    setOutputOverride({ projectId, visible: legacy });
    void api
      .updateProject(projectId, { outputPaneVisible: legacy })
      .then((updated) => {
        forgetLegacyOutputVisible(projectId);
        setSelected((current) => (current?.id === projectId ? updated : current));
      })
      .catch(() => {
        /* keep the cached value; the next load retries the migration */
      });
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
  const pendingOutputChoice =
    outputOverride && outputOverride.projectId === selected?.id ? outputOverride.visible : null;
  const outputVisible =
    Boolean(selected) &&
    (pendingOutputChoice ?? selected?.outputPaneVisible ?? (hasIndexHtml || Boolean(typePage)));
  const toggleOutput = useCallback(() => {
    if (!selected) return;
    const next = !outputVisible;
    const projectId = selected.id;
    setOutputOverride({ projectId, visible: next });
    void api
      .updateProject(projectId, { outputPaneVisible: next })
      .then((updated) => {
        setSelected((current) => (current?.id === projectId ? updated : current));
      })
      .catch((err) => {
        setError((err as Error).message);
      });
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
  const diffpackCount = useDiffpackCount(selected?.id ?? '');
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
    if (!selected || selected.id === 'default' || isSharedLibraryProject(selected)) return;
    if (changingArchive) return;
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
            aria-label={sidebarCollapsed ? p.name : undefined}
          >
            <ProjectIcon project={p} size={18} className="project-rail-mark" />
            {!sidebarCollapsed && (
              <>
                <span className="project-rail-label">{p.name}</span>
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
      {selected && workspaceIssueFixRequest && (
        <WorkspaceIssueFixDialog
          key={`${workspaceIssueFixRequest.path}:${workspaceIssueFixRequest.issue.category}:${workspaceIssueFixRequest.issue.message}`}
          path={workspaceIssueFixRequest.path}
          issue={workspaceIssueFixRequest.issue}
          gezels={gezels}
          assignedGezelIds={
            new Set([
              ...(selected.gezelIds ?? []),
              ...(selected.voormanGezelId ? [selected.voormanGezelId] : []),
            ])
          }
          onCancel={() => setWorkspaceIssueFixRequest(null)}
          onConfirm={async (gezelId, message) => {
            await api.fixBoekwachterIssue(selected.id, {
              ref: workspaceIssueFixRequest.issue.ref,
              gezelId,
              message,
            });
            await refreshWorkspaceIssueSurfaces();
            setWorkspaceIssueFixRequest(null);
            setTab('chat');
          }}
        />
      )}
      {!detailOnly && (
        <aside className={`side${sidebarCollapsed ? ' collapsed' : ''}`}>
          <div className="area-toolbar">
            {!sidebarCollapsed && (
              <button
                type="button"
                className="area-toolbar-btn"
                onClick={() => setCreateMode('crew')}
              >
                + New Project
              </button>
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
                      // Shown only once the project has proposals: a tab that is
                      // empty for every project that never ran a fix is noise.
                      {
                        value: 'proposals',
                        label: 'Proposals',
                        show: diffpackCount > 0,
                      },
                      { value: 'github', label: 'GitHub', show: Boolean(selected.github?.url) },
                      {
                        value: 'mail',
                        label: 'Mail',
                        show: showWorkInProgressFeatures && isEmailProject(selected),
                      },
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
                          onPointerEnter={() => preloadProjectTab(t.value)}
                          onFocus={() => preloadProjectTab(t.value)}
                          onPointerDown={() => preloadProjectTab(t.value)}
                        >
                          <ProjectTabIcon tab={t.value} />
                        </Tabs.Trigger>
                      ) : (
                        <Tabs.Trigger
                          key={t.value}
                          value={t.value}
                          data-testid={`project-tab-${t.value}`}
                          onPointerEnter={() => preloadProjectTab(t.value)}
                          onFocus={() => preloadProjectTab(t.value)}
                          onPointerDown={() => preloadProjectTab(t.value)}
                        >
                          {t.label}
                        </Tabs.Trigger>
                      ),
                    )}
                </Tabs.List>
              </Tabs.Root>
              {selected.archived && (
                <span className="project-archived-badge" title="Hidden from primary navigation">
                  Archived
                </span>
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
                        projectId={selected.id}
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
                        projectId={selected.id}
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

                      {showWorkInProgressFeatures && (
                        <section
                          id="project-about-connections"
                          className="project-about-section project-about-anchor"
                        >
                          <ProjectPaneBoundary>
                            <ProjectConnectionsTab
                              project={selected}
                              onProjectChange={setSelected}
                            />
                          </ProjectPaneBoundary>
                        </section>
                      )}

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
                            {MANAGED_WORKSPACE_WRITE_SETTING_LABEL}
                            <div className="new-row" style={{ alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={workspaceAccess.managedWritable}
                                onChange={(e) => {
                                  const next = e.target.checked;
                                  // Flipping ON for an external workingDir prompts a
                                  // confirmation — models will be able to modify files
                                  // in that user-supplied path. Internal workspaces
                                  // (our folder) flip silently.
                                  if (next && selected.workingDir) {
                                    setShowAllowWritesConfirm(true);
                                  } else {
                                    void saveManagedWorkspaceWrites(next);
                                  }
                                }}
                              />
                              <span className="muted small">
                                {selected.workingDir
                                  ? 'Off by default for external folders. Turn on only if you trust the crew’s tools and automations to edit this path.'
                                  : 'Internal workspace — on by default. Provider-native access, when used, follows its own project posture.'}
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

                          <label className="config-label" style={{ marginTop: '0.75rem' }}>
                            Fix problems overnight
                            <div className="new-row" style={{ alignItems: 'center' }}>
                              <input
                                type="checkbox"
                                checked={selected.nightlyFixesEnabled !== false}
                                onChange={(event) =>
                                  void saveNightlyFixesEnabled(event.target.checked)
                                }
                              />
                              <span className="muted small">
                                When this project has both a Boekwachter and a developer, the
                                developer works through open issues during the night shift. Your
                                files aren’t touched — fixes arrive as change proposals in the
                                Proposals tab for you to review and apply.
                              </span>
                            </div>
                          </label>

                          {!isSharedLibraryProject(selected) && (
                            <fieldset className="project-tab-settings">
                              <legend>Linked projects</legend>
                              <p className="muted small">
                                Give this project one-way access to another project’s indexed
                                knowledge and workspace. The other project does not gain access
                                back. Shared documents are always included automatically.{' '}
                                {(selected.linkedProjectIds ?? []).length} of 32 linked.
                              </p>
                              <div className="project-tab-settings-grid">
                                {linkableProjects.map((project) => {
                                  const checked = (selected.linkedProjectIds ?? []).includes(
                                    project.id,
                                  );
                                  return (
                                    <label key={project.id} className="new-row">
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={
                                          savingProjectLinks ||
                                          (!checked && projectLinkLimitReached)
                                        }
                                        onChange={(event) =>
                                          void toggleProjectLink(project.id, event.target.checked)
                                        }
                                      />
                                      <span>
                                        {project.name}
                                        <span className="muted small"> — {project.id}</span>
                                        {project.archived ? (
                                          <span className="muted small"> — archived</span>
                                        ) : null}
                                        {!projectManagedWorkspaceWritable(project) ? (
                                          <span className="muted small">
                                            {' '}
                                            — workspace read-only
                                          </span>
                                        ) : null}
                                      </span>
                                    </label>
                                  );
                                })}
                                {linkableProjects.length === 0 ? (
                                  <span className="muted small">
                                    No other projects are available.
                                  </span>
                                ) : null}
                              </div>
                              <small className="muted">
                                Gezels address linked files with the existing file tools at{' '}
                                <code>../project-id/…</code>. Writes still follow the linked
                                project’s own workspace-write setting.
                              </small>
                            </fieldset>
                          )}

                          <ProjectKnowledgeRow project={selected} onUpdated={setSelected} />

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
                                ? 'The single gezel who handles this entire job — the Builder. Mentioned in the system prompt for any chat scoped here. Team-management tools are stripped from their thread.'
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

                          {selected.id !== 'default' && !isSharedLibraryProject(selected) && (
                            <div className="project-archive-setting">
                              <div className="project-archive-setting-copy">
                                <span className="project-archive-setting-title">
                                  {selected.archived ? 'Restore project' : 'Archive project'}
                                </span>
                                <small className="muted">
                                  {selected.archived
                                    ? 'Return this project to primary navigation. Its previous inactive status is preserved.'
                                    : 'Hide this project from primary navigation and pause automatic project work. Its files and chats stay on disk.'}
                                </small>
                              </div>
                              <button
                                type="button"
                                className="secondary project-archive-setting-action"
                                onClick={() => void toggleSelectedArchive()}
                                disabled={changingArchive}
                              >
                                {changingArchive
                                  ? selected.archived
                                    ? 'Restoring…'
                                    : 'Archiving…'
                                  : selected.archived
                                    ? 'Restore project'
                                    : 'Archive project'}
                              </button>
                            </div>
                          )}

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
                                    <span
                                      className="muted small"
                                      title={formatAbsoluteTime(entry.at)}
                                    >
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
                          <ProjectPaneBoundary>
                            <HistoryView projectId={selected.id} />
                          </ProjectPaneBoundary>
                        </div>
                      </section>

                      <nav className="project-about-toc" aria-label="About sections">
                        <div className="project-about-toc-title">On this page</div>
                        <a href="#project-about-crew">Assigned gezellen</a>
                        <a href="#project-about-overview">About this project</a>
                        <a href="#project-about-mission">Mission objectives</a>
                        <a href="#project-about-memories">Project memories</a>
                        {showWorkInProgressFeatures && (
                          <a href="#project-about-connections">Connections</a>
                        )}
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
                      await saveManagedWorkspaceWrites(true);
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
                    <FileBrowserPane
                      source={fileSource}
                      layoutClassName={`project-files-layout-${fileTab}`}
                      entries={visibleActiveEntries}
                      truncated={
                        (fileTab === 'workspace' ? workspaceTruncated : artifactsTruncated) &&
                        !indexBackedFlatList
                      }
                      viewMode={activeViewMode}
                      modes={fileTab === 'workspace' ? WORKSPACE_VIEW_MODES : ARTIFACT_VIEW_MODES}
                      onViewModeChange={(mode) => setFileViewMode(fileTab, mode)}
                      showHidden={showActiveHidden}
                      onShowHiddenChange={(next) => setShowHidden(fileTab, next)}
                      selectedPath={openFile?.path}
                      onSelect={(entry) => void openFileEntry(entry, fileTab)}
                      emptyMessage={
                        fileTab === 'workspace'
                          ? selected.workingDir
                            ? 'Workspace directory is empty.'
                            : 'No external working directory set. Use the internal workspace or set an external path under the Settings tab.'
                          : 'No artifacts yet. Your gezellen will store reports and outputs here.'
                      }
                      mutations={fileMutations}
                      customList={fileCustomList}
                      trailingForEntry={
                        fileTab === 'workspace'
                          ? (entry) => {
                              const count = indexedIssueCountForEntry(entry, workspaceIssues);
                              return count > 0 ? (
                                <span
                                  className="workspace-tree-issue-count"
                                  title={`${count} Boekwachter issue${count === 1 ? '' : 's'} ${entry.isDirectory ? 'in this folder' : 'in this file'}`}
                                  aria-label={`${count} indexing issue${count === 1 ? '' : 's'}`}
                                >
                                  {count}
                                </span>
                              ) : null;
                            }
                          : undefined
                      }
                      actionsForEntry={(entry) => {
                        if (
                          entry.isDirectory ||
                          !resolveOutsideInLayout(entry.path) ||
                          (openFile?.path === entry.path &&
                            openFile.source === fileTab &&
                            openFile.outsideIn?.editingEnabled)
                        ) {
                          return [];
                        }
                        return [
                          {
                            label: 'Allow editing via markdown',
                            disabled: !canWriteProjectFiles(fileTab),
                            onSelect: () => allowOutsideInMarkdownEditing(entry, fileTab),
                          },
                        ];
                      }}
                      headerExtra={
                        fileTab === 'workspace' ? (
                          <div
                            className="workspace-tree-index-summary"
                            aria-live="polite"
                            title={
                              workspaceIndexError ??
                              (workspaceIssues
                                ? `${workspaceIssues.reviewedFiles} of ${workspaceIssues.eligibleFiles} eligible files reviewed`
                                : workspaceIndexLabel(workspaceIndexStatus))
                            }
                          >
                            <span
                              className={`workspace-index-state workspace-index-state-${indexTone(workspaceIndexStatus)}`}
                            >
                              <span aria-hidden="true" />
                              {workspaceIndexError
                                ? 'Index unavailable'
                                : workspaceIndexLabel(workspaceIndexStatus)}
                            </span>
                            {workspaceIssues && workspaceIssues.counts.total > 0 && (
                              <span className="workspace-tree-issue-total">
                                {workspaceIssues.counts.total} issue
                                {workspaceIssues.counts.total === 1 ? '' : 's'}
                              </span>
                            )}
                          </div>
                        ) : undefined
                      }
                      notices={
                        fileTab === 'workspace' ? (
                          <>
                            {activeViewMode === 'flat-modified' &&
                              workspaceIndexStatus &&
                              workspaceIndexStatus.state !== 'fresh' && (
                                <div className="file-flat-notice">
                                  <span>
                                    {workspaceIndexStatus.state === 'indexing'
                                      ? 'Indexing…'
                                      : workspaceIndexStatus.state === 'stale'
                                        ? 'Index is out of date.'
                                        : workspaceIndexStatus.state === 'never'
                                          ? 'Not indexed yet — showing files from the folder walk.'
                                          : 'Indexing is disabled — showing files from the folder walk.'}
                                  </span>
                                  {(workspaceIndexStatus.state === 'stale' ||
                                    workspaceIndexStatus.state === 'never') && (
                                    <button
                                      type="button"
                                      className="file-flat-notice-action"
                                      onClick={() =>
                                        void api
                                          .refreshProjectIndex(selected.id)
                                          .then((res) => setWorkspaceIndexStatus(res.status))
                                          .catch(() => {})
                                      }
                                    >
                                      Index now
                                    </button>
                                  )}
                                </div>
                              )}
                            {(activeViewMode === 'flat-issues' ||
                              activeViewMode === 'flat-criticality') && (
                              <div className="file-flat-notice">
                                <span>
                                  {workspaceIssues
                                    ? `${workspaceIssues.reviewedFiles} of ${workspaceIssues.eligibleFiles} eligible files reviewed${workspaceIssues.truncated ? ' — showing the first 1000 issues' : ''}`
                                    : 'Loading review coverage…'}
                                </span>
                                {(workspaceIndexStatus?.state === 'stale' ||
                                  workspaceIndexStatus?.state === 'never') && (
                                  <button
                                    type="button"
                                    className="file-flat-notice-action"
                                    onClick={() =>
                                      void api
                                        .refreshProjectIndex(selected.id)
                                        .then((res) => setWorkspaceIndexStatus(res.status))
                                        .catch(() => {})
                                    }
                                  >
                                    Index now
                                  </button>
                                )}
                              </div>
                            )}
                          </>
                        ) : undefined
                      }
                      extraPane={
                        fileTab === 'workspace' && workspaceIndexPaneOpen ? (
                          <WorkspaceIndexPane
                            path={workspaceReviewPath}
                            status={workspaceIndexStatus}
                            issues={workspaceIssues}
                            review={workspaceReview}
                            loading={workspaceReviewLoading}
                            error={workspaceReviewError}
                            onClose={() => setWorkspaceIndexPaneOpen(false)}
                            onSelectLine={(line) => {
                              if (!workspaceReviewPath) return;
                              setWorkspaceSourceReveal((current) => ({
                                path: workspaceReviewPath,
                                line,
                                requestId: (current?.requestId ?? 0) + 1,
                              }));
                            }}
                            // No writability gate: a fix is drafted as a
                            // change proposal the user applies, so this works
                            // on a read-only folder too — the case that needs
                            // it most.
                            onFixIssue={(issue) => {
                              if (workspaceReviewPath) {
                                setWorkspaceIssueFixRequest({
                                  path: workspaceReviewPath,
                                  issue,
                                });
                              }
                            }}
                            onUpdateIssue={updateWorkspaceIssue}
                            onOpenTask={(taskRef) => navigateToTab({ kind: 'task', ref: taskRef })}
                          />
                        ) : undefined
                      }
                      viewer={
                        openFile ? (
                          openFile.outsideIn ? (
                            <ProjectOutsideInEditor
                              key={`${openFile.source}:${openFile.path}`}
                              projectId={selected.id}
                              file={openFile}
                              outsideIn={openFile.outsideIn}
                              isReadOnly={isReadOnly}
                              editorTheme={editorTheme}
                              onChange={handleEditorContentChange}
                              onSave={saveArtifact}
                              toolbarIndexToggle={workspaceIndexToggle}
                            />
                          ) : NON_TEXT_CONTENT.has(openFile.content) ? (
                            <>
                              <NonTextFilePreview
                                content={openFile.content}
                                path={openFile.path}
                                fetchBlob={fileSource.fetchBlob}
                                {...(openFile.size === undefined
                                  ? {}
                                  : { sizeBytes: openFile.size })}
                              />
                              {openFile.content === MEDIA_IMAGE &&
                                openFile.source === 'workspace' && (
                                  <FindSimilarImages
                                    key={openFile.path}
                                    projectId={selected.id}
                                    path={openFile.path}
                                    fetchBlob={fileSource.fetchBlob}
                                    onOpen={(p) => void focusFile(selected.id, p, 'workspace')}
                                  />
                                )}
                            </>
                          ) : isHtml(openFile.path) ? (
                            <HtmlFileViewer
                              projectId={selected.id}
                              file={openFile}
                              isReadOnly={isReadOnly}
                              editorTheme={editorTheme}
                              onEditorChange={handleEditorContentChange}
                              onSave={saveArtifact}
                              onComplainAboutPreviewError={complainAboutPreviewError}
                              toolbarIndexToggle={workspaceIndexToggle}
                              sourceReveal={activeWorkspaceSourceReveal}
                            />
                          ) : (
                            <ProjectFileEditor
                              key={`${openFile.source}:${openFile.path}`}
                              projectId={selected.id}
                              file={openFile}
                              isReadOnly={isReadOnly}
                              editorTheme={editorTheme}
                              onChange={handleEditorContentChange}
                              onSave={saveArtifact}
                              toolbarIndexToggle={workspaceIndexToggle}
                            />
                          )
                        ) : (
                          <p className="placeholder" style={{ padding: '2rem' }}>
                            Select a file from the tree to view or edit it.
                          </p>
                        )
                      }
                    />
                  )}

                  {tab === 'chat' && (
                    <ProjectPaneBoundary>
                      <ProjectChat
                        key={selected.id}
                        project={selected}
                        compact={effectiveCompact}
                      />
                    </ProjectPaneBoundary>
                  )}

                  {tab === 'tasks' && (
                    <ProjectPaneBoundary>
                      <TasksView projectId={selected.id} />
                    </ProjectPaneBoundary>
                  )}

                  {tab === 'proposals' && (
                    <ProjectPaneBoundary>
                      <DiffpackReviewView projectId={selected.id} />
                    </ProjectPaneBoundary>
                  )}

                  {tab === 'github' && selected.github?.url && (
                    <ProjectPaneBoundary>
                      <ProjectGitHubView project={selected} onProjectChange={setSelected} />
                    </ProjectPaneBoundary>
                  )}

                  {showWorkInProgressFeatures && tab === 'mail' && (
                    <ProjectPaneBoundary>
                      <ProjectMailTab project={selected} onProjectChange={setSelected} />
                    </ProjectPaneBoundary>
                  )}

                  {tab === 'map' && (
                    <ProjectPaneBoundary>
                      <FileMapView projectId={selected.id} />
                    </ProjectPaneBoundary>
                  )}
                  {tab === 'overview' && (
                    <ProjectPaneBoundary>
                      <ProjectOverviewView projectId={selected.id} project={selected} />
                    </ProjectPaneBoundary>
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
              managedWorkspaceWritable={workspaceAccess.managedWritable}
              onManagedWorkspaceWritesChange={(next) => {
                // Enabling writes on a user-supplied external dir prompts the
                // same confirmation the Settings checkbox uses; everything
                // else flips directly.
                if (next && selected.workingDir) {
                  setShowAllowWritesConfirm(true);
                } else {
                  void saveManagedWorkspaceWrites(next);
                }
              }}
              codexMode={workspaceAccess.codexInUse ? effectiveCodexMode : undefined}
              onCodexModeChange={workspaceAccess.codexInUse ? saveCodexPermissionMode : undefined}
              claudeMode={workspaceAccess.claudeInUse ? workspaceAccess.claudeMode : undefined}
              onClaudeModeChange={
                workspaceAccess.claudeInUse ? saveClaudePermissionMode : undefined
              }
              onOpenGitHub={selected.github?.url ? () => setTab('github') : undefined}
              onAddBoekwachter={
                boekwachterGezelId ? () => addProjectGezel(boekwachterGezelId) : undefined
              }
              status={selected.status ?? 'active'}
              statusLocked={selected.archived === true}
              onStatusChange={async (v) => {
                const updated = await api.updateProject(selected.id, { status: v });
                setSelected(updated);
              }}
            />
          </>
        ) : (
          <ProjectPanePlaceholder />
        )}
      </section>
    </div>
  );
}

/** Switch to source, select an indexed issue's anchored line, and center it. */
function WorkspaceSourceLineReveal({
  request,
}: {
  request: WorkspaceSourceRevealRequest | null;
}) {
  const { activeView, setActiveView, monacoEditor } = useEditorContext();
  useEffect(() => {
    if (!request) return;
    if (activeView !== 'raw') {
      setActiveView('raw');
      return;
    }
    if (!monacoEditor) return;
    const model = monacoEditor.getModel();
    if (!model) return;
    const lineNumber = Math.max(1, Math.min(request.line, model.getLineCount()));
    monacoEditor.setSelection({
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: model.getLineMaxColumn(lineNumber),
    });
    monacoEditor.revealLineInCenter(lineNumber);
    monacoEditor.focus();
  }, [activeView, monacoEditor, request, setActiveView]);
  return null;
}

/** Editor for a rendered document's editable Markdown companion. */
function ProjectOutsideInEditor({
  projectId,
  file,
  outsideIn,
  isReadOnly,
  editorTheme,
  onChange,
  onSave,
  toolbarIndexToggle,
}: {
  projectId: string;
  file: {
    path: string;
    content: string;
    source: FileTab;
  };
  outsideIn: OutsideInOpenFile;
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onChange: (source: string) => void;
  onSave: (content?: string) => void | Promise<void>;
  toolbarIndexToggle?: ReactNode;
}) {
  const { layout, sourcePath } = outsideIn;
  const autosave = useSerializedAutosave({
    resourceKey: `outside-in:${projectId}:${file.source}:${sourcePath}`,
    initialValue: normalizeMarkdownBaseline(file.content),
    save: async (content) => {
      await onSave(content);
    },
  });
  const handleChange = useCallback(
    (content: string) => {
      onChange(content);
      autosave.update(content);
    },
    [autosave.update, onChange],
  );
  const container = useMemo(
    () =>
      createProjectContentContainer({
        projectId,
        root: layout.companionDirectory,
        client: api,
        primaryDocumentFilename: basenameOf(sourcePath),
        source: file.source,
      }),
    [file.source, layout.companionDirectory, projectId, sourcePath],
  );
  const versionBasename = useMemo(() => documentVersionBasename(sourcePath), [sourcePath]);
  const versionContainer = useMemo(
    () => createVersionCompatibleContentContainer(container, versionBasename),
    [container, versionBasename],
  );
  const documentLinkProvider = useMemo(
    () =>
      file.source === 'artifacts'
        ? createDocumentLinkProvider({
            client: api,
            currentDocumentPath: sourcePath,
            source: 'project-artifacts',
            projectId,
          })
        : undefined,
    [file.source, projectId, sourcePath],
  );
  return (
    <div className="editor-wrap" style={{ height: '100%' }}>
      <EditorShell
        initialMarkdown={autosave.desiredValue()}
        fileName={file.path}
        readOnly={isReadOnly}
        onChange={isReadOnly ? undefined : handleChange}
        height="100%"
        colorScheme={editorTheme}
        fullWidth
        workspaceContainer={versionContainer}
        documentLinkProvider={documentLinkProvider}
        calcEngineFactory={isReadOnly ? undefined : ironCalcEngineFactory}
        allowVersioning={!isReadOnly}
        versionBasename={versionBasename}
        outline
        toolbarSlotAfterActions={
          <>
            {!isReadOnly && <TransformToolbarButton context="generic" />}
            <DocumentNarration fileName={file.path} projectId={projectId} />
          </>
        }
        toolbarSlotRight={
          <>
            {toolbarIndexToggle}
            {!isReadOnly && <AutosaveStatus autosave={autosave} />}
            {!isReadOnly && (
              <button
                type="button"
                onClick={() => void autosave.flush()}
                style={{ marginLeft: '0.5rem' }}
              >
                Save {layout.format.toUpperCase()}
              </button>
            )}
            {file.source === 'artifacts' && (
              <ExportToolbarControls
                selectedFile={file.path}
                mediaContainer={container}
                mediaSource={{ kind: 'project-artifacts', projectId }}
              />
            )}
          </>
        }
      />
    </div>
  );
}

/**
 * The text editor for any project file that isn't a rendered document or an
 * HTML page. Markdown artifacts get the full squisq feature set — the Files
 * panel for image uploads (writes land in the document's hidden companion), the
 * DocBlocks-style Export menu, version history, a sibling-artifact link
 * picker, and the report-action fence renderers that mount recommendation
 * blocks as live cards. Workspace files (code) and non-markdown artifacts
 * keep the plain shell: the squisq concepts (themes, playback, exporting to
 * PowerPoint) only make sense for prose.
 *
 * Both autosave. Edits land through the same serialized lane the documents
 * library uses, so a rename or delete can flush an in-flight draft rather
 * than race it, and the status bar carries the dirty indicator instead of a
 * Save button.
 */
function ProjectFileEditor({
  projectId,
  file,
  isReadOnly,
  editorTheme,
  onChange,
  onSave,
  toolbarIndexToggle,
}: {
  projectId: string;
  file: { path: string; content: string; source: FileTab };
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onChange: (source: string) => void;
  onSave: (content?: string) => void | Promise<void>;
  toolbarIndexToggle?: ReactNode;
}) {
  const markdown = isMarkdown(file.path) && file.source === 'artifacts';
  const { root, parentDirectory, companionName, primaryDocumentFilename } = useMemo(
    () => deriveContainerScope(file.path),
    [file.path],
  );
  const versionBasename = useMemo(() => documentVersionBasename(file.path), [file.path]);
  const autosave = useSerializedAutosave({
    resourceKey: `file:${file.source}:${file.path}`,
    initialValue: markdown ? normalizeMarkdownBaseline(file.content) : file.content,
    save: async (content) => {
      await onSave(content);
    },
  });
  const handleChange = useCallback(
    (content: string) => {
      onChange(content);
      autosave.update(content);
    },
    [autosave.update, onChange],
  );
  const container = useMemo(
    () =>
      markdown
        ? createArtifactsContentContainer({
            projectId,
            root,
            client: api,
            referencePrefix: companionName,
          })
        : null,
    [companionName, markdown, projectId, root],
  );
  const exportContainer = useMemo(
    () =>
      markdown
        ? createArtifactsContentContainer({
            projectId,
            root: parentDirectory,
            client: api,
            primaryDocumentFilename,
          })
        : null,
    [markdown, parentDirectory, primaryDocumentFilename, projectId],
  );
  const mediaProvider = useMemo(
    () =>
      container && exportContainer
        ? createDocumentMediaProvider(container, companionName, exportContainer)
        : null,
    [companionName, container, exportContainer],
  );
  const versionContainer = useMemo(
    () =>
      container && exportContainer
        ? createVersionCompatibleContentContainer(
            container,
            versionBasename,
            [
              {
                container: exportContainer,
                basenames: [primaryDocumentFilename, versionBasename],
              },
            ],
            exportContainer,
          )
        : null,
    [container, exportContainer, primaryDocumentFilename, versionBasename],
  );
  useEffect(() => () => mediaProvider?.dispose(), [mediaProvider]);
  const documentLinkProvider = useMemo(
    () =>
      markdown
        ? createDocumentLinkProvider({
            client: api,
            currentDocumentPath: file.path,
            source: 'project-artifacts',
            projectId,
          })
        : null,
    [markdown, projectId, file.path],
  );
  // Reports may embed gezel-action recommendation blocks — register the
  // fence renderer so they mount as live, fireable cards INSIDE the
  // editor (instead of Monaco code insets).
  const fenceRenderers = useMemo(
    () =>
      markdown ? makeReportActionFenceRenderers({ projectId, reportPath: file.path }) : undefined,
    [markdown, projectId, file.path],
  );
  return (
    <div className="editor-wrap" style={{ height: '100%' }}>
      <EditorShell
        initialMarkdown={autosave.desiredValue()}
        fileName={file.path}
        readOnly={isReadOnly}
        onChange={isReadOnly ? undefined : handleChange}
        height="100%"
        colorScheme={editorTheme}
        fullWidth
        showPlayTab={markdown}
        workspaceContainer={versionContainer}
        mediaProvider={mediaProvider}
        documentLinkProvider={documentLinkProvider}
        fenceRenderers={fenceRenderers}
        calcEngineFactory={markdown && !isReadOnly ? ironCalcEngineFactory : undefined}
        allowVersioning={markdown && !isReadOnly}
        versionBasename={versionBasename}
        outline={markdown}
        toolbarSlotAfterActions={
          markdown ? (
            <>
              {!isReadOnly && <TransformToolbarButton context="generic" />}
              <DocumentNarration fileName={file.path} projectId={projectId} />
            </>
          ) : undefined
        }
        toolbarSlotRight={
          <>
            {toolbarIndexToggle}
            {markdown && exportContainer && (
              <ExportToolbarControls
                selectedFile={file.path}
                mediaContainer={exportContainer}
                mediaSource={{ kind: 'project-artifacts', projectId }}
              />
            )}
          </>
        }
        statusBarSlotRight={!isReadOnly ? <AutosaveStatus autosave={autosave} /> : undefined}
      />
    </div>
  );
}
/**
 * Preview/source viewer for `.html` files. An indexed line selection moves
 * the viewer to Source before the shared editor bridge reveals the anchor.
 */
function HtmlFileViewer({
  projectId,
  file,
  isReadOnly,
  editorTheme,
  onEditorChange,
  onSave,
  onComplainAboutPreviewError,
  toolbarIndexToggle,
  sourceReveal,
}: {
  projectId: string;
  file: { path: string; content: string; source: FileTab };
  isReadOnly: boolean;
  editorTheme: 'light' | 'dark';
  onEditorChange: (source: string) => void;
  onSave: (content?: string) => void | Promise<void>;
  toolbarIndexToggle?: ReactNode;
  sourceReveal?: WorkspaceSourceRevealRequest | null;
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

  useEffect(() => {
    if (sourceReveal?.path === file.path) setMode('source');
  }, [file.path, sourceReveal]);

  // Same autosave lane as every other project file — the Source tab edits the
  // page the Preview tab renders, so a Save button here would be the one place
  // an edit could sit unsaved while the preview claims to show the file.
  const sourceAutosave = useSerializedAutosave({
    resourceKey: `file:${file.source}:${file.path}`,
    initialValue: file.content,
    save: async (content) => {
      await onSave(content);
    },
  });
  const handleSourceChange = useCallback(
    (content: string) => {
      onEditorChange(content);
      sourceAutosave.update(content);
    },
    [onEditorChange, sourceAutosave.update],
  );

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
            initialMarkdown={sourceAutosave.desiredValue()}
            fileName={file.path}
            onChange={isReadOnly ? undefined : handleSourceChange}
            height="100%"
            colorScheme={editorTheme}
            showPlayTab={false}
            fullWidth
            toolbarSlotRight={toolbarIndexToggle}
            statusBarSlotRight={
              !isReadOnly ? <AutosaveStatus autosave={sourceAutosave} /> : undefined
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

/**
 * Per-project markdown editor for `about` / `missionObjectives`. Uses Squisq
 * for consistency with the rest of the markdown editing surface, with the
 * same debounced auto-save pattern as the gezel about.md flow.
 */
function ProjectDocEditor({
  projectId,
  resourceKey,
  id,
  label,
  hint,
  initial,
  onSave,
}: {
  projectId: string;
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
          toolbarSlotAfterActions={
            <>
              <TransformToolbarButton context="generic" />
              <DocumentNarration fileName={`${label}.md`} projectId={projectId} />
            </>
          }
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
