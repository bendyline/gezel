import type { RecentTab } from '@bendyline/gezel';
import { api } from '../api.js';
import { peekRead } from '../data/api-reads.js';
import type { ReadName } from '../data/reads.js';

/**
 * Every place the main pane can show, in one table: the code it renders, the
 * reads it paints from, the frame that holds its place while its code loads,
 * and whether it stays mounted when hidden. Navigation (App's
 * commitSelection), the rail's hover warm-up and the keep-alive host all read
 * it, so a new destination is added here and nowhere else.
 *
 * App and Sidebar import this module eagerly; it holds only dynamic import
 * edges and read warmers, never a destination's implementation.
 */

/**
 * Styles for surfaces the shell never draws (../surfaces.css). Every
 * destination waits for them beside its module, which keeps them off the
 * startup path without a view ever rendering unstyled.
 */
const loadSurfaceStyles = () => import('../surfaces.css');

function destination<T>(load: () => Promise<T>): () => Promise<T> {
  return () => Promise.all([load(), loadSurfaceStyles()]).then(([module]) => module);
}

export const loadHomeViewModule = destination(() => import('../views/HomeView.js'));
export const loadBenchmarksViewModule = destination(() => import('../views/BenchmarksView.js'));
export const loadCraftbookScriptEditorViewModule = destination(
  () => import('../views/CraftbookScriptEditorView.js'),
);
export const loadCraftbookTabContentModule = destination(
  () => import('../views/CraftbookTabContent.js'),
);
export const loadCraftbooksViewModule = destination(() => import('../views/CraftbooksView.js'));
export const loadDocumentDetailModule = destination(() => import('../views/DocumentDetail.js'));
export const loadDocumentsViewModule = destination(() => import('../views/DocumentsView.js'));
export const loadGezelDetailModule = destination(() => import('../views/GezelDetail.js'));
export const loadGezellenViewModule = destination(() => import('../views/GezellenView.js'));
export const loadHistoryViewModule = destination(() => import('../views/HistoryView.js'));
export const loadKnowledgeViewModule = destination(() => import('../views/KnowledgeView.js'));
export const loadProjectsViewModule = destination(() => import('../views/ProjectsView.js'));
export const loadScriptEditorViewModule = destination(() => import('../views/ScriptEditorView.js'));
export const loadScriptsViewModule = destination(() => import('../views/ScriptsView.js'));
export const loadSettingsViewModule = destination(() => import('../views/SettingsView.js'));
export const loadTaskTabContentModule = destination(() => import('../views/TaskTabContent.js'));
export const loadTasksViewModule = destination(() => import('../views/TasksView.js'));

/** The wordless frame a destination shows while its code loads for the first time. */
export type PaneFrameKind = 'home' | 'list' | 'detail' | 'project' | 'editor' | 'settings';

/** A read a destination paints from, as `[name, ...args]`. */
type CriticalRead = { [K in ReadName]: [K, ...Parameters<(typeof api)[K]>] }[ReadName];

export interface Destination {
  /** Stable identity for keep-alive and timing: one per tab, not per kind. */
  key: string;
  load: () => Promise<unknown>;
  /** Reads the first frame should paint from, started at hover and at click. */
  reads: CriticalRead[];
  frame: PaneFrameKind;
  /**
   * Stays mounted while hidden, so returning is instant with its state and
   * scroll. Editors and Settings never are: their unsaved state and timers
   * belong to the visit.
   */
  keepAlive: boolean;
}

const BASE_READS: CriticalRead[] = [['getConfig'], ['listGezels']];

export function destinationFor(tab: RecentTab | null): Destination {
  if (!tab) {
    return {
      key: 'home',
      load: loadHomeViewModule,
      reads: [...BASE_READS, ['listProjects'], ['getSystemHomeInfo']],
      frame: 'home',
      keepAlive: true,
    };
  }
  switch (tab.kind) {
    case 'project':
      return {
        key: `project:${tab.id}`,
        load: loadProjectsViewModule,
        reads: [
          ...BASE_READS,
          ['listProjects'],
          ['getProject', tab.id],
          ['listChatSessions', { projectId: tab.id }],
        ],
        frame: 'project',
        keepAlive: true,
      };
    case 'gezel':
      return {
        key: `gezel:${tab.id}`,
        load: loadGezelDetailModule,
        reads: BASE_READS,
        frame: 'detail',
        keepAlive: true,
      };
    case 'document':
      return {
        key: `document:${tab.path}`,
        load: loadDocumentDetailModule,
        reads: BASE_READS,
        frame: 'editor',
        keepAlive: false,
      };
    case 'task':
      return {
        key: `task:${tab.ref}`,
        load: loadTaskTabContentModule,
        reads: BASE_READS,
        frame: 'detail',
        keepAlive: true,
      };
    case 'script':
      return {
        key: `script:${tab.projectId}:${tab.scope}:${tab.name}`,
        load: loadScriptEditorViewModule,
        reads: BASE_READS,
        frame: 'editor',
        keepAlive: false,
      };
    case 'craftbook':
      return {
        key: `craftbook:${tab.source}:${tab.id}`,
        load: loadCraftbookTabContentModule,
        reads: BASE_READS,
        frame: 'detail',
        keepAlive: false,
      };
    case 'craftbook-script':
      return {
        key: `craftbook-script:${tab.craftbookId}:${tab.name}`,
        load: loadCraftbookScriptEditorViewModule,
        reads: BASE_READS,
        frame: 'editor',
        keepAlive: false,
      };
    case 'area':
      return areaDestination(tab.area);
  }
}

function areaDestination(area: Extract<RecentTab, { kind: 'area' }>['area']): Destination {
  const key = `area:${area}`;
  switch (area) {
    case 'projects':
      return {
        key,
        load: loadProjectsViewModule,
        reads: [...BASE_READS, ['listProjects']],
        frame: 'list',
        keepAlive: true,
      };
    case 'gezels':
      return {
        key,
        load: loadGezellenViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: true,
      };
    case 'documents':
      return {
        key,
        load: loadDocumentsViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: true,
      };
    case 'tasks':
      return { key, load: loadTasksViewModule, reads: BASE_READS, frame: 'list', keepAlive: true };
    case 'craftbooks':
      return {
        key,
        load: loadCraftbooksViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: true,
      };
    case 'scripts':
      return {
        key,
        load: loadScriptsViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: false,
      };
    case 'history':
      return {
        key,
        load: loadHistoryViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: true,
      };
    case 'handboek':
    case 'knowledge':
      return {
        key,
        load: loadKnowledgeViewModule,
        reads: BASE_READS,
        frame: 'list',
        keepAlive: true,
      };
    case 'benchmarks':
      return {
        key,
        load: () => Promise.all([loadBenchmarksViewModule(), loadSettingsViewModule()]),
        reads: BASE_READS,
        frame: 'settings',
        keepAlive: false,
      };
    case 'settings':
      return {
        key,
        load: loadSettingsViewModule,
        reads: BASE_READS,
        frame: 'settings',
        keepAlive: false,
      };
  }
}

function startRead([name, ...args]: CriticalRead): Promise<unknown> {
  const method = api[name] as (...a: unknown[]) => Promise<unknown>;
  return method.apply(api, args);
}

/** Whether every read a destination paints from already has an answer in memory. */
export function readsAreKnown(target: Destination): boolean {
  return target.reads.every(
    ([name, ...args]) =>
      (peekRead as (n: ReadName, ...a: unknown[]) => unknown)(name, ...args) !== undefined,
  );
}

/** Start a destination's code and reads together. Settles when all have, failures included. */
export function prepareDestination(target: Destination): Promise<void> {
  return Promise.allSettled([target.load(), ...target.reads.map(startRead)]).then(() => undefined);
}

/**
 * Warm a destination after hover/focus/pointer-down. Dynamic imports are
 * module-cached by the browser, so React.lazy reuses the fulfilled module when
 * navigation follows. Rejections are deliberately left for the real
 * navigation boundary, where TabErrorBoundary can present recovery UI.
 */
export function preloadTabContent(tab: RecentTab): void {
  void prepareDestination(destinationFor(tab));
}

/** Start the reads a destination paints from, without its code. */
export function preloadTabData(tab: RecentTab | null): void {
  void Promise.allSettled(destinationFor(tab).reads.map(startRead));
}
