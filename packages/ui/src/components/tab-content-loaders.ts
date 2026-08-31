import type { RecentTab } from '@bendyline/gezel';

// Keep this module limited to dynamic-import edges. App and Sidebar may import
// it eagerly without pulling any destination implementation into the shell.
export const loadHomeViewModule = () => import('../views/HomeView.js');
export const loadBenchmarksViewModule = () => import('../views/BenchmarksView.js');
export const loadCraftbookScriptEditorViewModule = () =>
  import('../views/CraftbookScriptEditorView.js');
export const loadCraftbookTabContentModule = () => import('../views/CraftbookTabContent.js');
export const loadCraftbooksViewModule = () => import('../views/CraftbooksView.js');
export const loadDocumentDetailModule = () => import('../views/DocumentDetail.js');
export const loadDocumentsViewModule = () => import('../views/DocumentsView.js');
export const loadGezelDetailModule = () => import('../views/GezelDetail.js');
export const loadGezellenViewModule = () => import('../views/GezellenView.js');
export const loadHandboekViewModule = () => import('../views/HandboekView.js');
export const loadHistoryViewModule = () => import('../views/HistoryView.js');
export const loadKnowledgeViewModule = () => import('../views/KnowledgeView.js');
export const loadProjectsViewModule = () => import('../views/ProjectsView.js');
export const loadScriptEditorViewModule = () => import('../views/ScriptEditorView.js');
export const loadScriptsViewModule = () => import('../views/ScriptsView.js');
export const loadSettingsViewModule = () => import('../views/SettingsView.js');
export const loadTaskTabContentModule = () => import('../views/TaskTabContent.js');
export const loadTasksViewModule = () => import('../views/TasksView.js');

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
          return loadHandboekViewModule();
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
