import { CraftbookEditor } from './CraftbookEditor.js';

interface CraftbookTabContentProps {
  craftbookId: string;
  source?: 'bundled' | 'local' | 'project';
  onChanged?: () => void;
}

/** Loader/wrapper around {@link CraftbookEditor} — the per-craftbook tab. */
export function CraftbookTabContent({ craftbookId, source, onChanged }: CraftbookTabContentProps) {
  return (
    <div className="craftbook-tab">
      <CraftbookEditor
        key={craftbookId}
        craftbookId={craftbookId}
        {...(source ? { source } : {})}
        {...(onChanged ? { onChanged } : {})}
      />
    </div>
  );
}
