import type { RecentTab } from '@bendyline/gezel';
import { lazy } from 'react';
import { BenchmarksView } from '../views/BenchmarksView.js';
import { CraftbookScriptEditorView } from '../views/CraftbookScriptEditorView.js';
import { CraftbookTabContent } from '../views/CraftbookTabContent.js';
import { CraftbooksView } from '../views/CraftbooksView.js';
import { DocumentDetail } from '../views/DocumentDetail.js';
import { DocumentsView } from '../views/DocumentsView.js';
import { GezelDetail } from '../views/GezelDetail.js';
import { GezellenView } from '../views/GezellenView.js';
import { HistoryView } from '../views/HistoryView.js';
import { ProjectDetailView, ProjectsView } from '../views/ProjectsView.js';
import { ScriptEditorView } from '../views/ScriptEditorView.js';
import { ScriptsView } from '../views/ScriptsView.js';
import { SettingsView } from '../views/SettingsView.js';
import { TaskTabContent } from '../views/TaskTabContent.js';
import { TasksView } from '../views/TasksView.js';
import { useDebugMode } from './useDebugMode.js';

const HandboekView = lazy(() =>
  import('../views/HandboekView.js').then(({ HandboekView }) => ({ default: HandboekView })),
);

// Lazy for the same reason as Handboek: the reader pane pulls in squisq.
const KnowledgeView = lazy(() =>
  import('../views/KnowledgeView.js').then(({ KnowledgeView }) => ({ default: KnowledgeView })),
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
