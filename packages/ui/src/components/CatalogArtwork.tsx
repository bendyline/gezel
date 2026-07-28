import { type ReactNode, useState } from 'react';
import { useCatalogArtworkUrl } from './catalog-artwork-url.js';

/**
 * Renders catalog artwork without ever exposing the browser's native
 * broken-image placeholder. Callers provide the glyph/initial fallback that
 * belongs to their surface.
 *
 * `iconSvg` is intended for catalog SVG that has already been sanitized by
 * the service before it reaches the UI.
 *
 * `logoUrl` takes the raw value off `CatalogItemSummary` — including the
 * service's bearer-gated `/api/catalog/.../file/...` paths, which
 * `useCatalogArtworkUrl` swaps for an object URL because `<img>` cannot send
 * an Authorization header. Absolute and `data:` URLs pass through untouched.
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
  const artworkUrl = useCatalogArtworkUrl(logoUrl);

  if (iconSvg) {
    return (
      <span
        className={svgClassName}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: catalog SVGs are sanitized before delivery.
        dangerouslySetInnerHTML={{ __html: iconSvg }}
      />
    );
  }

  if (artworkUrl && failedLogoUrl !== artworkUrl) {
    return (
      <>
        {loadedLogoUrl !== artworkUrl && fallback}
        <img
          className={imageClassName}
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
