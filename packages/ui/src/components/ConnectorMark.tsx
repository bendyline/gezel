import { catalogGroundFor } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { ProjectGlyph, type ProjectGlyphId } from '../views/projects/new-project-meta.js';
import { CatalogArtwork, catalogMarkProps } from './CatalogArtwork.js';

/** The line glyph a connector type falls back to when its catalog entry has no mark. */
export function connectorGlyph(connector: {
  id: string;
  tags?: readonly string[];
}): ProjectGlyphId {
  const identity = `${connector.id} ${(connector.tags ?? []).join(' ')}`.toLowerCase();
  if (/(camera|webcam)/.test(identity)) return 'camera';
  if (identity.includes('wiki')) return 'sheet';
  if (identity.includes('calendar')) return 'calendar';
  if (/(mail|gmail|imap|email)/.test(identity)) return 'envelope';
  if (/(github|git)/.test(identity)) return 'branch';
  if (/(issue|linear)/.test(identity)) return 'bubbles';
  if (/(airtable|record|data)/.test(identity)) return 'chart';
  if (/(web|rss|feed)/.test(identity)) return 'globe';
  return 'dots';
}

export interface ConnectorTypeArt {
  name?: string;
  tags?: readonly string[];
  logoUrl?: string;
  iconSvg?: string;
}

/**
 * One listing of the connector catalog for every mark on screen: the composer
 * strip, message rows and the Connections tab all show the same few types.
 */
let listing: Promise<Map<string, ConnectorTypeArt>> | null = null;

function connectorTypeArt(): Promise<Map<string, ConnectorTypeArt>> {
  if (listing) return listing;
  const pending = api.listConnectorTypes().then((res) => {
    const byId = new Map<string, ConnectorTypeArt>();
    for (const item of res.items) {
      byId.set(item.manifest.id, {
        name: item.manifest.name,
        tags: item.manifest.tags ?? [],
        ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
        ...(item.iconSvg ? { iconSvg: item.iconSvg } : {}),
      });
    }
    return byId;
  });
  listing = pending;
  // A failed listing must not leave every later mark on its fallback glyph.
  pending.catch(() => {
    if (listing === pending) listing = null;
  });
  return pending;
}

/** Test seam: forget the cached listing. */
export function resetConnectorTypeArt(): void {
  listing = null;
}

/** A connector type's name and artwork from the catalog, or null until known. */
export function useConnectorTypeArt(
  connectorType: string | undefined,
  skip = false,
): ConnectorTypeArt | null {
  const [art, setArt] = useState<ConnectorTypeArt | null>(null);
  useEffect(() => {
    if (!connectorType || skip) return;
    let cancelled = false;
    connectorTypeArt()
      .then((byId) => {
        if (!cancelled) setArt(byId.get(connectorType) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connectorType, skip]);
  return skip ? null : art;
}

/**
 * A connector type's mark, in the caller's tile (`className`): its cut-paper
 * artwork on the ground its family takes (`catalogGroundFor`), or a line
 * glyph painted on that same ground where the catalog has no art, as project
 * types do. Pass the artwork when the caller already holds it (a catalog
 * card, a composer offer); otherwise it is looked up once and shared.
 */
export function ConnectorMark({
  connectorType,
  tags,
  logoUrl,
  iconSvg,
  size = 16,
  className,
  svgClassName,
}: {
  connectorType: string;
  tags?: readonly string[] | undefined;
  logoUrl?: string | undefined;
  iconSvg?: string | undefined;
  /** Size of the fallback glyph; the artwork fills the mark's box. */
  size?: number;
  /** The tile the mark sits in. */
  className: string;
  svgClassName?: string;
}) {
  const given = Boolean(logoUrl || iconSvg);
  const looked = useConnectorTypeArt(connectorType, given);
  const art: ConnectorTypeArt = given
    ? {
        ...(logoUrl ? { logoUrl } : {}),
        ...(iconSvg ? { iconSvg } : {}),
        ...(tags ? { tags } : {}),
      }
    : (looked ?? {});
  const marks = tags ?? art.tags ?? [];
  const ground = catalogGroundFor({ kind: 'connector-type', id: connectorType, tags: marks });
  return (
    <span
      className={className}
      aria-hidden="true"
      {...catalogMarkProps(ground, Boolean(art.iconSvg || art.logoUrl))}
    >
      <CatalogArtwork
        {...(art.iconSvg ? { iconSvg: art.iconSvg } : {})}
        {...(art.logoUrl ? { logoUrl: art.logoUrl } : {})}
        ground={ground}
        {...(svgClassName ? { svgClassName } : {})}
        fallback={
          <ProjectGlyph glyph={connectorGlyph({ id: connectorType, tags: marks })} size={size} />
        }
      />
    </span>
  );
}
