import type { KnowledgeCatalogStatus } from '@bendyline/gezel-client';
import handboekMarkUrl from '../assets/handboek-mark.webp';
import { CatalogArtwork } from './CatalogArtwork.js';

/**
 * A knowledge catalog's Reference Mark: the square artwork gilde ships beside
 * the catalog's manifest (a subject resting on a cloth-bound volume). The
 * bundled Handboek is not a gilde entry, so its mark ships with the UI. A
 * catalog without artwork (one you built yourself) shows a plain book glyph
 * on the same tile, never a broken image.
 */
export function KnowledgeCatalogMark({
  catalog,
  size,
}: {
  catalog: Pick<KnowledgeCatalogStatus, 'ref' | 'source' | 'logoUrl'>;
  size: 'sm' | 'md' | 'lg';
}) {
  const className = `knowledge-mark knowledge-mark--${size}`;
  if (catalog.source === 'bundled' && catalog.ref.catalogId === 'handboek') {
    return (
      <span className={className} aria-hidden="true">
        <img className="knowledge-mark-image" src={handboekMarkUrl} alt="" />
      </span>
    );
  }
  return (
    <span className={className} aria-hidden="true">
      <CatalogArtwork
        {...(catalog.logoUrl ? { logoUrl: catalog.logoUrl } : {})}
        imageClassName="knowledge-mark-image"
        fallback={
          <svg
            className="knowledge-mark-glyph"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            focusable="false"
            aria-hidden="true"
          >
            <path d="M5 4.5h11a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2z" />
            <path d="M5 17.5a2 2 0 0 1 2-2h11" />
            <path d="M9 8h5" />
          </svg>
        }
      />
    </span>
  );
}
