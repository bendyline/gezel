import { type ReactNode, useMemo, useState } from 'react';
import { safeSvgImageUrl } from '../safe-svg-image.js';
import { useCatalogArtworkUrl } from './catalog-artwork-url.js';

/**
 * Renders catalog artwork without ever exposing the browser's native
 * broken-image placeholder. Callers provide the glyph/initial fallback that
 * belongs to their surface.
 *
 * `iconSvg` is treated as untrusted here even if an upstream source already
 * sanitized it. It is structurally reduced and loaded as an isolated image,
 * never inserted as live DOM.
 *
 * `logoUrl` takes the raw value off `CatalogItemSummary` — including the
 * service's bearer-gated `/api/catalog/.../file/...` paths, which
 * `useCatalogArtworkUrl` swaps for an object URL because `<img>` cannot send
 * an Authorization header. In-memory `data:`/`blob:` URLs pass through;
 * remote URLs fall back instead of causing passive renderer egress.
 */
export function CatalogArtwork({
  iconSvg,
  logoUrl,
  svgClassName,
  imageClassName,
  fallback,
}: {
  iconSvg?: string;
  logoUrl?: string;
  svgClassName?: string;
  imageClassName?: string;
  fallback: ReactNode;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const [loadedLogoUrl, setLoadedLogoUrl] = useState<string | null>(null);
  const iconUrl = useMemo(() => safeSvgImageUrl(iconSvg), [iconSvg]);
  const artworkUrl = useCatalogArtworkUrl(iconUrl ?? logoUrl);
  const artworkClassName = iconUrl ? (svgClassName ?? imageClassName) : imageClassName;

  if (artworkUrl && failedLogoUrl !== artworkUrl) {
    return (
      <>
        {loadedLogoUrl !== artworkUrl && fallback}
        <img
          className={artworkClassName}
          src={artworkUrl}
          alt=""
          hidden={loadedLogoUrl !== artworkUrl}
          onLoad={() => setLoadedLogoUrl(artworkUrl)}
          onError={() => setFailedLogoUrl(artworkUrl)}
        />
      </>
    );
  }

  return fallback;
}
