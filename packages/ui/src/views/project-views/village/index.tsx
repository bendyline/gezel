import type { ProjectViewProps } from '../types.js';
import { VillageView } from './VillageView.js';

/** The Village as a registered project view. */
export default function VillageProjectView({
  projectId,
  project,
  selectedPath,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  return (
    <VillageView
      projectId={projectId}
      hasGitHub={Boolean(project.github)}
      selectedPath={selectedPath}
      onSelectPath={onSelectPath}
      setInspectorExtras={setInspectorExtras}
    />
  );
}
