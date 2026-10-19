import type { CatalogGroundTone } from '@bendyline/gezel';
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
 *
 * `ground` is the category paper (`catalogGroundFor`) painted behind a logo:
 * craftbook and project-type marks are transparent cut-outs, so the ground
 * shows through them, while an older opaque mark simply covers it. It sits on
 * the image itself, so the caller's size, radius and clipping still apply.
 */
export function CatalogArtwork({
  iconSvg,
  logoUrl,
  ground,
  svgClassName,
  imageClassName,
  fallback,
  onImageLoad,
}: {
  iconSvg?: string;
  logoUrl?: string;
  ground?: CatalogGroundTone | undefined;
  svgClassName?: string;
  imageClassName?: string;
  fallback: ReactNode;
  onImageLoad?: (image: HTMLImageElement) => void;
}) {
  const [failedLogoUrl, setFailedLogoUrl] = useState<string | null>(null);
  const [loadedLogoUrl, setLoadedLogoUrl] = useState<string | null>(null);
  const iconUrl = useMemo(() => safeSvgImageUrl(iconSvg), [iconSvg]);
  const artworkUrl = useCatalogArtworkUrl(iconUrl ?? logoUrl);
  const artworkClassName = iconUrl ? (svgClassName ?? imageClassName) : imageClassName;
  const groundTone = iconUrl ? undefined : ground;

  if (artworkUrl && failedLogoUrl !== artworkUrl) {
    return (
      <>
        {loadedLogoUrl !== artworkUrl && fallback}
        <img
          className={artworkClassName}
          src={artworkUrl}
          alt=""
          data-ground={groundTone}
          style={groundTone ? { backgroundColor: `var(--gezel-ground-${groundTone})` } : undefined}
          hidden={loadedLogoUrl !== artworkUrl}
          onLoad={(event) => {
            setLoadedLogoUrl(artworkUrl);
            onImageLoad?.(event.currentTarget);
          }}
          onError={() => setFailedLogoUrl(artworkUrl)}
        />
      </>
    );
  }

  return fallback;
}
