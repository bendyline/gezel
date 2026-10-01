import type { RecentTab } from '@bendyline/gezel';

// Keep this module limited to dynamic-import edges. App and Sidebar may import
// it eagerly without pulling any destination implementation into the shell.

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

function moduleForTab(tab: RecentTab): Promise<unknown> {
  switch (tab.kind) {
    case 'project':
      return loadProjectsViewModule();
    case 'gezel':
      return loadGezelDetailModule();
    case 'document':
      return loadDocumentDetailModule();
    case 'task':
      return loadTaskTabContentModule();
    case 'script':
      return loadScriptEditorViewModule();
    case 'craftbook':
      return loadCraftbookTabContentModule();
    case 'craftbook-script':
      return loadCraftbookScriptEditorViewModule();
    case 'area':
      switch (tab.area) {
        case 'projects':
          return loadProjectsViewModule();
        case 'gezels':
          return loadGezellenViewModule();
        case 'documents':
          return loadDocumentsViewModule();
        case 'tasks':
          return loadTasksViewModule();
        case 'craftbooks':
          return loadCraftbooksViewModule();
        case 'scripts':
          return loadScriptsViewModule();
        case 'history':
          return loadHistoryViewModule();
        case 'handboek':
          return loadKnowledgeViewModule();
        case 'knowledge':
          return loadKnowledgeViewModule();
        case 'benchmarks':
          return Promise.all([loadBenchmarksViewModule(), loadSettingsViewModule()]);
        case 'settings':
          return loadSettingsViewModule();
      }
  }
}

/**
 * Warm a destination after hover/focus/pointer-down. Dynamic imports are
 * module-cached by the browser, so React.lazy reuses the fulfilled module when
 * navigation follows. Rejections are deliberately left for the real
 * navigation boundary, where TabErrorBoundary can present recovery UI.
 */
export function preloadTabContent(tab: RecentTab): void {
  void moduleForTab(tab).catch(() => {});
}
