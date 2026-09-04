import { KnowledgeCatalogManager } from './KnowledgeCatalogManager.js';

/**
 * Settings → Knowledge. The section heading and the one-paragraph
 * orientation live here; everything interactive is the manager, which is
 * built like the model downloaders so a catalog download reads exactly like
 * a model download.
 */
export function KnowledgeCatalogsCard() {
  return (
    <section style={{ marginBottom: '2rem' }} data-testid="knowledge-settings">
      <h3>Knowledge</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Knowledge catalogs are searchable, citable reference libraries — encyclopedias, manuals,
        your own notes — packaged as .gezk files. Installed catalogs appear in the Knowledge area
        and your gezellen can search them and cite their sources. Everything stays on this device.
      </p>
      <KnowledgeCatalogManager />
    </section>
  );
}
