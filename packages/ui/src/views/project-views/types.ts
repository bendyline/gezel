import type { ProjectDetail, ProjectViewId } from '@bendyline/gezel';
import type { ComponentType, ReactNode } from 'react';
import type { SectionIconName } from '../../components/SectionIcon.js';
import type { FileInspectorConnection } from '../../components/file-inspector/FileInspector.js';

/**
 * What a view adds to the shared inspector for its selection: facts it
 * already holds (so the pane shows them before anything loads), chips only it
 * can say, and the files it knows are connected.
 */
export interface InspectorExtras {
  /** The file `known`, `chips` and `connections` describe; ignored for any other. */
  forPath?: string;
  known?: { label?: string; lang?: string | null; lines?: number; symbols?: number };
  chips?: ReactNode;
  connections?: readonly FileInspectorConnection[];
  /** A finding changed; refresh whatever the view draws from findings. */
  onFindingsChanged?: () => void;
  /** Bumped when the view rebuilt from a fresh index, so the pane forgets cached context. */
  revision?: number;
}

export interface ProjectViewProps {
  projectId: string;
  project: ProjectDetail;
  compact: boolean;
  selectedPath: string | null;
  /** Select a file (null clears); `line` asks the inspector to reveal it. */
  onSelectPath: (path: string | null, opts?: { line?: number }) => void;
  setInspectorExtras: (extras: InspectorExtras | null) => void;
}

export interface ProjectViewDefinition {
  id: ProjectViewId;
  /** The view's own name ("Village"); the tab reads "Village view". */
  label: string;
  /** One line under the name in the view menu. */
  hint: string;
  icon: SectionIconName;
  load: () => Promise<{ default: ComponentType<ProjectViewProps> }>;
}
