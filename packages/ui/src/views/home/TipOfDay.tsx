import { openAddFolder } from '../../components/AddFolderSheet.js';
import { TipOfDayPresentation } from './TipOfDayPresentation.js';
import type { HomeNavView } from './utils.js';
export function TipOfDay({ onNavigate }: { onNavigate?: (view: HomeNavView) => void }) {
  return (
    <TipOfDayPresentation
      onAction={(view) => (view === 'add-folder' ? openAddFolder() : onNavigate?.(view))}
    />
  );
}
