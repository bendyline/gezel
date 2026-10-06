import { Dialog } from '../primitives/index.js';
import { KnowledgeCatalogManager } from './KnowledgeCatalogManager.js';

/**
 * Catalog management over the Knowledge browser. The browser's add key used to
 * leave for Settings → Knowledge, which pulled someone out of the library to
 * change what was on its shelves; the same manager opens here instead, and
 * installs land in the rail as they finish (the manager announces each one).
 * Settings → Knowledge keeps the manager too, for people who look there.
 */
export function KnowledgeCatalogsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content
          className="knowledge-catalogs-dialog"
          data-testid="knowledge-catalogs-dialog"
        >
          <Dialog.Title asChild>
            <h3>Knowledge catalogs</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Searchable, citable reference libraries — encyclopedias, manuals, your own notes. Your
            gezellen can search every enabled catalog and cite their sources. Everything stays on
            this device.
          </Dialog.Description>
          <div className="knowledge-catalogs-dialog-body">
            <KnowledgeCatalogManager />
          </div>
          <Dialog.Actions>
            <Dialog.Close asChild>
              <button type="button">Done</button>
            </Dialog.Close>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
