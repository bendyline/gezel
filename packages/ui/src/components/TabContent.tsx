import type { RecentTab } from '@bendyline/gezel';
import { lazy } from 'react';
import {
  loadBenchmarksViewModule,
  loadCraftbookScriptEditorViewModule,
  loadCraftbookTabContentModule,
  loadCraftbooksViewModule,
  loadDocumentDetailModule,
  loadDocumentsViewModule,
  loadGezelDetailModule,
  loadGezellenViewModule,
  loadHandboekViewModule,
  loadHistoryViewModule,
  loadKnowledgeViewModule,
  loadProjectsViewModule,
  loadScriptEditorViewModule,
  loadScriptsViewModule,
  loadSettingsViewModule,
  loadTaskTabContentModule,
  loadTasksViewModule,
} from './tab-content-loaders.js';
import { useDebugMode } from './useDebugMode.js';

const BenchmarksView = lazy(() =>
  loadBenchmarksViewModule().then(({ BenchmarksView }) => ({ default: BenchmarksView })),
);
const CraftbookScriptEditorView = lazy(() =>
  loadCraftbookScriptEditorViewModule().then(({ CraftbookScriptEditorView }) => ({
    default: CraftbookScriptEditorView,
  })),
);
const CraftbookTabContent = lazy(() =>
  loadCraftbookTabContentModule().then(({ CraftbookTabContent }) => ({
    default: CraftbookTabContent,
  })),
);
const CraftbooksView = lazy(() =>
  loadCraftbooksViewModule().then(({ CraftbooksView }) => ({ default: CraftbooksView })),
);
const DocumentDetail = lazy(() =>
  loadDocumentDetailModule().then(({ DocumentDetail }) => ({ default: DocumentDetail })),
);
const DocumentsView = lazy(() =>
  loadDocumentsViewModule().then(({ DocumentsView }) => ({ default: DocumentsView })),
);
const GezelDetail = lazy(() =>
  loadGezelDetailModule().then(({ GezelDetail }) => ({ default: GezelDetail })),
);
const GezellenView = lazy(() =>
  loadGezellenViewModule().then(({ GezellenView }) => ({ default: GezellenView })),
);
const HandboekView = lazy(() =>
  loadHandboekViewModule().then(({ HandboekView }) => ({ default: HandboekView })),
);
const HistoryView = lazy(() =>
  loadHistoryViewModule().then(({ HistoryView }) => ({ default: HistoryView })),
);
const KnowledgeView = lazy(() =>
  loadKnowledgeViewModule().then(({ KnowledgeView }) => ({ default: KnowledgeView })),
);
const ProjectDetailView = lazy(() =>
  loadProjectsViewModule().then(({ ProjectDetailView }) => ({ default: ProjectDetailView })),
);
const ProjectsView = lazy(() =>
  loadProjectsViewModule().then(({ ProjectsView }) => ({ default: ProjectsView })),
);
const ScriptEditorView = lazy(() =>
  loadScriptEditorViewModule().then(({ ScriptEditorView }) => ({ default: ScriptEditorView })),
);
const ScriptsView = lazy(() =>
  loadScriptsViewModule().then(({ ScriptsView }) => ({ default: ScriptsView })),
);
const SettingsView = lazy(() =>
  loadSettingsViewModule().then(({ SettingsView }) => ({ default: SettingsView })),
);
const TaskTabContent = lazy(() =>
  loadTaskTabContentModule().then(({ TaskTabContent }) => ({ default: TaskTabContent })),
);
const TasksView = lazy(() =>
  loadTasksViewModule().then(({ TasksView }) => ({ default: TasksView })),
);

interface TabContentProps {
  tab: RecentTab;
  activeProjectsByGezel?: ReadonlyMap<string, ReadonlySet<string>>;
  activeTurnsReady?: boolean;
}

export function TabContent({ tab, activeProjectsByGezel, activeTurnsReady }: TabContentProps) {
  const debugMode = useDebugMode();
  switch (tab.kind) {
    case 'project':
      return <ProjectDetailView projectId={tab.id} />;
    case 'gezel':
      return (
        <GezelDetail
          gezelId={tab.id}
          workingProjectIds={activeProjectsByGezel?.get(tab.id)}
          activeTurnsReady={activeTurnsReady}
        />
      );
    case 'document':
      return <DocumentDetail path={tab.path} />;
    case 'task':
      return <TaskTabContent taskRef={tab.ref} />;
    case 'script':
      return <ScriptEditorView projectId={tab.projectId} scriptName={tab.name} scope={tab.scope} />;
    case 'craftbook':
      return <CraftbookTabContent craftbookId={tab.id} source={tab.source} />;
    case 'craftbook-script':
      return <CraftbookScriptEditorView craftbookId={tab.craftbookId} scriptName={tab.name} />;
    case 'area':
      switch (tab.area) {
        case 'projects':
          return <ProjectsView />;
        case 'gezels':
          return (
            <GezellenView
              activeProjectsByGezel={activeProjectsByGezel}
              activeTurnsReady={activeTurnsReady}
            />
          );
        case 'documents':
          return <DocumentsView />;
        case 'tasks':
          return <TasksView />;
        case 'craftbooks':
          return <CraftbooksView />;
        case 'scripts':
          return <ScriptsView />;
        case 'history':
          return <HistoryView />;
        case 'handboek':
          return <HandboekView />;
        case 'knowledge':
          // The view itself renders an install pointer when no catalog is
          // registered (a restored selection can outlive the last catalog),
          // so no gate is needed here the way benchmarks needs one.
          return <KnowledgeView />;
        case 'benchmarks':
          // Developer surface, not a shipped one: unstyled selects, inline
          // hex colours, and a runner that cannot execute in a packaged
          // install. Settings hides its tab behind debugMode, but this route
          // had no gate, so a restored selection from before it moved could
          // drop an ordinary user straight onto the raw panel.
          return debugMode ? <BenchmarksView /> : <SettingsView />;
        case 'settings':
          return <SettingsView />;
      }
  }
}
