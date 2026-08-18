import type { RecentTab } from '@bendyline/gezel';
import { BenchmarksView } from '../views/BenchmarksView.js';
import { CraftbookScriptEditorView } from '../views/CraftbookScriptEditorView.js';
import { CraftbookTabContent } from '../views/CraftbookTabContent.js';
import { CraftbooksView } from '../views/CraftbooksView.js';
import { DocumentDetail } from '../views/DocumentDetail.js';
import { DocumentsView } from '../views/DocumentsView.js';
import { GezelDetail } from '../views/GezelDetail.js';
import { GezellenView } from '../views/GezellenView.js';
import { HandboekView } from '../views/HandboekView.js';
import { HistoryView } from '../views/HistoryView.js';
import { ProjectDetailView, ProjectsView } from '../views/ProjectsView.js';
import { ScriptEditorView } from '../views/ScriptEditorView.js';
import { ScriptsView } from '../views/ScriptsView.js';
import { SettingsView } from '../views/SettingsView.js';
import { TaskTabContent } from '../views/TaskTabContent.js';
import { TasksView } from '../views/TasksView.js';

interface TabContentProps {
  tab: RecentTab;
  activeProjectsByGezel?: ReadonlyMap<string, ReadonlySet<string>>;
  activeTurnsReady?: boolean;
}

export function TabContent({ tab, activeProjectsByGezel, activeTurnsReady }: TabContentProps) {
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
        case 'benchmarks':
          return <BenchmarksView />;
        case 'settings':
          return <SettingsView />;
      }
  }
}
